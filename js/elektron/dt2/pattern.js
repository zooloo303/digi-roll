// Digitakt II pattern + kit dump decoding.
//
// Struct offsets come from three sources, cross-checked against a real DT2
// project dump (OS 1.15B, pattern struct version 4):
//   - elk-herd's Elektron/Digitakt/{Dump,CppStructs}.elm (BSD-2-Clause, © mzero)
//     for the pattern/track/kit skeleton and version-gated offsets;
//   - libanalogrytm's pattern.h (© bsp) for the Elektron per-step array family
//     layout (notes/velocities/lengths/micro as parallel 0xFF-defaulted arrays);
//   - our own fixture analysis for everything neither of them decodes.
// Field-by-field provenance lives in docs/dt2-pattern-format.md — fields marked
// PROVISIONAL there have not yet been verified against controlled hardware
// captures. Decode only; the write path is a later Phase 2 step.

// Pattern struct versions this decoder understands. Versions 3 and 4 share
// every pattern-level offset (they differ only inside the kit); version 0
// (early DT2 OS) has a different track layout we've never seen in the wild,
// so it is refused rather than guessed at.
const PATTERN = {
  size: 89088,            // patternStorage_sizeof (v3/v4)
  tracksOffset: 4,        // after the uint32be struct version
  numTracks: 16,
  pLocksIndex: 68100,     // patternStorage_pLocksIndex
  numPLocks: 80,
  pLockSize: 2 + 128 * 2, // paramId, track, then a uint16be per step
  nameOffset: 88740,      // 16 chars, right after the pLocks
  tempoOffset: 88756,     // uint32be, BPM × 120 (14400 = the 120 BPM default)
  kitIndexOffset: 88768,  // patternStorage_kitIndex
};

const TRACK = {
  size: 1184,             // trackStorage_sizeof (track struct v2)
  numSteps: 128,
  steps: 0,               // uint16be per step; bit 0 = trig enabled
  micro: 256,             // per-step signed 6-bit micro-timing, 0xFF = none
  notes: 384,             // PROVISIONAL — per-step MIDI note, 0xFF = track default
  velocities: 512,        // PROVISIONAL — per-step velocity, 0xFF = track default
  lengths: 640,           // PROVISIONAL — per-step length byte, 0xFF = track default
  soundPLocks: 1024,      // trackStorage_soundSlotLocks, 0xFF = none
  defaults: 1152,         // tail record: default note, velocity, length, …
  lengthSteps: 1164,      // uint16be inside the tail: track length in steps
};

// Kit offsets by kit struct version (the kit follows the pattern in a
// pattern-kit payload and begins with magic 0xBEEFBACE).
const KIT = {
  3: { size: 10240, soundsOffset: 60, soundSize: 341, midiMaskOffset: 9972 },
  4: { size: 22528, soundsOffset: 60, soundSize: 1109, midiMaskOffset: 22260 },
};
const KIT_NAME_OFFSET = 8;     // after magic + version
const SOUND_NAME_OFFSET = 12;  // after magic + version + tagMask

const TRIG_ENABLED = 0x0001;

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);

function chars16(bytes, offset) {
  let end = offset;
  while (end < offset + 16 && bytes[end]) end++;
  return String.fromCharCode(...bytes.subarray(offset, end));
}

// Elektron length byte → length in steps (16ths). The scale is piecewise
// linear, doubling every 16 values: 0 = 0.125, 14 = 1 step, 30 = 2, 46 = 4,
// 62 = 8, 78 = 16, …, 126 = 128; 127 = infinite. Verbatim from libanalogrytm's
// note_lengths table, which this fixture's default (0x0E = one step) matches.
export function lengthByteToSteps(v) {
  if (v >= 127) return Infinity;
  if (v < 14) return 0.125 + v * 0.0625;
  const octave = Math.floor((v - 14) / 16);        // 14..29 → 0, 30..45 → 1, …
  const base = 2 ** octave;                        // in steps
  return base + (v - 14 - octave * 16) * (base / 16);
}

// Nearest length byte for a step count (for the write path later).
export function stepsToLengthByte(steps) {
  if (!isFinite(steps)) return 127;
  let best = 0, bestErr = Infinity;
  for (let v = 0; v <= 126; v++) {
    const err = Math.abs(lengthByteToSteps(v) - steps);
    if (err < bestErr) { best = v; bestErr = err; }
  }
  return best;
}

// Signed 6-bit micro-timing byte → offset in steps (−23/24 … +23/24).
// 0xFF (and any byte on a trig that was never nudged) means "on the grid".
function microByteToSteps(v) {
  if (v === 0xff) return 0;
  const six = v & 0x3f;
  return (six >= 32 ? six - 64 : six) / 24;
}

export function bankName(index) {
  return `${'ABCDEFGH'[index >> 4]}${String(index % 16 + 1).padStart(2, '0')}`;
}

// Decode one pattern-kit dump payload (a type 0x50 message body).
// Returns plain data; throws on struct versions we can't decode safely.
export function decodePatternKit(payload) {
  if (payload.length < PATTERN.size + 8) {
    throw new Error(`pattern-kit payload too short (${payload.length} bytes)`);
  }
  const version = u32(payload, 0);
  if (version !== 3 && version !== 4) {
    throw new Error(`unsupported DT2 pattern struct version ${version} — needs a digi-roll update`);
  }

  const tracks = [];
  for (let t = 0; t < PATTERN.numTracks; t++) {
    const base = PATTERN.tracksOffset + t * TRACK.size;
    const at = off => payload.subarray(base + off, base + off + TRACK.numSteps);
    tracks.push({
      steps: Array.from({ length: TRACK.numSteps }, (_, s) => u16(payload, base + TRACK.steps + s * 2)),
      micro: at(TRACK.micro),
      notes: at(TRACK.notes),
      velocities: at(TRACK.velocities),
      lengths: at(TRACK.lengths),
      soundPLocks: at(TRACK.soundPLocks),
      defaultNote: payload[base + TRACK.defaults],
      defaultVelocity: payload[base + TRACK.defaults + 1],
      defaultLength: payload[base + TRACK.defaults + 2],
      lengthSteps: u16(payload, base + TRACK.lengthSteps),
    });
  }

  const kitBase = PATTERN.size;
  if (u32(payload, kitBase) !== 0xbeefbace) {
    throw new Error('kit magic 0xBEEFBACE not found where expected — struct drift?');
  }
  const kitVersion = u32(payload, kitBase + 4);
  const kit = KIT[kitVersion];
  if (!kit) throw new Error(`unsupported DT2 kit struct version ${kitVersion}`);

  return {
    version,
    name: chars16(payload, PATTERN.nameOffset),
    tempoBpm: u32(payload, PATTERN.tempoOffset) / 120,
    kitIndex: payload[PATTERN.kitIndexOffset],
    tracks,
    kit: {
      version: kitVersion,
      name: chars16(payload, kitBase + KIT_NAME_OFFSET),
      soundNames: Array.from({ length: PATTERN.numTracks }, (_, t) =>
        chars16(payload, kitBase + kit.soundsOffset + t * kit.soundSize + SOUND_NAME_OFFSET)),
      // Bit t set = track t is a MIDI track, not a sample track.
      midiMask: u16(payload, kitBase + kit.midiMaskOffset),
    },
  };
}

// Notes on one decoded track, in digi-roll terms: step, MIDI pitch, velocity,
// length in steps, micro offset as a fraction of a step. 0xFF per-step bytes
// fall back to the track defaults, exactly as the box does.
export function trackNotes(patternKit, trackIndex) {
  const track = patternKit.tracks[trackIndex];
  const notes = [];
  let provisionalBytes = 0;
  for (let s = 0; s < track.steps.length; s++) {
    if (!(track.steps[s] & TRIG_ENABLED)) continue;
    const note = track.notes[s];
    const vel = track.velocities[s];
    const len = track.lengths[s];
    if (note !== 0xff || vel !== 0xff || len !== 0xff) provisionalBytes++;
    const lenSteps = lengthByteToSteps(len === 0xff ? track.defaultLength : len);
    notes.push({
      step: s,
      pitch: (note === 0xff ? track.defaultNote : note) & 0x7f,
      velocity: (vel === 0xff ? track.defaultVelocity : vel) & 0x7f,
      lenSteps: isFinite(lenSteps) ? lenSteps : track.lengthSteps,
      micro: microByteToSteps(track.micro[s]),
    });
  }
  // How many notes relied on the PROVISIONAL note/velocity/length arrays —
  // callers can warn until the layout is hardware-verified.
  notes.provisional = provisionalBytes;
  return notes;
}

export function trackTrigCount(patternKit, trackIndex) {
  return patternKit.tracks[trackIndex].steps.filter(w => w & TRIG_ENABLED).length;
}
