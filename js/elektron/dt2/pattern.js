// Digitakt II pattern + kit dump decoding/encoding: the DT2 numbers bound to
// the shared core (../pattern-core.js).
//
// Struct offsets come from elk-herd's Elektron/Digitakt/{Dump,CppStructs}.elm
// (BSD-2-Clause, © mzero) for the pattern/track/kit skeleton, plus our own
// reverse engineering for the note-trig data, which elk-herd never decodes.
// The trig-record pool semantics were confirmed 2026-08-01 by a controlled
// hardware experiment (known note/velocity/length/micro edits on a throwaway
// project, then diffed) — the full story is in docs/dt2-pattern-format.md.

import * as core from '../pattern-core.js';

// Pattern struct versions this decoder understands. Versions 3 and 4 share
// every pattern-level offset (they differ only inside the kit); version 0
// (early DT2 OS) has a different track layout we've never seen in the wild,
// so it is refused rather than guessed at.
export const SPEC = {
  device: 'DT2',
  patternVersions: [3, 4],
  pattern: {
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
  },
  track: {
    size: 1184,             // trackStorage_sizeof (track struct v2)
    numSteps: 128,
    steps: 0,               // uint16be per step; bit 0 = trig enabled
    // 256..1023: six 128-byte per-step arrays of unknown purpose (0xFF-filled;
    // hardware-verified NOT to hold note/velocity/length/micro — those live in
    // the pattern-level trig-record pool)
    soundPLocks: 1024,      // trackStorage_soundSlotLocks, 0xFF = none
    defaults: 1152,         // tail record: default note, velocity, length, …
    lengthSteps: 1164,      // uint16be inside the tail: track length in steps
  },
  // Each trig the box creates allocates four consecutive 6-byte records — one
  // per note slot (chords on MIDI tracks); velocity, length and micro are
  // mirrored across all four, the note only fills slots it uses.
  noteSlotsPerTrig: 4,
  // Kit offsets by kit struct version (the kit follows the pattern in a
  // pattern-kit payload and begins with magic 0xBEEFBACE).
  kits: {
    3: { size: 10240, soundsOffset: 60, soundSize: 341, midiMaskOffset: 9972 },
    4: { size: 22528, soundsOffset: 60, soundSize: 1109, midiMaskOffset: 22260 },
  },
  trackKindFallback: 'sample',
};

export const { lengthByteToSteps, stepsToLengthByte, bankName, trackNotes, trackTrigCount, diffPayloads } = core;
export const decodePatternKit = payload => core.decodePatternKit(SPEC, payload);
export const encodeTrackNotes = (payload, trackIndex, notes) => core.encodeTrackNotes(SPEC, payload, trackIndex, notes);
export const describeOffset = offset => core.describeOffset(SPEC, offset);
