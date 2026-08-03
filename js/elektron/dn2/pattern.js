// Digitone II pattern + kit dump decoding: the DN2 numbers bound to the
// shared core (../pattern-core.js).
//
// Nobody had published this format; every offset here is digi-roll's own
// reverse engineering (2026-08-01, DN2 OS 1.10D, pattern struct v3, kit v3),
// done by diffing real DN2 project dumps against the known DT2 layout, then
// hardware-verified field-by-field with a controlled experiment pass —
// method, per-field provenance and the experiment log are in
// docs/dn2-pattern-format.md. Summary: the DN2 pattern struct is the DT2 one
// with a track struct 3 bytes larger (1187), which pushes the trig-record
// pool to 18996 and everything after the tracks up by 48; total struct size
// is identical. Trigs store one record per sounding note (chords = several
// records sharing track/step), unlike the DT2's fixed quads. The kit struct
// differs (synth presets, no sample slots) and is round-tripped untouched.
//
// Write path hardware-verified 2026-08-01 on OS build 0049: encode → send →
// re-read came back byte-identical, chords included (the console gates
// writes on its per-device build allowlist).

import * as core from '../pattern-core.js';

export const SPEC = {
  device: 'DN2',
  patternVersions: [3],     // the only version seen in the wild (OS 1.10D)
  pattern: {
    size: 89088,            // same total as DT2 — the tail shrinks by what the tracks gain
    tracksOffset: 4,
    numTracks: 16,
    trigPool: 18996,        // = 4 + 16 × 1187, same formula as DT2
    trigPoolRecords: 8192,  // pool spans 18996..68148, same byte size as DT2's
    pLocksIndex: 68148,
    numPLocks: 80,
    pLockSize: 2 + 128 * 2,
    nameOffset: 88788,      // every tail field sits at DT2's offset + 48 (= 16 tracks × 3)
    tempoOffset: 88804,
    kitIndexOffset: 88816,
  },
  track: {
    size: 1187,             // DT2's 1184 + 3 extra bytes near the end of the defaults tail
    numSteps: 128,
    steps: 0,               // uint16be per step; bit 0 = trig enabled (0x0381 on live trigs)
    // The trig-condition lanes sit at the DT2's track-relative offsets — the
    // +48 pattern shift comes from the track tail, not its head (verified
    // 2026-08-02 on OS 1.10D: identical lanes, encodings and COND menu).
    trigCond: 256,
    trigFill: 384,
    trigProb: 512,
    soundPLocks: 1024,      // same relative offsets as DT2 through the defaults block
    defaults: 1152,
    lengthSteps: 1164,
    trackProb: 1168,        // track-level PROB default, a percentage (0x64 = 100)
  },
  // One 6-byte record per sounding note (not DT2's quad of four): a chord is
  // several consecutive records sharing (track, step) — hardware-verified
  // with a 3-note chord. Deleting a trig blanks track/step/note to 0xFF but
  // can leave stray length/micro bytes. maxNotes caps what we write per trig
  // (3 verified on hardware; 4 matches the DT2 note-slot count).
  trig: { layout: 'perNote', maxNotes: 4 },
  kits: {
    // 16 × 359-byte synth-preset structs at +60, then 16 × 268-byte MIDI-track
    // structs at +5964; per-track MIDI mask location still unmapped (null).
    3: { size: 10752, soundsOffset: 60, soundSize: 359, midiMaskOffset: null },
  },
  trackKindFallback: 'synth',
};

export const { lengthByteToSteps, stepsToLengthByte, bankName, trackNotes, trackTrigCount, diffPayloads } = core;
export const decodePatternKit = payload => core.decodePatternKit(SPEC, payload);
export const encodeTrackNotes = (payload, trackIndex, notes) => core.encodeTrackNotes(SPEC, payload, trackIndex, notes);
export const describeOffset = offset => core.describeOffset(SPEC, offset);
