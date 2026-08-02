import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP } from '../js/elektron/protocol.js';
import * as dt2 from '../js/elektron/dt2/pattern.js';
import * as dn2 from '../js/elektron/dn2/pattern.js';
import {
  deviceNotesToRoll, rollNotesToDevice, deviceNotesToEncoder, rollLengthForTrack,
  makeSource, sourceLabel, sourceSlotLabel, sourceMatchesIdentity,
} from '../js/roll-bridge.js';

// Phase 4 feature 1: the full round trip — import a track from a box, edit it
// in the piano roll, write it back. The device conversation is unit-testable
// only up to the payload, so that is exactly what these tests pin down: what
// comes out of the roll and goes back to the box.
//
// Fixtures are the same real hardware dumps the Phase 2/3 suites use; dumps/
// is gitignored, so everything here skips on checkouts without them.
const DT2_FIXTURE = fileURLToPath(new URL('../dumps/digitakt2-project-2026-08-01T23-37-04.syx', import.meta.url));
const DN2_FIXTURE = fileURLToPath(new URL('../dumps/digitone2-project-2026-08-01.syx', import.meta.url));
const have = existsSync(DT2_FIXTURE) && existsSync(DN2_FIXTURE);

const kits = file => splitSysExStream(new Uint8Array(readFileSync(file)))
  .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);
const payloadOf = (file, index) => kits(file).find(m => m.index === index).payload;

// The two boxes, described the way the tests want to talk about them: which
// fixture, which pattern/track has notes on it, and where its bytes live.
const BOXES = have ? [
  {
    name: 'DT2', mod: dt2, payload: payloadOf(DT2_FIXTURE, 0), trackIndex: 10,
    stepWords: t => [4 + t * 1184, 4 + t * 1184 + 256],
    pool: [18948, 68100],
  },
  {
    name: 'DN2', mod: dn2, payload: payloadOf(DN2_FIXTURE, 0), trackIndex: 2,
    stepWords: t => [4 + t * 1187, 4 + t * 1187 + 256],
    pool: [18996, 68148],
  },
] : [];

// The write path's contract: nothing outside the track's step words and the
// shared trig-record pool may move.
function expectOnlyTrackBytesChanged(box, before, after, trackIndex) {
  const [stepLo, stepHi] = box.stepWords(trackIndex);
  const [poolLo, poolHi] = box.pool;
  for (const d of box.mod.diffPayloads(before, after, 100000)) {
    const ok = (d.offset >= stepLo && d.offset < stepHi) || (d.offset >= poolLo && d.offset < poolHi);
    expect(ok, `unexpected byte change at ${d.offset} (${box.mod.describeOffset(d.offset)})`).toBe(true);
  }
}

// One trip through the piano roll and back: decode → roll notes → device notes
// → encode. This is precisely what "import, edit nothing, write back" does.
function roundTrip(box, payload, trackIndex, edit = notes => notes) {
  const decoded = box.mod.decodePatternKit(payload);
  const lengthSteps = rollLengthForTrack(decoded.tracks[trackIndex]);
  const rollNotes = edit(deviceNotesToRoll(box.mod.trackNotes(decoded, trackIndex), lengthSteps));
  return { rollNotes, ...box.mod.encodeTrackNotes(payload, trackIndex, rollNotesToDevice(rollNotes)) };
}

describe.skipIf(!have)('round-trip editing: import → piano roll → write back', () => {
  for (const box of BOXES) {
    describe(box.name, () => {
      const t = box.trackIndex;
      const original = () => box.mod.trackNotes(box.mod.decodePatternKit(box.payload), t);

      it('lands on the box exactly what the piano roll is holding', () => {
        const { payload, rollNotes, dropped } = roundTrip(box, box.payload, t);
        expect(dropped).toBe(0);
        expect(box.mod.trackNotes(box.mod.decodePatternKit(payload), t)).toEqual(
          rollNotes.map(({ step, pitch, velocity, len, micro }) =>
            ({ step, pitch, velocity, lenSteps: len, micro })),
        );
      });

      it('brings every note home unchanged, bar the roll\'s whole-step grid', () => {
        // The only thing an unedited round trip may alter is note length, and
        // only because the roll draws in whole steps: the DN2 fixture has a
        // 4.75-step trig that comes back as 5. Pitch, velocity and
        // micro-timing are exact — including micro, which is the field most
        // likely to be quietly lost.
        const { payload } = roundTrip(box, box.payload, t);
        const after = box.mod.trackNotes(box.mod.decodePatternKit(payload), t);
        expect(after.map(n => ({ ...n, lenSteps: 0 })))
          .toEqual(original().map(n => ({ ...n, lenSteps: 0 })));
        for (const [i, n] of after.entries()) {
          expect(n.lenSteps).toBe(Math.max(1, Math.round(original()[i].lenSteps)));
        }
      });

      it('writes back a payload that differs from the box only in that track', () => {
        // The one thing a first write does change: the box stores "use the
        // track default" as 0xFF, and the encoder always writes explicit
        // values. That is confined to the pool records of this track — no
        // other track, no sound, no p-lock, no pattern setting moves.
        const { payload } = roundTrip(box, box.payload, t);
        expectOnlyTrackBytesChanged(box, box.payload, payload, t);
      });

      it('leaves every other track byte-identical', () => {
        const { payload } = roundTrip(box, box.payload, t);
        const before = box.mod.decodePatternKit(box.payload);
        const after = box.mod.decodePatternKit(payload);
        for (let other = 0; other < 16; other++) {
          if (other === t) continue;
          expect(box.mod.trackNotes(after, other), `track ${other + 1} changed`)
            .toEqual(box.mod.trackNotes(before, other));
        }
        expect(after.name).toBe(before.name);
        expect(after.tempoBpm).toBe(before.tempoBpm);
        expect(after.kit.soundNames).toEqual(before.kit.soundNames);
      });

      it('is byte-identical on the second round trip — an unedited write is a no-op', () => {
        // Once the defaults are materialised, import → write back → import →
        // write back must converge: no drift, no pool churn, ever.
        const first = roundTrip(box, box.payload, t).payload;
        const second = roundTrip(box, first, t).payload;
        expect(box.mod.diffPayloads(first, second, 100000)).toEqual([]);
      });

      it('produces a minimal diff when one note moves one step', () => {
        const base = roundTrip(box, box.payload, t).payload;
        const moved = roundTrip(box, box.payload, t, notes => {
          // Nudge the last note one step later: the trig moves, nothing else does.
          const last = notes.reduce((a, b) => (b.step > a.step ? b : a));
          return notes.map(n => (n.id === last.id ? { ...n, step: n.step + 1 } : n));
        }).payload;

        const diffs = box.mod.diffPayloads(base, moved, 100000);
        expect(diffs.length).toBeGreaterThan(0);
        // Two step words plus the moved trig's record(s) — a handful of bytes,
        // not a rewritten pattern.
        expect(diffs.length).toBeLessThan(16);
        expectOnlyTrackBytesChanged(box, base, moved, t);

        const before = box.mod.trackNotes(box.mod.decodePatternKit(base), t);
        const after = box.mod.trackNotes(box.mod.decodePatternKit(moved), t);
        const lastStep = Math.max(...before.map(n => n.step));
        expect(after).toEqual(before.map(n => (n.step === lastStep ? { ...n, step: n.step + 1 } : n)));
      });

      it('clears the track when the roll is emptied, touching nothing else', () => {
        const { payload } = box.mod.encodeTrackNotes(box.payload, t, []);
        expect(box.mod.trackNotes(box.mod.decodePatternKit(payload), t)).toEqual([]);
        expectOnlyTrackBytesChanged(box, box.payload, payload, t);
      });
    });
  }
});

describe.skipIf(!have)('roll-bridge note conversion', () => {
  const box = BOXES[0];

  it('renames lenSteps → len and gives every roll note a fresh id', () => {
    const decoded = box.mod.decodePatternKit(box.payload);
    const notes = box.mod.trackNotes(decoded, box.trackIndex);
    const roll = deviceNotesToRoll(notes, 16);
    expect(roll).toHaveLength(notes.length);
    expect(new Set(roll.map(n => n.id)).size).toBe(roll.length);
    expect(roll.map(n => n.len)).toEqual(notes.map(n => n.lenSteps));
    expect(roll.map(n => n.velocity)).toEqual(notes.map(n => n.velocity));
    expect(roll.map(n => n.micro)).toEqual(notes.map(n => n.micro));
  });

  it('keeps micro-timing through the roll and back out again', () => {
    const roll = deviceNotesToRoll(
      [{ step: 3, pitch: 40, velocity: 90, lenSteps: 2, micro: -5 / 24 }], 16);
    expect(roll[0].micro).toBe(-5 / 24);
    expect(rollNotesToDevice(roll)).toEqual([{ step: 3, pitch: 40, velocity: 90, len: 2, micro: -5 / 24 }]);
  });

  it('clamps pitch and length to what the roll can draw', () => {
    const roll = deviceNotesToRoll([
      { step: 0, pitch: 12, velocity: 90, lenSteps: 1, micro: 0 },   // below C1
      { step: 0, pitch: 120, velocity: 90, lenSteps: 1, micro: 0 },  // above C7
      { step: 14, pitch: 60, velocity: 90, lenSteps: 32, micro: 0 }, // runs past the end
      { step: 0, pitch: 60, velocity: 90, lenSteps: 0.25, micro: 0 }, // shorter than a step
    ], 16);
    expect(roll.map(n => n.pitch)).toEqual([24, 96, 60, 60]);
    expect(roll.map(n => n.len)).toEqual([1, 1, 2, 1]);
  });

  it('passes device notes straight through for cross-device copy, unclamped', () => {
    // The roll can't draw a pitch-12 note, but a box can hold one; copying
    // between boxes must not transpose it into range.
    expect(deviceNotesToEncoder([{ step: 0, pitch: 12, velocity: 90, lenSteps: 0.25, micro: 1 / 24 }]))
      .toEqual([{ step: 0, pitch: 12, velocity: 90, len: 0.25, micro: 1 / 24 }]);
  });

  it('rounds a track length up to whole bars for the roll', () => {
    expect(rollLengthForTrack({ lengthSteps: 16 })).toBe(16);
    expect(rollLengthForTrack({ lengthSteps: 17 })).toBe(32);
    expect(rollLengthForTrack({ lengthSteps: 4 })).toBe(16);
    expect(rollLengthForTrack({ lengthSteps: 999 })).toBe(128);
  });
});

describe('provenance', () => {
  const src = makeSource({
    slug: 'digitone2', productId: 43, deviceName: 'Digitone II',
    patternIndex: 1, trackIndex: 2, patternName: 'INTRO',
  });

  it('records the box, pattern and track a slot came from', () => {
    expect(src).toMatchObject({ slug: 'digitone2', productId: 43, patternIndex: 1, trackIndex: 2, origin: 'box' });
    expect(sourceSlotLabel(src)).toBe('A02 T3');
    expect(sourceLabel(src)).toBe('Digitone II A02 T3');
    expect(typeof src.importedAt).toBe('string');
  });

  it('matches only the box it came from', () => {
    expect(sourceMatchesIdentity(src, { productId: 43, slug: 'digitone2' })).toBe(true);
    expect(sourceMatchesIdentity(src, { productId: 42, slug: 'digitakt2' })).toBe(false);
    expect(sourceMatchesIdentity(null, { productId: 43, slug: 'digitone2' })).toBe(false);
    expect(sourceMatchesIdentity(src, null)).toBe(false);
  });

  it('falls back to the slug when provenance came from a file (no handshake)', () => {
    const fromFile = makeSource({ slug: 'digitakt2', patternIndex: 0, trackIndex: 0, origin: 'file' });
    expect(fromFile.productId).toBe(null);
    expect(sourceMatchesIdentity(fromFile, { productId: 42, slug: 'digitakt2' })).toBe(true);
    expect(sourceMatchesIdentity(fromFile, { productId: 43, slug: 'digitone2' })).toBe(false);
  });

  it('has no label for a locally drawn pattern', () => {
    expect(sourceLabel(null)).toBe('');
    expect(sourceSlotLabel(null)).toBe('');
  });
});
