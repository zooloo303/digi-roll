import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP, FAMILY } from '../js/elektron/protocol.js';
import { diffAnnotatedRanges } from '../js/elektron/pattern-core.js';
import {
  decodePatternKit, trackNotes, trackTrigCount, encodeTrackNotes, diffPayloads, describeOffset,
} from '../js/elektron/dn2/pattern.js';

// Real whole-project dump captured from a Digitone II (OS 1.10D, build 0049)
// on 2026-08-01 — the Phase 3 reverse-engineering source material. Pattern
// A01 has 4 trigs on track 3 (note 41, velocities 105/96/113 on steps 3/6/10,
// length 49 on step 6) and 3 trigs on track 9 (note 53, all defaults); the
// remaining 127 patterns are blank. dumps/ is gitignored (personal patterns),
// so this suite skips on checkouts that don't have it.
const FIXTURE = fileURLToPath(new URL('../dumps/digitone2-project-2026-08-01.syx', import.meta.url));
const haveFixture = existsSync(FIXTURE);

const messages = haveFixture ? splitSysExStream(new Uint8Array(readFileSync(FIXTURE))) : [];
const patternKits = messages.filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);
const pattern = i => decodePatternKit(patternKits.find(m => m.index === i).payload);

describe.skipIf(!haveFixture)('DN2 project dump stream', () => {
  it('is a 0x15-family stream: 128 pattern-kits + one project-settings, all checksummed', () => {
    expect(patternKits.length).toBe(128);
    expect(patternKits.every(m => m.family === FAMILY.DIGITONE_2)).toBe(true);
    expect(messages.filter(m => m.kind === 'dump' && m.type === DUMP.PROJECT_SETTINGS).length).toBe(1);
    expect(messages.every(m => m.kind !== 'dump' || (m.checksumOk && m.countOk))).toBe(true);
  });
});

describe.skipIf(!haveFixture)('decodePatternKit on the DN2 fixture', () => {
  const p0 = haveFixture ? pattern(0) : null;

  it('reads the struct versions this OS generation uses', () => {
    expect(p0.version).toBe(3);
    expect(p0.kit.version).toBe(3);
  });

  it('finds the trigs the pattern is known to contain', () => {
    expect(p0.tracks.map((_, t) => trackTrigCount(p0, t)))
      .toEqual([0, 0, 4, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]);
    expect(trackNotes(p0, 2).map(n => n.step)).toEqual([0, 3, 6, 10]);
    expect(trackNotes(p0, 8).map(n => n.step)).toEqual([0, 6, 12]);
  });

  it('joins pool records with track defaults exactly as the box plays them', () => {
    expect(trackNotes(p0, 2)).toEqual([
      { step: 0, pitch: 41, velocity: 100, lenSteps: 1, micro: 0 },   // all defaults
      { step: 3, pitch: 41, velocity: 105, lenSteps: 1, micro: 0 },
      { step: 6, pitch: 41, velocity: 96, lenSteps: 4.75, micro: 0 }, // length byte 49
      { step: 10, pitch: 41, velocity: 113, lenSteps: 1, micro: 0 },
    ]);
    expect(trackNotes(p0, 8).every(n => n.pitch === 53 && n.velocity === 100)).toBe(true);
  });

  it('reads pattern-level settings from the +48-shifted tail', () => {
    expect(p0.tempoBpm).toBe(120);
    expect(p0.kitIndex).toBe(0);
    expect(p0.kit.name).toBe('INTRO_1');
    expect(p0.kit.soundNames[0]).toBe('BLADERNR');
    expect(p0.kit.soundNames[2]).toBe('A_303_INNIT');
    expect(p0.kit.midiMask).toBe(0); // location unmapped on DN2 — always 0
  });

  it('decodes a blank pattern as blank', () => {
    const p1 = pattern(1);
    expect(p1.tracks.every((_, t) => trackTrigCount(p1, t) === 0)).toBe(true);
    expect(p1.name).toBe('');
    expect(p1.tempoBpm).toBe(120);
    expect(p1.kitIndex).toBe(1);
    expect(p1.kit.name).toBe('KIT 2');
  });

  it('rejects payloads it cannot decode safely', () => {
    expect(() => decodePatternKit(new Uint8Array(10))).toThrow(/too short/);
    const alien = Uint8Array.from(patternKits[0].payload);
    alien[3] = 9;
    expect(() => decodePatternKit(alien)).toThrow(/version 9/);
  });
});

describe.skipIf(!haveFixture)('DN2 encodeTrackNotes', () => {
  const blank = () => patternKits.find(m => m.index === 1).payload;
  const busy = () => patternKits.find(m => m.index === 0).payload;

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

  it('touches only the track step words and the trig-record pool', () => {
    const before = blank();
    const { payload: after } = encodeTrackNotes(before, 2, bassline);
    const trackBase = 4 + 2 * 1187;
    for (const d of diffPayloads(before, after, 10000)) {
      const inStepWords = d.offset >= trackBase && d.offset < trackBase + 256;
      const inPool = d.offset >= 18996 && d.offset < 68148;
      expect(inStepWords || inPool, `unexpected byte change at ${d.offset}`).toBe(true);
    }
  });

  it('leaves other tracks\' notes alone when rewriting one track', () => {
    const before = trackNotes(decodePatternKit(busy()), 8);
    const { payload } = encodeTrackNotes(busy(), 2, bassline);
    expect(trackNotes(decodePatternKit(payload), 8)).toEqual(before);
  });

  it('round-trips chords as consecutive per-note records sharing (track, step)', () => {
    // Hardware-verified 2026-08-01: a 3-note chord on one trig is stored as
    // three consecutive records with the same track/step, one note each.
    const chord = [60, 64, 67].map(pitch => ({ step: 0, pitch, velocity: 100, len: 1, micro: 0 }));
    const { payload, dropped } = encodeTrackNotes(blank(), 0, chord);
    expect(dropped).toBe(0);
    // records: track 0, step 0, notes 60/64/67, consecutive from the pool top
    expect([...payload.subarray(18996, 18996 + 18)]).toEqual([
      0, 0, 60, 100, 14, 0,
      0, 0, 64, 100, 14, 0,
      0, 0, 67, 100, 14, 0,
    ]);
    expect(trackNotes(decodePatternKit(payload), 0).map(n => n.pitch)).toEqual([60, 64, 67]);
  });

  it('drops chord notes past maxNotes and reclaims delete-residue records', () => {
    const fat = [60, 62, 64, 65, 67].map(pitch => ({ step: 0, pitch, velocity: 100, len: 1, micro: 0 }));
    const { payload, dropped } = encodeTrackNotes(blank(), 0, fat);
    expect(dropped).toBe(1); // 5th pitch over the maxNotes: 4 cap
    expect(trackNotes(decodePatternKit(payload), 0)).toHaveLength(4);

    // A record the box half-blanked on delete (track/step/note 0xFF, stray
    // micro) is dead space the encoder may claim.
    const residue = Uint8Array.from(blank());
    residue.set([0xff, 0xff, 0xff, 0xff, 0xff, 0x00], 18996);
    const { payload: reused } = encodeTrackNotes(residue, 0, [{ step: 0, pitch: 60, velocity: 100, len: 1, micro: 0 }]);
    expect([...reused.subarray(18996, 19002)]).toEqual([0, 0, 60, 100, 14, 0]);
  });
});

describe.skipIf(!haveFixture)('diff-lab annotation over real payloads', () => {
  it('names every region that differs between the populated and blank patterns', () => {
    // This replays the experiment that mapped the DN2 format. A range label
    // like "unknown" here would mean struct drift — everything the populated
    // pattern touches is in a region the spec claims to understand.
    const ranges = diffAnnotatedRanges(
      patternKits.find(m => m.index === 0).payload,
      patternKits.find(m => m.index === 1).payload,
      describeOffset,
    );
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every(r => !/unknown per-step/.test(r.label))).toBe(true);
    expect(ranges.some(r => /step word/.test(r.label))).toBe(true);
    expect(ranges.some(r => /trig-record pool/.test(r.label))).toBe(true);
    // A trig on track 3 step 4 (0-based t2 s3) is one of the known edits.
    expect(ranges.some(r => r.label === 'track 3 step word, step 4 (hi byte)')).toBe(true);
  });
});

describe('DN2 describeOffset (diff-lab annotations)', () => {
  it('names the regions the diffing lab proved out', () => {
    expect(describeOffset(0)).toBe('pattern struct version');
    expect(describeOffset(4 + 2 * 1187)).toBe('track 3 step word, step 1 (hi byte)');
    expect(describeOffset(4 + 2 * 1187 + 1152)).toBe('track 3 defaults, default note');
    expect(describeOffset(18996 + 6 + 2)).toBe('trig-record pool, record #1, note');
    expect(describeOffset(88788)).toBe('pattern name');
    expect(describeOffset(88804)).toBe('pattern tempo (u32, BPM × 120)');
    expect(describeOffset(88816)).toBe('kit index');
    expect(describeOffset(89088 + 8)).toBe('kit +8');
  });
});
