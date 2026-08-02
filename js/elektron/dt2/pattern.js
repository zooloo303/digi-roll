// Digitakt II pattern + kit dump decoding.
//
// Struct offsets come from elk-herd's Elektron/Digitakt/{Dump,CppStructs}.elm
// (BSD-2-Clause, © mzero) for the pattern/track/kit skeleton, plus our own
// reverse engineering for the note-trig data, which elk-herd never decodes.
// The trig-record pool semantics were confirmed 2026-08-01 by a controlled
// hardware experiment (known note/velocity/length/micro edits on a throwaway
// project, then diffed) — the full story is in docs/dt2-pattern-format.md.
// Decode only; the write path is a later Phase 2 step.

// Pattern struct versions this decoder understands. Versions 3 and 4 share
// every pattern-level offset (they differ only inside the kit); version 0
// (early DT2 OS) has a different track layout we've never seen in the wild,
// so it is refused rather than guessed at.
const PATTERN = {
  size: 89088,            // patternStorage_sizeof (v3/v4)
  tracksOffset: 4,        // after the uint32be struct version
  numTracks: 16,
  trigPool: 18948,        // pool of 6-byte trig records, fills up to pLocksIndex
  trigPoolRecords: 8192,  // 16 tracks × 128 steps × 4 note slots
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
  // 256..1023: six 128-byte per-step arrays of unknown purpose (0xFF-filled;
  // hardware-verified NOT to hold note/velocity/length/micro — those live in
  // the pattern-level trig-record pool)
  soundPLocks: 1024,      // trackStorage_soundSlotLocks, 0xFF = none
  defaults: 1152,         // tail record: default note, velocity, length, …
  lengthSteps: 1164,      // uint16be inside the tail: track length in steps
};

// A trig record in the pattern-level pool: {track, step, note, vel, len,
// micro}, six bytes. Each trig the box ever creates allocates four
// consecutive records — one per note slot (chords on MIDI tracks); velocity,
// length and micro are mirrored across all four, the note only fills slots
// it uses. 0xFF note/vel/len = "track default"; micro's resting value is 0
// (signed byte, ticks of 1/24 step). All-0xFF records are free pool space,
// and records of deleted trigs linger — only steps whose trig bit is set in
// the track's step words count.
const TRIG_NOTE_SLOTS = 4;

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

// Signed micro-timing byte → offset in steps. Ticks are 1/24 of a step
// (the box displays n/384 of a bar); a left-nudge produced 0xFE = −2.
function microByteToSteps(v) {
  return ((v << 24) >> 24) / 24;
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
    tracks.push({
      steps: Array.from({ length: TRACK.numSteps }, (_, s) => u16(payload, base + TRACK.steps + s * 2)),
      soundPLocks: payload.subarray(base + TRACK.soundPLocks, base + TRACK.soundPLocks + TRACK.numSteps),
      defaultNote: payload[base + TRACK.defaults],
      defaultVelocity: payload[base + TRACK.defaults + 1],
      defaultLength: payload[base + TRACK.defaults + 2],
      lengthSteps: u16(payload, base + TRACK.lengthSteps),
      trigs: new Map(), // step → the trig's four note-slot records, filled below
    });
  }

  // Walk the trig-record pool. Records are appended as trigs are created, so
  // on the rare chance a (track, step) pair appears twice (delete + re-add),
  // the later quad wins.
  for (let r = 0; r < PATTERN.trigPoolRecords; r += TRIG_NOTE_SLOTS) {
    const o = PATTERN.trigPool + r * 6;
    const [track, step] = [payload[o], payload[o + 1]];
    if (track >= PATTERN.numTracks || step >= TRACK.numSteps) continue; // free/foreign
    const slots = [];
    for (let n = 0; n < TRIG_NOTE_SLOTS; n++) {
      const s = o + n * 6;
      slots.push({ note: payload[s + 2], velocity: payload[s + 3], length: payload[s + 4], micro: payload[s + 5] });
    }
    tracks[track].trigs.set(step, slots);
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
// length in steps, micro offset as a fraction of a step. 0xFF record bytes
// fall back to the track defaults, exactly as the box does. A trig whose
// extra note slots are filled (chords, MIDI tracks) yields several notes.
export function trackNotes(patternKit, trackIndex) {
  const track = patternKit.tracks[trackIndex];
  const notes = [];
  for (let s = 0; s < track.steps.length; s++) {
    if (!(track.steps[s] & TRIG_ENABLED)) continue;
    const slots = track.trigs.get(s);
    const first = slots?.[0];
    const velocity = (first == null || first.velocity === 0xff ? track.defaultVelocity : first.velocity) & 0x7f;
    const lenByte = first == null || first.length === 0xff ? track.defaultLength : first.length;
    const lenSteps = lengthByteToSteps(lenByte);
    const micro = first ? microByteToSteps(first.micro) : 0;
    // Every filled note slot is a note; a trig with no slot data (or all
    // slots at 0xFF) plays the track's default note.
    const pitches = (slots ?? []).filter(sl => sl.note !== 0xff).map(sl => sl.note & 0x7f);
    if (!pitches.length) pitches.push(track.defaultNote & 0x7f);
    for (const pitch of pitches) {
      notes.push({
        step: s,
        pitch,
        velocity,
        lenSteps: isFinite(lenSteps) ? lenSteps : track.lengthSteps,
        micro,
      });
    }
  }
  return notes;
}

export function trackTrigCount(patternKit, trackIndex) {
  return patternKit.tracks[trackIndex].steps.filter(w => w & TRIG_ENABLED).length;
}

// --- Write path ---------------------------------------------------------------

// Bits the box sets on every trig it creates: enable (0x0001) plus the 0x0380
// flag group. We mirror the box exactly and never touch any other bit.
const TRIG_SET_HI = 0x03, TRIG_SET_LO = 0x81;

// Replace track `trackIndex`'s note trigs inside a fetched pattern-kit payload
// with digi-roll notes ({step, pitch, velocity, len (steps), micro (fraction
// of a step)}). Returns { payload, dropped } where payload is a new
// Uint8Array and dropped counts notes that couldn't be represented (step
// outside 0–127, or more than four pitches on one step). Every byte outside
// the track's step words and the trig-record pool is byte-identical — the
// read-modify-write contract the verify layer checks.
export function encodeTrackNotes(payload, trackIndex, notes) {
  const version = u32(payload, 0);
  if (version !== 3 && version !== 4) {
    throw new Error(`unsupported DT2 pattern struct version ${version} — refusing to write`);
  }
  if (trackIndex < 0 || trackIndex >= PATTERN.numTracks) throw new Error(`no track ${trackIndex}`);

  const out = Uint8Array.from(payload);
  const base = PATTERN.tracksOffset + trackIndex * TRACK.size;

  // Clear the track's trig-enable bits. Other step-word bits stay — deleting
  // a trig on the box leaves its flag bits behind too.
  for (let s = 0; s < TRACK.numSteps; s++) out[base + s * 2 + 1] &= ~TRIG_ENABLED;

  // Free every record quad belonging to this track (including quads lingering
  // from long-deleted trigs — the box only reads quads for enabled steps).
  const QUAD = 6 * TRIG_NOTE_SLOTS;
  for (let o = PATTERN.trigPool; o < PATTERN.pLocksIndex; o += QUAD) {
    if (out[o] === trackIndex) out.fill(0xff, o, o + QUAD);
  }

  // Group notes by step, at most four pitches per step (the four note slots).
  const byStep = new Map();
  let dropped = 0;
  for (const n of [...notes].sort((a, b) => a.step - b.step || a.pitch - b.pitch)) {
    if (!Number.isInteger(n.step) || n.step < 0 || n.step >= TRACK.numSteps) { dropped++; continue; }
    const group = byStep.get(n.step) ?? [];
    if (group.length >= TRIG_NOTE_SLOTS) { dropped++; continue; }
    group.push(n);
    byStep.set(n.step, group);
  }

  // Write one quad per trigged step into free pool space. Velocity, length
  // and micro-timing are mirrored across all four slots, exactly as the box
  // stores them; chord slots beyond the first carry only their note.
  let nextQuad = PATTERN.trigPool;
  const freeQuad = () => {
    for (; nextQuad < PATTERN.pLocksIndex; nextQuad += QUAD) {
      let free = true;
      for (let i = 0; i < QUAD; i++) if (out[nextQuad + i] !== 0xff) { free = false; break; }
      if (free) return nextQuad;
    }
    throw new Error('pattern trig storage is full — too many trigs across all tracks');
  };
  for (const [step, group] of byStep) {
    const o = freeQuad();
    nextQuad += QUAD;
    const first = group[0];
    const vel = first.velocity & 0x7f;
    const len = stepsToLengthByte(first.len);
    const micro = Math.max(-23, Math.min(23, Math.round((first.micro ?? 0) * 24))) & 0xff;
    for (let slot = 0; slot < TRIG_NOTE_SLOTS; slot++) {
      const s = o + slot * 6;
      out[s] = trackIndex;
      out[s + 1] = step;
      out[s + 2] = group[slot] ? group[slot].pitch & 0x7f : 0xff;
      out[s + 3] = vel;
      out[s + 4] = len;
      out[s + 5] = micro;
    }
    out[base + step * 2] |= TRIG_SET_HI;
    out[base + step * 2 + 1] |= TRIG_SET_LO;
  }

  return { payload: out, dropped };
}

// Byte-diff two payloads for the verify layer. Returns up to `cap` differing
// offsets with both values — empty means byte-identical.
export function diffPayloads(a, b, cap = 64) {
  const diffs = [];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len && diffs.length < cap; i++) {
    if (a[i] !== b[i]) diffs.push({ offset: i, sent: a[i], read: b[i] });
  }
  if (a.length !== b.length) diffs.push({ offset: len, sent: a.length, read: b.length, lengthMismatch: true });
  return diffs;
}
