import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, FAMILY } from '../js/elektron/protocol.js';
import { diffAnnotatedRanges } from '../js/elektron/pattern-core.js';
import { readAllPLocks } from '../js/elektron/plocks.js';
import { readSwing } from '../js/elektron/pattern-settings.js';
import {
  SPEC, decodePatternKit, trackNotes, trackTrigCount, encodeTrackNotes, diffPayloads, describeOffset,
} from '../js/elektron/dn1/pattern.js';

// Fixtures: five real pattern-kit dumps built from Elektron's own DN1 demo
// project ("001 PRESETS"), decompressed with DNX's own decoder and wrapped as
// 0x50 SysEx messages with digi-roll's own protocol.js — never edited by
// hand. See docs/dn1-support-plan.md §1 for how these were produced and
// independently checked against a real DN1 hardware capture. Filenames carry
// the pattern's own name; the trig/chord/lock counts below were read straight
// off the source project with DNX's readPattern, independent of this decoder.
const FIXTURE_DIR = fileURLToPath(new URL('../dumps/fixtures/', import.meta.url));
const haveFixtures = existsSync(FIXTURE_DIR)
  && readdirSync(FIXTURE_DIR).some(f => f.startsWith('digitone1-presets-'));

const load = name => {
  const file = readdirSync(FIXTURE_DIR).find(f => f.startsWith(`digitone1-presets-${name}-`));
  const [msg] = splitSysExStream(new Uint8Array(readFileSync(FIXTURE_DIR + file)));
  return msg;
};

describe.skipIf(!haveFixtures)('DN1 fixture messages', () => {
  it('are well-formed 0x50 dumps on the DN1 family byte', () => {
    for (const name of ['A01-imagine', 'A15-arpchord', 'B01-pc98', 'B06-asphyxia', 'B15-opucukler']) {
      const msg = load(name);
      expect(msg.kind).toBe('dump');
      expect(msg.family).toBe(FAMILY.DIGITONE);
      expect(msg.type).toBe(0x50);
      expect(msg.checksumOk).toBe(true);
      expect(msg.countOk).toBe(true);
      expect(msg.payload.length).toBe(SPEC.pattern.size + SPEC.kits[10].size);
    }
  });
});

describe.skipIf(!haveFixtures)('decodePatternKit on real DN1 captures', () => {
  it('reads the struct version and pattern name', () => {
    const p = decodePatternKit(load('A01-imagine').payload);
    expect(p.version).toBe(10);
    expect(p.kit.version).toBe(10);
    expect(p.name).toBe('IMAGINE');
    expect(p.kitIndex).toBe(0); // pattern-declared slot, self-paired with the kit
  });

  it('finds the trig counts the source project is known to hold (pattern 14, ARPCHORD)', () => {
    // DNX readPattern over the source .dnprj: 143 note trigs, 40 chorded, on
    // synth tracks only (this project uses no MIDI tracks).
    const p = decodePatternKit(load('A15-arpchord').payload);
    const totalTrigs = p.tracks.reduce((n, _, t) => n + trackTrigCount(p, t), 0);
    expect(totalTrigs).toBe(143);
    // Tracks 4-7 are the MIDI tracks and carry no note trigs in this project.
    for (let t = 4; t < 8; t++) expect(trackTrigCount(p, t)).toBe(0);
  });

  it('decodes chords as one note per pitch, root first', () => {
    const p = decodePatternKit(load('A15-arpchord').payload);
    const chorded = [];
    for (let t = 0; t < 4; t++) {
      const byStep = new Map();
      for (const n of trackNotes(p, t)) {
        (byStep.get(n.step) ?? byStep.set(n.step, []).get(n.step)).push(n);
      }
      for (const [, notes] of byStep) if (notes.length > 1) chorded.push(notes);
    }
    expect(chorded.length).toBeGreaterThan(0);
    for (const notes of chorded) {
      // Root-first: the pitches came out of trackNotes sorted by (step, pitch),
      // so the lowest pitch is first — consistent with the encode side's own
      // "lowest pitch is root" rule.
      expect(notes[0].pitch).toBeLessThanOrEqual(Math.min(...notes.map(n => n.pitch)) + 0.001);
    }
  });

  it('finds sound locks and parameter locks (pattern 30, OPUCUKLER)', () => {
    const msg = load('B15-opucukler');
    const p = decodePatternKit(msg.payload);
    let soundLocks = 0;
    for (let t = 0; t < 4; t++) {
      const base = SPEC.pattern.tracksOffset + t * SPEC.track.size;
      for (let s = 0; s < SPEC.track.numSteps; s++) {
        if (msg.payload[base + SPEC.track.soundLock + s] !== 0xff) soundLocks++;
      }
    }
    expect(soundLocks).toBe(33); // matches the DNX scan of the source project
    expect(readAllPLocks(SPEC, msg.payload).length).toBeGreaterThan(0);
    expect(p.name).toBe('OPUCUKLER');
  });

  it('rejects a payload it cannot decode safely', () => {
    expect(() => decodePatternKit(new Uint8Array(10))).toThrow(/too short/);
    const alien = Uint8Array.from(load('A01-imagine').payload);
    alien[3] = 9;
    expect(() => decodePatternKit(alien)).toThrow(/version 9/);
  });
});

describe.skipIf(!haveFixtures)('DN1 p-lock pool matches the measured free-lane form', () => {
  it('every unallocated lane is FF FF + 256 zero bytes, across all five fixtures', () => {
    for (const name of ['A01-imagine', 'A15-arpchord', 'B01-pc98', 'B06-asphyxia', 'B15-opucukler']) {
      const payload = load(name).payload;
      for (let lane = 0; lane < SPEC.pattern.numPLocks; lane++) {
        const o = SPEC.pattern.pLocksIndex + lane * SPEC.pattern.pLockSize;
        if (payload[o] === 0xff && payload[o + 1] === 0xff) {
          for (let i = 2; i < SPEC.pattern.pLockSize; i++) expect(payload[o + i]).toBe(0);
        }
      }
    }
  });

  it('lane values land on the ×256 scaling law measured on DT2/DN2', () => {
    const payload = load('B01-pc98').payload; // PC98 has the richest lock pool (560 values)
    const lanes = readAllPLocks(SPEC, payload);
    expect(lanes.length).toBeGreaterThan(0);
    const anyMultipleOf256 = lanes.some(l => l.values.some(v => v != null && v % 256 === 0));
    expect(anyMultipleOf256).toBe(true);
  });
});

describe.skipIf(!haveFixtures)('DN1 encodeTrackNotes', () => {
  const blank = () => load('A01-imagine').payload; // track 3 (index 2) is empty in this pattern

  const bassline = [
    { step: 0, pitch: 36, velocity: 110, len: 2, micro: 0 },
    { step: 3, pitch: 39, velocity: 90, len: 1, micro: -2 / 24 },
    { step: 6, pitch: 41, velocity: 127, len: 4, micro: 5 / 24 },
    { step: 10, pitch: 36, velocity: 64, len: 1, micro: 0 },
  ];

  it('round-trips notes through encode → decode exactly', () => {
    const { payload, dropped } = encodeTrackNotes(blank(), 2, bassline);
    expect(dropped).toBe(0);
    expect(trackNotes(decodePatternKit(payload), 2)).toEqual([
      { step: 0, pitch: 36, velocity: 110, lenSteps: 2, micro: 0 },
      { step: 3, pitch: 39, velocity: 90, lenSteps: 1, micro: -2 / 24 },
      { step: 6, pitch: 41, velocity: 127, lenSteps: 4, micro: 5 / 24 },
      { step: 10, pitch: 36, velocity: 64, lenSteps: 1, micro: 0 },
    ]);
  });

  it('touches only this track\'s flag words and note-related per-step arrays', () => {
    const before = blank();
    const { payload: after } = encodeTrackNotes(before, 2, bassline);
    const base = SPEC.pattern.tracksOffset + 2 * SPEC.track.size;
    for (const d of diffPayloads(before, after, 10000)) {
      const rel = d.offset - base;
      const inFlags = rel >= 0 && rel < 128;
      const inVelocity = rel >= SPEC.track.velocity && rel < SPEC.track.velocity + SPEC.track.numSteps;
      const inLength = rel >= SPEC.track.noteLength && rel < SPEC.track.noteLength + SPEC.track.numSteps;
      const inMicro = rel >= SPEC.track.micro && rel < SPEC.track.micro + SPEC.track.numSteps;
      const inNotes = rel >= SPEC.track.notes && rel < SPEC.track.notes + SPEC.track.numSteps * 8;
      expect(inFlags || inVelocity || inLength || inMicro || inNotes, `unexpected byte change at ${d.offset}`).toBe(true);
    }
  });

  it('leaves other tracks\' notes alone when rewriting one track', () => {
    const before = trackNotes(decodePatternKit(blank()), 0);
    const { payload } = encodeTrackNotes(blank(), 2, bassline);
    expect(trackNotes(decodePatternKit(payload), 0)).toEqual(before);
  });

  it('encodes a chord as root + signed offsets, root the lowest pitch', () => {
    const chord = [67, 60, 64].map(pitch => ({ step: 0, pitch, velocity: 100, len: 1, micro: 0 }));
    const { payload, dropped } = encodeTrackNotes(blank(), 0, chord);
    expect(dropped).toBe(0);
    const base = SPEC.pattern.tracksOffset + 0 * SPEC.track.size;
    const rec = [...payload.subarray(base + SPEC.track.notes, base + SPEC.track.notes + 8)];
    expect(rec[0]).toBe(60); // root: lowest pitch
    expect(rec.slice(1, 3).sort((a, b) => a - b)).toEqual([4, 7]); // offsets to 64 and 67
    expect(trackNotes(decodePatternKit(payload), 0).map(n => n.pitch).sort((a, b) => a - b)).toEqual([60, 64, 67]);
  });

  it('drops a unison offset (0) and pitches past the 7-offset cap', () => {
    const unison = [60, 60].map(pitch => ({ step: 0, pitch, velocity: 100, len: 1, micro: 0 }));
    const { dropped } = encodeTrackNotes(blank(), 0, unison);
    expect(dropped).toBe(1);

    const fat = Array.from({ length: 9 }, (_, i) => ({ step: 0, pitch: 40 + i, velocity: 100, len: 1, micro: 0 }));
    const { payload, dropped: fatDropped } = encodeTrackNotes(blank(), 0, fat);
    expect(fatDropped).toBe(1); // 9 pitches, 8 slots (root + 7 offsets)
    expect(trackNotes(decodePatternKit(payload), 0)).toHaveLength(8);
  });

  it('rejects a struct version it cannot write', () => {
    const alien = Uint8Array.from(blank());
    alien[3] = 9;
    expect(() => encodeTrackNotes(alien, 0, [])).toThrow(/version 9/);
  });
});

describe.skipIf(!haveFixtures)('diff-lab annotation over a real DN1 payload', () => {
  it('names every region a populated pattern differs from a blanker one', () => {
    const busy = decodePatternKit; // silence unused-import lint in some configs
    const ranges = diffAnnotatedRanges(load('A15-arpchord').payload, load('A01-imagine').payload, describeOffset);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.some(r => /note record/.test(r.label))).toBe(true);
    expect(busy).toBeTypeOf('function');
  });
});

describe('DN1 describeOffset (diff-lab annotations)', () => {
  it('names the regions this module claims to understand', () => {
    expect(describeOffset(0)).toBe('pattern struct version');
    expect(describeOffset(SPEC.pattern.tracksOffset + 2 * SPEC.track.size + SPEC.track.notes))
      .toBe('track 3 note record, step 1, root note');
    expect(describeOffset(SPEC.pattern.pLocksIndex)).toBe('p-lock lane 0, paramId');
    expect(describeOffset(SPEC.pattern.nameOffset)).toBe('pattern name');
    expect(describeOffset(SPEC.pattern.tempoOffset)).toBe('pattern tempo (u16, BPM × 120)');
    expect(describeOffset(SPEC.pattern.size + 8)).toBe('kit +8');
  });
});

// Swing's byte position (nameOffset + 24) is a strong but unconfirmed
// candidate — see dn1-support-plan.md §1. Read-only exercise here: the write
// path can't reach hardware anyway (no WRITE_ALLOWED_BUILDS entry for
// 'digitone' yet), so this only proves the shared helper doesn't crash on a
// DN1-shaped spec, not that the byte is right.
describe.skipIf(!haveFixtures)('pattern-settings.js composes onto a DN1 spec without changes', () => {
  it('reads a swing value in range for every fixture', () => {
    for (const name of ['A01-imagine', 'A15-arpchord', 'B01-pc98', 'B06-asphyxia', 'B15-opucukler']) {
      const swing = readSwing(SPEC, load(name).payload);
      expect(swing).toBeGreaterThanOrEqual(50);
      expect(swing).toBeLessThanOrEqual(80);
    }
  });
});
