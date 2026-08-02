import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP } from '../js/elektron/protocol.js';
import {
  decodePatternKit, trackNotes, trackTrigCount, lengthByteToSteps, stepsToLengthByte, bankName,
  encodeTrackNotes, diffPayloads,
} from '../js/elektron/dt2/pattern.js';

// Real whole-project dumps captured from a Digitakt II (OS 1.15B, build 0070)
// on 2026-08-01. The first has a handful of default trigs in pattern A01; the
// second is the controlled verification experiment — A01 track 1, four trigs:
// step 0 NOTE +3 (63), step 4 VEL 37, step 8 LEN 1/4, step 12 micro-nudged
// left. dumps/ is gitignored (they're personal patterns), so fixture-based
// suites skip on checkouts that don't have them.
const FIXTURE = fileURLToPath(new URL('../dumps/digitakt2-project-2026-08-01T23-37-04.syx', import.meta.url));
const VERIFY = fileURLToPath(new URL('../dumps/digitakt2-verify-2026-08-01.syx', import.meta.url));
const haveFixture = existsSync(FIXTURE);
const haveVerify = existsSync(VERIFY);

const messages = haveFixture ? splitSysExStream(new Uint8Array(readFileSync(FIXTURE))) : [];
const patternKits = messages.filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);
const pattern = i => decodePatternKit(patternKits.find(m => m.index === i).payload);

describe.skipIf(!haveFixture)('project dump stream', () => {
  it('contains 128 pattern-kits and one project-settings terminator, all checksummed', () => {
    expect(patternKits.length).toBe(128);
    expect(messages.filter(m => m.kind === 'dump' && m.type === DUMP.PROJECT_SETTINGS).length).toBe(1);
    expect(messages.every(m => m.kind !== 'dump' || (m.checksumOk && m.countOk))).toBe(true);
  });
});

describe.skipIf(!haveFixture)('decodePatternKit on the fixture', () => {
  // The describe body runs at collection time even when skipped, so guard it.
  const p0 = haveFixture ? pattern(0) : null;

  it('reads the struct versions this OS generation uses', () => {
    expect(p0.version).toBe(4);
    expect(p0.kit.version).toBe(4);
  });

  it('finds the trigs the pattern is known to contain', () => {
    expect(p0.tracks.map((_, t) => trackTrigCount(p0, t)))
      .toEqual([1, 1, 1, 0, 2, 0, 0, 0, 0, 1, 8, 0, 0, 0, 0, 0]);
    expect(trackNotes(p0, 10).map(n => n.step)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(trackNotes(p0, 4).map(n => n.step)).toEqual([4, 12]);
  });

  it('reads pattern-level settings: tempo, kit link, kit and sound names', () => {
    expect(p0.tempoBpm).toBe(167);
    expect(p0.kitIndex).toBe(0);
    expect(p0.kit.name).toBe('JO_KIT');
    expect(p0.kit.soundNames[0]).toBe('PRESET 1');
    expect(p0.kit.soundNames[15]).toBe('PRESET 16');
    expect(p0.kit.midiMask).toBe(0); // every track is a sample track
  });

  it('mixes track defaults with recorded per-trig values', () => {
    const notes = trackNotes(p0, 10);
    expect(notes.every(n => n.pitch === 60 && n.lenSteps === 1 && n.micro === 0)).toBe(true);
    // Steps 0/4/8/12 were played in with real velocities; the rest are grid
    // trigs on the track default of 100.
    expect(notes.map(n => n.velocity)).toEqual([92, 100, 94, 100, 92, 100, 94, 100]);
    expect(p0.tracks[10].lengthSteps).toBe(16);
  });

  it('ignores trig records left behind by deleted trigs', () => {
    // Track 1's record pool holds quads for steps 6, 7, 14 and 15, but only
    // step 6 still has its trig bit set.
    expect([...p0.tracks[1].trigs.keys()].sort((a, b) => a - b)).toEqual([6, 7, 14, 15]);
    expect(trackNotes(p0, 1).map(n => n.step)).toEqual([6]);
  });

  it('decodes a blank pattern as blank', () => {
    const p1 = pattern(1);
    expect(p1.tracks.every((_, t) => trackTrigCount(p1, t) === 0)).toBe(true);
    expect(p1.name).toBe('');
    expect(p1.tempoBpm).toBe(120);
    expect(p1.kitIndex).toBe(1);
  });

  it('rejects payloads it cannot decode safely', () => {
    expect(() => decodePatternKit(new Uint8Array(10))).toThrow(/too short/);
    const alien = Uint8Array.from(patternKits[0].payload);
    alien[3] = 9; // unheard-of pattern struct version
    expect(() => decodePatternKit(alien)).toThrow(/version 9/);
  });
});

describe.skipIf(!haveVerify)('the hardware verification capture', () => {
  const notes = haveVerify
    ? trackNotes(decodePatternKit(
        splitSysExStream(new Uint8Array(readFileSync(VERIFY)))
          .find(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT && m.index === 0).payload,
      ), 0)
    : [];

  it('decodes the four known trig edits exactly', () => {
    expect(notes).toEqual([
      { step: 0, pitch: 63, velocity: 100, lenSteps: 1, micro: 0 },       // NOTE +3
      { step: 4, pitch: 60, velocity: 37, lenSteps: 1, micro: 0 },        // VEL 37
      { step: 8, pitch: 60, velocity: 100, lenSteps: 4, micro: 0 },       // LEN 1/4
      { step: 12, pitch: 60, velocity: 100, lenSteps: 1, micro: -2 / 24 }, // nudged left
    ]);
  });
});

describe.skipIf(!haveFixture)('encodeTrackNotes (write path)', () => {
  const blank = () => patternKits.find(m => m.index === 1).payload; // untouched pattern
  const busy = () => patternKits.find(m => m.index === 0).payload;  // has trigs on several tracks

  const bassline = [
    { step: 0, pitch: 36, velocity: 110, len: 2, micro: 0 },
    { step: 3, pitch: 39, velocity: 90, len: 1, micro: -2 / 24 },
    { step: 6, pitch: 41, velocity: 127, len: 4, micro: 5 / 24 },
    { step: 10, pitch: 36, velocity: 64, len: 1, micro: 0 },
    { step: 10, pitch: 48, velocity: 64, len: 1, micro: 0 }, // chord: 2nd note slot
  ];

  it('round-trips notes through encode → decode exactly', () => {
    const { payload, dropped } = encodeTrackNotes(blank(), 2, bassline);
    expect(dropped).toBe(0);
    const notes = trackNotes(decodePatternKit(payload), 2);
    expect(notes).toEqual([
      { step: 0, pitch: 36, velocity: 110, lenSteps: 2, micro: 0 },
      { step: 3, pitch: 39, velocity: 90, lenSteps: 1, micro: -2 / 24 },
      { step: 6, pitch: 41, velocity: 127, lenSteps: 4, micro: 5 / 24 },
      { step: 10, pitch: 36, velocity: 64, lenSteps: 1, micro: 0 },
      { step: 10, pitch: 48, velocity: 64, lenSteps: 1, micro: 0 },
    ]);
  });

  it('touches only the track step words and the trig-record pool', () => {
    const before = blank();
    const { payload: after } = encodeTrackNotes(before, 2, bassline);
    const trackBase = 4 + 2 * 1184;
    for (const d of diffPayloads(before, after, 10000)) {
      const inStepWords = d.offset >= trackBase && d.offset < trackBase + 256;
      const inPool = d.offset >= 18948 && d.offset < 68100;
      expect(inStepWords || inPool, `unexpected byte change at ${d.offset}`).toBe(true);
    }
  });

  it('leaves other tracks\' notes alone when rewriting one track', () => {
    const before = trackNotes(decodePatternKit(busy()), 10);
    const { payload } = encodeTrackNotes(busy(), 3, bassline);
    expect(trackNotes(decodePatternKit(payload), 10)).toEqual(before);
  });

  it('clears a track when given no notes, freeing its pool quads', () => {
    const { payload } = encodeTrackNotes(busy(), 10, []);
    const decoded = decodePatternKit(payload);
    expect(trackNotes(decoded, 10)).toEqual([]);
    expect(decoded.tracks[10].trigs.size).toBe(0);
    // other tracks untouched
    expect(trackNotes(decoded, 1).map(n => n.step)).toEqual([6]);
  });

  it('drops out-of-range steps and chord notes past four slots', () => {
    const over = [
      { step: 200, pitch: 60, velocity: 100, len: 1, micro: 0 },
      ...[60, 64, 67, 71, 74].map(pitch => ({ step: 0, pitch, velocity: 100, len: 1, micro: 0 })),
    ];
    const { payload, dropped } = encodeTrackNotes(blank(), 0, over);
    expect(dropped).toBe(2); // the step-200 note and the 5th chord pitch
    expect(trackNotes(decodePatternKit(payload), 0).map(n => n.pitch)).toEqual([60, 64, 67, 71]);
  });

  it('refuses when the pool has no free quad for a new trig', () => {
    const jammed = Uint8Array.from(blank());
    for (let o = 18948; o < 68100; o += 6) { // every record claimed by track 6
      jammed[o] = 6; jammed[o + 1] = 0;
    }
    expect(() => encodeTrackNotes(jammed, 0, [{ step: 0, pitch: 60, velocity: 100, len: 1, micro: 0 }]))
      .toThrow(/full/);
  });
});

describe('Elektron length byte scale', () => {
  it('maps the landmark values from libanalogrytm', () => {
    expect(lengthByteToSteps(0)).toBe(0.125);
    expect(lengthByteToSteps(2)).toBe(0.25);
    expect(lengthByteToSteps(14)).toBe(1);   // the DT2 default trig length
    expect(lengthByteToSteps(30)).toBe(2);
    expect(lengthByteToSteps(46)).toBe(4);
    expect(lengthByteToSteps(62)).toBe(8);
    expect(lengthByteToSteps(78)).toBe(16);
    expect(lengthByteToSteps(94)).toBe(32);
    expect(lengthByteToSteps(110)).toBe(64);
    expect(lengthByteToSteps(126)).toBe(128);
    expect(lengthByteToSteps(127)).toBe(Infinity);
  });

  it('round-trips every byte through steps and back', () => {
    for (let v = 0; v <= 127; v++) expect(stepsToLengthByte(lengthByteToSteps(v))).toBe(v);
  });
});

describe('bankName', () => {
  it('names pattern slots the way the box does', () => {
    expect(bankName(0)).toBe('A01');
    expect(bankName(15)).toBe('A16');
    expect(bankName(16)).toBe('B01');
    expect(bankName(127)).toBe('H16');
  });
});
