// Shared pattern + kit dump decoding/encoding for the Digitakt II family.
//
// The DT2 and DN2 are sibling boxes on the same OS generation, and their
// pattern structs turned out to be near-identical: same regions in the same
// order, differing only in a handful of sizes and offsets. Each device module
// (dt2/pattern.js, dn2/pattern.js) supplies a spec of those numbers and
// re-exports this core bound to it.
//
// Struct knowledge comes from elk-herd's Elektron/Digitakt/{Dump,CppStructs}.elm
// (BSD-2-Clause, © mzero) for the DT2 pattern/track/kit skeleton, plus our own
// reverse engineering: the note-trig record pool (docs/dt2-pattern-format.md,
// hardware-verified) and the entire DN2 mapping (docs/dn2-pattern-format.md,
// derived by diffing real DN2 dumps against the DT2 layout).

const TRIG_ENABLED = 0x0001;

// Bits the box sets on every trig it creates: enable (0x0001) plus the 0x0380
// flag group — identical on DT2 and DN2. We mirror the box exactly and never
// touch any other bit.
const TRIG_SET_HI = 0x03, TRIG_SET_LO = 0x81;

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
// note_lengths table, which the DT2 fixture's default (0x0E = one step) matches.
export function lengthByteToSteps(v) {
  if (v >= 127) return Infinity;
  if (v < 14) return 0.125 + v * 0.0625;
  const octave = Math.floor((v - 14) / 16);        // 14..29 → 0, 30..45 → 1, …
  const base = 2 ** octave;                        // in steps
  return base + (v - 14 - octave * 16) * (base / 16);
}

// Nearest length byte for a step count (for the write path).
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

// Decode one pattern-kit dump payload (a type 0x50 message body) using a
// device spec. Returns plain data; throws on struct versions the spec doesn't
// vouch for.
export function decodePatternKit(spec, payload) {
  const { pattern: P, track: T } = spec;
  if (payload.length < P.size + 8) {
    throw new Error(`pattern-kit payload too short (${payload.length} bytes)`);
  }
  const version = u32(payload, 0);
  if (!spec.patternVersions.includes(version)) {
    throw new Error(`unsupported ${spec.device} pattern struct version ${version} — needs a digi-roll update`);
  }

  const tracks = [];
  for (let t = 0; t < P.numTracks; t++) {
    const base = P.tracksOffset + t * T.size;
    tracks.push({
      steps: Array.from({ length: T.numSteps }, (_, s) => u16(payload, base + T.steps + s * 2)),
      soundPLocks: payload.subarray(base + T.soundPLocks, base + T.soundPLocks + T.numSteps),
      defaultNote: payload[base + T.defaults],
      defaultVelocity: payload[base + T.defaults + 1],
      defaultLength: payload[base + T.defaults + 2],
      lengthSteps: u16(payload, base + T.lengthSteps),
      trigs: new Map(), // step → the trig's note-slot records, filled below
    });
  }

  // Walk the trig-record pool. Records are appended as trigs are created, so
  // on the rare chance a (track, step) pair appears twice (delete + re-add),
  // the later group wins.
  const slotsPer = spec.noteSlotsPerTrig;
  for (let r = 0; r < P.trigPoolRecords; r += slotsPer) {
    const o = P.trigPool + r * 6;
    const [track, step] = [payload[o], payload[o + 1]];
    if (track >= P.numTracks || step >= T.numSteps) continue; // free/foreign
    const slots = [];
    for (let n = 0; n < slotsPer; n++) {
      const s = o + n * 6;
      slots.push({ note: payload[s + 2], velocity: payload[s + 3], length: payload[s + 4], micro: payload[s + 5] });
    }
    tracks[track].trigs.set(step, slots);
  }

  const kitBase = P.size;
  if (u32(payload, kitBase) !== 0xbeefbace) {
    throw new Error('kit magic 0xBEEFBACE not found where expected — struct drift?');
  }
  const kitVersion = u32(payload, kitBase + 4);
  const kit = spec.kits[kitVersion];
  if (!kit) throw new Error(`unsupported ${spec.device} kit struct version ${kitVersion}`);

  return {
    version,
    name: chars16(payload, P.nameOffset),
    tempoBpm: u32(payload, P.tempoOffset) / 120,
    kitIndex: payload[P.kitIndexOffset],
    tracks,
    kit: {
      version: kitVersion,
      name: chars16(payload, kitBase + 8),
      soundNames: Array.from({ length: P.numTracks }, (_, t) =>
        chars16(payload, kitBase + kit.soundsOffset + t * kit.soundSize + 12)),
      // Bit t set = track t is a MIDI track. Devices whose mask location is
      // still unmapped (DN2) report 0 — callers fall back to sound names.
      midiMask: kit.midiMaskOffset == null ? 0 : u16(payload, kitBase + kit.midiMaskOffset),
    },
  };
}

// Notes on one decoded track, in digi-roll terms: step, MIDI pitch, velocity,
// length in steps, micro offset as a fraction of a step. 0xFF record bytes
// fall back to the track defaults, exactly as the box does. A trig whose
// extra note slots are filled (chords) yields several notes.
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

// Replace track `trackIndex`'s note trigs inside a fetched pattern-kit payload
// with digi-roll notes ({step, pitch, velocity, len (steps), micro (fraction
// of a step)}). Returns { payload, dropped } where payload is a new
// Uint8Array and dropped counts notes that couldn't be represented (step
// outside 0–127, or more pitches on one step than the device has note slots).
// Every byte outside the track's step words and the trig-record pool is
// byte-identical — the read-modify-write contract the verify layer checks.
export function encodeTrackNotes(spec, payload, trackIndex, notes) {
  const { pattern: P, track: T } = spec;
  const version = u32(payload, 0);
  if (!spec.patternVersions.includes(version)) {
    throw new Error(`unsupported ${spec.device} pattern struct version ${version} — refusing to write`);
  }
  if (trackIndex < 0 || trackIndex >= P.numTracks) throw new Error(`no track ${trackIndex}`);

  const out = Uint8Array.from(payload);
  const base = P.tracksOffset + trackIndex * T.size;

  // Clear the track's trig-enable bits. Other step-word bits stay — deleting
  // a trig on the box leaves its flag bits behind too.
  for (let s = 0; s < T.numSteps; s++) out[base + s * 2 + 1] &= ~TRIG_ENABLED;

  // Free every record group belonging to this track (including groups
  // lingering from long-deleted trigs — the box only reads records for
  // enabled steps).
  const GROUP = 6 * spec.noteSlotsPerTrig;
  for (let o = P.trigPool; o < P.pLocksIndex; o += GROUP) {
    if (out[o] === trackIndex) out.fill(0xff, o, o + GROUP);
  }

  // Group notes by step, at most one pitch per note slot.
  const byStep = new Map();
  let dropped = 0;
  for (const n of [...notes].sort((a, b) => a.step - b.step || a.pitch - b.pitch)) {
    if (!Number.isInteger(n.step) || n.step < 0 || n.step >= T.numSteps) { dropped++; continue; }
    const group = byStep.get(n.step) ?? [];
    if (group.length >= spec.noteSlotsPerTrig) { dropped++; continue; }
    group.push(n);
    byStep.set(n.step, group);
  }

  // Write one record group per trigged step into free pool space. Velocity,
  // length and micro-timing are mirrored across all slots, exactly as the box
  // stores them; chord slots beyond the first carry only their note.
  let nextGroup = P.trigPool;
  const freeGroup = () => {
    for (; nextGroup < P.pLocksIndex; nextGroup += GROUP) {
      let free = true;
      for (let i = 0; i < GROUP; i++) if (out[nextGroup + i] !== 0xff) { free = false; break; }
      if (free) return nextGroup;
    }
    throw new Error('pattern trig storage is full — too many trigs across all tracks');
  };
  for (const [step, group] of byStep) {
    const o = freeGroup();
    nextGroup += GROUP;
    const first = group[0];
    const vel = first.velocity & 0x7f;
    const len = stepsToLengthByte(first.len);
    const micro = Math.max(-23, Math.min(23, Math.round((first.micro ?? 0) * 24))) & 0xff;
    for (let slot = 0; slot < spec.noteSlotsPerTrig; slot++) {
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

// Group the differing offsets of two payloads into contiguous ranges, each
// annotated by `describe` (falling back to raw offsets). Adjacent changed
// bytes merge only while their region label matches, so one range never
// spans two struct regions. The diff lab renders these directly.
export function diffAnnotatedRanges(a, b, describe) {
  const ranges = [];
  let cur = null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) { cur = null; continue; }
    const label = describe ? describe(i) : `offset ${i}`;
    if (cur && i === cur.end + 1 && label === cur.label) { cur.end = i; continue; }
    cur = { start: i, end: i, label };
    ranges.push(cur);
  }
  return ranges;
}

// Human annotation for a pattern-kit payload offset — the diff lab's map from
// "byte 19003 changed" to "pool record #1, note". Everything the spec knows
// gets a name; anything else is labelled unknown so unexplained diffs stand
// out instead of hiding.
const POOL_FIELDS = ['track', 'step', 'note', 'velocity', 'length', 'micro'];

export function describeOffset(spec, offset) {
  const { pattern: P, track: T } = spec;
  if (offset < P.tracksOffset) return 'pattern struct version';
  if (offset < P.trigPool) {
    const t = Math.floor((offset - P.tracksOffset) / T.size);
    const rel = (offset - P.tracksOffset) % T.size;
    if (rel < T.numSteps * 2) {
      return `track ${t + 1} step word, step ${Math.floor(rel / 2) + 1} (${rel % 2 ? 'lo' : 'hi'} byte)`;
    }
    if (rel < T.soundPLocks) return `track ${t + 1} unknown per-step array ${Math.floor((rel - 256) / 128) + 1}, step ${(rel - 256) % 128 + 1}`;
    if (rel < T.defaults) return `track ${t + 1} sound p-lock, step ${rel - T.soundPLocks + 1}`;
    const d = rel - T.defaults;
    const named = { 0: 'default note', 1: 'default velocity', 2: 'default length' }[d]
      ?? (d === T.lengthSteps - T.defaults || d === T.lengthSteps - T.defaults + 1 ? 'track length (u16)' : `+${d}`);
    return `track ${t + 1} defaults, ${named}`;
  }
  if (offset < P.pLocksIndex) {
    const rec = Math.floor((offset - P.trigPool) / 6);
    return `trig-record pool, record #${rec}, ${POOL_FIELDS[(offset - P.trigPool) % 6]}`;
  }
  if (offset < P.nameOffset) {
    const lane = Math.floor((offset - P.pLocksIndex) / P.pLockSize);
    const rel = (offset - P.pLocksIndex) % P.pLockSize;
    const part = rel === 0 ? 'paramId' : rel === 1 ? 'track' : `step ${Math.floor((rel - 2) / 2) + 1} value (${rel % 2 ? 'hi' : 'lo'} byte)`;
    return `p-lock lane ${lane}, ${part}`;
  }
  if (offset < P.nameOffset + 16) return 'pattern name';
  if (offset < P.tempoOffset + 4) return 'pattern tempo (u32, BPM × 120)';
  if (offset === P.kitIndexOffset) return 'kit index';
  if (offset < P.size) return `pattern settings tail +${offset - P.nameOffset - 16}`;
  return `kit +${offset - P.size}`;
}
