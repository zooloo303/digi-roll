// Digitone 1 pattern + kit dump decoding/encoding.
//
// Unlike the DT2/DN2 pair, the DN1 is NOT bound to ../pattern-core.js's shared
// decodePatternKit/encodeTrackNotes. Two structural differences make that core
// the wrong fit rather than a device to parametrize:
//
//   * There is no shared trig-record pool. Every step's note, velocity,
//     length, micro and trig-condition byte lives inline in the track record,
//     at a fixed offset for that step — nothing to pool or allocate.
//   * The kit record carries no `BEEFBACE` magic of its own (it opens straight
//     on its version field), which is the byte `decodePatternKit` asserts on
//     to find the kit boundary.
//
// What *is* shared and reused from pattern-core.js, because the underlying
// law is the same, verified against real DN1 captures in this session
// (2026-08-13, dn1-support-plan.md §1): the length-byte scale
// (lengthByteToSteps/stepsToLengthByte), the micro-timing scale (±23 ticks =
// ±1 step / 24), and bankName. The p-lock pool (js/elektron/plocks.js) and
// pattern-level swing (js/elektron/pattern-settings.js) also apply unchanged —
// they are already generic over `spec.pattern`/`spec.track`, not DT2/DN2-
// specific — so this module supplies the numbers and nothing else needs
// editing there. Swing's byte position is a strong candidate, not a hardware
// fact yet; see the `nameOffset` comment below.
//
// Struct offsets are DNX's (github.com — sibling project, this repo's byte-
// level source for the DN1): src/project/dn1.ts, reverse-engineered from 53
// real `.dnprj` project files (docs/dn1-project-format.md). Cross-checked in
// this session against five real DN1 SysEx pattern-kit captures — see
// dumps/fixtures/digitone1-presets-*.syx and dn1-support-plan.md §1 for what
// was independently confirmed on wire bytes rather than taken on trust.
//
// What this module does NOT yet do, on purpose:
//
//   * Trig conditions (COND/FILL/PROB combined into one byte on the DN1,
//     unlike the DT2/DN2's three separate lanes) are read and left alone on
//     write, but not decoded into meaning — the byte-to-condition table needs
//     a capture-pair session on real hardware (Phase 0, dn1-support-plan.md
//     §3) and guessing it would write the wrong condition.
//   * Sound locks (per-step, into the 128-slot project pool) are read-only
//     exposure with no roll-side concept, exactly like DT2/DN2's soundPLocks
//     lane — never touched by encodeTrackNotes.
//   * Trigless lock trigs (bit 0x0002, a step with parameter locks but no
//     note) are passed through untouched, never synthesised or edited.

import { lengthByteToSteps, stepsToLengthByte, bankName, diffPayloads } from '../pattern-core.js';

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
const writeU32 = (b, o, v) => { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; };

function chars16(bytes, offset) {
  let end = offset;
  while (end < offset + 16 && bytes[end]) end++;
  return String.fromCharCode(...bytes.subarray(offset, end));
}

export const SPEC = {
  device: 'DN1',
  patternVersions: [10],  // the record-version u32be DNX found in all 6,784 corpus patterns
  pattern: {
    size: 18432,           // pattern record only; the kit record follows at this offset
    tracksOffset: 4,
    numTracks: 8,          // 0-3 synth (T1-T4), 4-7 MIDI (A-D) — positional, no mode flag
    midiTracksFrom: 4,
    pLocksIndex: 0x1e84,   // 7812 — the parameter-lock pool, same design as DT2/DN2
    numPLocks: 80,
    pLockSize: 2 + 64 * 2, // header + one uint16be per step (64 steps, not 128)
    nameOffset: 0x4724,    // 18212
    tempoOffset: 0x4736,   // uint16be, BPM × 120 (DT2/DN2 use a uint32be here — DN1 doesn't)
    slotIndexOffset: 0x4741, // the pattern's own belief about its slot; usually equals the
                              // dump's index, except ~6% copy-pasted patterns (DNX corpus)
  },
  track: {
    size: 976,
    numSteps: 64,
    flags: 0x000,          // 32 × u32be; step 2n in the high u16, step 2n+1 in the low u16
    velocity: 0x080,       // 64 × u8, 0xFF = inherit from the track default
    noteLength: 0x0c0,     // 64 × u8, 0xFF = inherit
    micro: 0x100,          // 64 × i8, 0 = none — same ±23 scale as DT2/DN2
    trigCondition: 0x140,  // 64 × u8 — one combined menu; NOT decoded yet, see module header
    notes: 0x180,          // 64 × 8 bytes: root note (0xFF = none) + 7 signed chord offsets
    soundLock: 0x380,      // 64 × u8, index into the 128-slot project sound pool, 0xFF = none
    settings: 0x3c0,       // 16-byte tail
    defaultNote: 0x3c2,    // settings +2
    defaultVelocity: 0x3c3, // settings +3
    defaultLength: 0x3c4,  // settings +4
    lengthSteps: 0x3cc,    // settings +12 — track length in steps (INFERRED by DNX, untested
                            // against hardware; read-only until Phase 0 confirms it)
    // No track.trackProb and no track.trigFill/trigProb offsets: the DN1 has
    // no separate track-level PROB default (trig-cond.js's applyTrackProb
    // path is skipped for a spec missing these — see safe-write.js).
  },
  kits: {
    10: { size: 2560, nameOffset: 4, soundsOffset: 0x1c, soundSize: 302, soundCount: 4 },
  },
  trackKindFallback: 'synth',
};

const STEP_NOTE = 0x0001;
const NOTE_RECORD_SIZE = 8;
const MAX_NOTES_PER_TRIG = 8; // root + 7 signed offsets

function assertVersion(spec, payload) {
  const version = u32(payload, 0);
  if (!spec.patternVersions.includes(version)) {
    throw new Error(`unsupported ${spec.device} pattern struct version ${version} — needs a digi-roll update`);
  }
  return version;
}

// One step's flag half-word: step 2n lives in the high u16 of entry n, step
// 2n+1 in the low u16. Two adjacent steps share one u32 — never write one
// step's half without preserving the sibling's.
function stepFlags(payload, trackBase, step) {
  const entry = u32(payload, trackBase + SPEC.track.flags + (step >> 1) * 4);
  return step % 2 === 0 ? entry >>> 16 : entry & 0xffff;
}

function setStepFlags(payload, trackBase, step, half) {
  const at = trackBase + SPEC.track.flags + (step >> 1) * 4;
  const entry = u32(payload, at);
  const merged = step % 2 === 0 ? ((half & 0xffff) << 16) | (entry & 0xffff) : (entry & 0xffff0000) | (half & 0xffff);
  writeU32(payload, at, merged >>> 0);
}

// Decode one pattern-kit dump payload (the same 0x50-message body shape as
// DT2/DN2, but DN1-sized: 18,432 pattern bytes + 2,560 kit bytes = 20,992).
export function decodePatternKit(payload) {
  const { pattern: P, track: T } = SPEC;
  if (payload.length < P.size + SPEC.kits[10].size) {
    throw new Error(`pattern-kit payload too short (${payload.length} bytes)`);
  }
  const version = assertVersion(SPEC, payload);

  const tracks = [];
  for (let t = 0; t < P.numTracks; t++) {
    const base = P.tracksOffset + t * T.size;
    const kind = t < P.midiTracksFrom ? 'synth' : 'midi';
    const trigs = new Map();
    for (let s = 0; s < T.numSteps; s++) {
      const flags = stepFlags(payload, base, s);
      if (!(flags & STEP_NOTE)) continue;
      const at = base + T.notes + s * NOTE_RECORD_SIZE;
      const root = payload[at];
      if (root === 0xff) continue; // flag/byte disagree — rare (DNX: 3 of 16,067); skip rather than guess
      const chord = [];
      for (let i = 1; i < NOTE_RECORD_SIZE; i++) {
        const off = payload[at + i];
        if (off === 0) break; // zero terminates the offset list
        chord.push((off << 24) >> 24);
      }
      trigs.set(s, { root, chord });
    }
    tracks.push({
      kind,
      steps: Array.from({ length: T.numSteps }, (_, s) => stepFlags(payload, base, s)),
      defaultNote: payload[base + T.defaultNote],
      defaultVelocity: payload[base + T.defaultVelocity],
      defaultLength: payload[base + T.defaultLength],
      lengthSteps: payload[base + T.lengthSteps],
      trigs,
      _base: base, // internal: trackNotes reads velocity/length/micro straight off the payload
    });
  }

  const kitBase = P.size;
  const kitVersion = u32(payload, kitBase);
  const kit = SPEC.kits[kitVersion];
  if (!kit) throw new Error(`unsupported ${SPEC.device} kit struct version ${kitVersion}`);

  return {
    version,
    name: chars16(payload, P.nameOffset),
    tempoBpm: u16(payload, P.tempoOffset) / 120,
    // No independent kit-index byte on the DN1: pattern k's dump always
    // carries kit k's record, hard-wired (DNX §9/§10.8, confirmed on real
    // captures this session — the payload IS the pair, nothing to look up).
    kitIndex: payload[P.slotIndexOffset],
    tracks,
    kit: {
      version: kitVersion,
      name: chars16(payload, kitBase + kit.nameOffset),
      soundNames: Array.from({ length: P.numTracks }, (_, t) =>
        t < P.midiTracksFrom ? chars16(payload, kitBase + kit.soundsOffset + t * kit.soundSize + 12) : ''),
      // Positional, not a stored bitmask (DNX §7): tracks 0-3 are always
      // synth, 4-7 always MIDI. Synthesised so trackKindLabel's `midiMask &
      // (1 << t)` check works unchanged for every device.
      midiMask: 0xf0,
    },
    _payload: payload,
  };
}

// Notes on one decoded track, in digi-roll terms — same shape trackNotes
// produces for DT2/DN2: { step, pitch, velocity, lenSteps, micro }. A DN1
// chord (root + signed offsets) expands to one entry per pitch, root first.
export function trackNotes(patternKit, trackIndex) {
  const { track: T } = SPEC;
  const track = patternKit.tracks[trackIndex];
  const payload = patternKit._payload;
  const base = track._base;
  const notes = [];
  for (const [step, { root, chord }] of track.trigs) {
    const vByte = payload[base + T.velocity + step];
    const lByte = payload[base + T.noteLength + step];
    const velocity = (vByte === 0xff ? track.defaultVelocity : vByte) & 0x7f;
    const lenByte = lByte === 0xff ? track.defaultLength : lByte;
    const lenSteps = lengthByteToSteps(lenByte);
    const micro = (payload[base + T.micro + step] << 24 >> 24) / 24;
    const pitches = [root, ...chord.map(off => root + off)];
    for (const pitch of pitches) {
      notes.push({ step, pitch: pitch & 0x7f, velocity, lenSteps: isFinite(lenSteps) ? lenSteps : track.lengthSteps, micro });
    }
  }
  return notes.sort((a, b) => a.step - b.step || a.pitch - b.pitch);
}

export function trackTrigCount(patternKit, trackIndex) {
  return patternKit.tracks[trackIndex].trigs.size;
}

// Replace track `trackIndex`'s note trigs, in place on a copy. Returns
// { payload, dropped }. Every byte outside this track's flag words and note-
// related per-step arrays (notes, velocity, length, micro) round-trips
// byte-identical — the trig-condition lane, sound-lock lane and any trigless-
// lock step are never touched, matching the module header's stated scope.
//
// A step losing its trig is handled by clearing the flag bit only: the note/
// velocity/length/micro bytes are left as they stood (stale, unread once the
// flag is clear) rather than scrubbed. Safe because — unlike DT2/DN2's shared
// trig-record pool — a DN1 step's bytes belong exclusively to that
// (track, step) forever; there is no pool to corrupt by leaving them dirty.
export function encodeTrackNotes(payload, trackIndex, notes) {
  const { pattern: P, track: T } = SPEC;
  assertVersion(SPEC, payload);
  if (trackIndex < 0 || trackIndex >= P.numTracks) throw new Error(`no track ${trackIndex}`);

  const out = Uint8Array.from(payload);
  const base = P.tracksOffset + trackIndex * T.size;

  for (let s = 0; s < T.numSteps; s++) {
    setStepFlags(out, base, s, stepFlags(out, base, s) & ~STEP_NOTE);
  }

  const byStep = new Map();
  let dropped = 0;
  for (const n of [...notes].sort((a, b) => a.step - b.step || a.pitch - b.pitch)) {
    if (!Number.isInteger(n.step) || n.step < 0 || n.step >= T.numSteps) { dropped++; continue; }
    const group = byStep.get(n.step) ?? [];
    if (group.length >= MAX_NOTES_PER_TRIG) { dropped++; continue; }
    group.push(n);
    byStep.set(n.step, group);
  }

  for (const [step, group] of byStep) {
    const root = group[0]; // lowest pitch, after the sort above
    const at = base + T.notes + step * NOTE_RECORD_SIZE;
    out[at] = root.pitch & 0x7f;
    let slot = 1;
    for (let i = 1; i < group.length; i++) {
      if (slot >= NOTE_RECORD_SIZE) { dropped++; continue; } // no offset slots left
      const offset = group[i].pitch - root.pitch;
      if (offset === 0) { dropped++; continue; } // unison: unrepresentable, 0 is the terminator
      out[at + slot] = offset & 0xff;
      slot++;
    }
    for (; slot < NOTE_RECORD_SIZE; slot++) out[at + slot] = 0;

    out[base + T.velocity + step] = root.velocity & 0x7f;
    out[base + T.noteLength + step] = stepsToLengthByte(root.len);
    out[base + T.micro + step] = Math.max(-23, Math.min(23, Math.round((root.micro ?? 0) * 24))) & 0xff;

    setStepFlags(out, base, step, stepFlags(out, base, step) | STEP_NOTE);
  }

  return { payload: out, dropped };
}

// Human annotation for a pattern-kit payload offset, in the same spirit as
// pattern-core.js's describeOffset — the diff lab's map from a raw byte to a
// struct field. Field names follow DNX's dn1-project-format.md headings.
export function describeOffset(offset) {
  const { pattern: P, track: T } = SPEC;
  if (offset < P.tracksOffset) return 'pattern struct version';
  if (offset < P.pLocksIndex) {
    const t = Math.floor((offset - P.tracksOffset) / T.size);
    const rel = (offset - P.tracksOffset) % T.size;
    if (rel < 128) return `track ${t + 1} step flags, entry ${Math.floor(rel / 4) + 1} (${rel % 4 < 2 ? 'hi' : 'lo'} half)`;
    if (rel < T.noteLength) return `track ${t + 1} velocity lock, step ${rel - T.velocity + 1}`;
    if (rel < T.micro) return `track ${t + 1} note-length lock, step ${rel - T.noteLength + 1}`;
    if (rel < T.trigCondition) return `track ${t + 1} micro-timing, step ${rel - T.micro + 1}`;
    if (rel < T.notes) return `track ${t + 1} trig condition (undecoded), step ${rel - T.trigCondition + 1}`;
    if (rel < T.soundLock) {
      const step = Math.floor((rel - T.notes) / NOTE_RECORD_SIZE);
      const part = (rel - T.notes) % NOTE_RECORD_SIZE;
      return `track ${t + 1} note record, step ${step + 1}, ${part === 0 ? 'root note' : `chord offset ${part}`}`;
    }
    if (rel < T.settings) return `track ${t + 1} sound lock, step ${rel - T.soundLock + 1}`;
    return `track ${t + 1} settings +${rel - T.settings}`;
  }
  if (offset < P.nameOffset) {
    const lane = Math.floor((offset - P.pLocksIndex) / P.pLockSize);
    const rel = (offset - P.pLocksIndex) % P.pLockSize;
    const part = rel === 0 ? 'paramId' : rel === 1 ? 'track' : `step ${Math.floor((rel - 2) / 2) + 1} value (${rel % 2 ? 'hi' : 'lo'} byte)`;
    return `p-lock lane ${lane}, ${part}`;
  }
  if (offset < P.nameOffset + 16) return 'pattern name';
  if (offset < P.tempoOffset + 2) return 'pattern tempo (u16, BPM × 120)';
  if (offset === P.slotIndexOffset) return 'pattern-declared slot index';
  if (offset < P.size) return `pattern settings tail +${offset - P.nameOffset - 16}`;
  return `kit +${offset - P.size}`;
}

export { lengthByteToSteps, stepsToLengthByte, bankName, diffPayloads };
