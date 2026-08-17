import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP } from '../js/elektron/protocol.js';
import * as dt2 from '../js/elektron/dt2/pattern.js';
import * as dn2 from '../js/elektron/dn2/pattern.js';
import { voiceChord } from '../js/chords.js';
import {
  deviceNotesToRoll, rollNotesToDevice, deviceNotesToEncoder, rollLengthForTrack,
  snapLenFine, LEN_MIN,
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

      it('brings every note home byte-for-byte unchanged', () => {
        // Nothing about an unedited round trip may alter a note any more. Note
        // length used to be the exception, because the roll drew in whole
        // steps and the DN2 fixture's 4.75-step trig came back as 5; the roll
        // now carries fractional lengths, so even that survives. Pitch,
        // velocity and micro-timing were always exact — micro being the field
        // most likely to be quietly lost.
        const { payload } = roundTrip(box, box.payload, t);
        expect(box.mod.trackNotes(box.mod.decodePatternKit(payload), t)).toEqual(original());
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

// Velocity, length and micro belong to the note, not the trig. They used to be
// taken from a step's first note and mirrored across the whole group, so every
// chord landed on the box as a flat block at the *lowest* note's values — the
// encoder sorts by pitch, so the bottom note won. Both boxes store all three
// per note; the DN2 edits them per note in its own NOTE EDIT menu.
describe.skipIf(!have)('chords keep every note its own velocity, length and micro', () => {
  // A strummed, tapered C major 7: exactly what the chord tool stamps, and the
  // per-note micro js/chords.js promises survives write-back. The strum is a
  // whole number of micro ticks (1/24 step) so nothing is lost to quantising.
  const chord = step => voiceChord([60, 64, 67, 71], { velocity: 100, strum: 2 / 24 })
    .map((v, i) => ({ ...v, step, len: [1, 2, 4, 0.5][i], prob: null, fill: null, cond: null }));

  // Every pool record belonging to one (track, step), in pool order. On a quad
  // device this includes the unused note slots, which carry a 0xFF note.
  const recordsAt = (box, payload, trackIndex, step) => {
    const [lo, hi] = box.pool;
    const recs = [];
    for (let o = lo; o < hi; o += 6) {
      if (payload[o] !== trackIndex || payload[o + 1] !== step) continue;
      recs.push({
        note: payload[o + 2], velocity: payload[o + 3],
        length: payload[o + 4], micro: (payload[o + 5] << 24) >> 24,
      });
    }
    return recs;
  };

  for (const box of BOXES) {
    describe(box.name, () => {
      const t = box.trackIndex;

      it('lands four distinct notes, each with its own three values', () => {
        const notes = chord(0);
        const { payload, dropped } = box.mod.encodeTrackNotes(box.payload, t, notes);
        expect(dropped).toBe(0);
        expect(box.mod.trackNotes(box.mod.decodePatternKit(payload), t)).toEqual(
          notes.map(n => ({
            step: n.step, pitch: n.pitch, velocity: n.velocity, lenSteps: n.len, micro: n.micro,
          })),
        );
      });

      it('writes three different velocities, lengths and micros into the records', () => {
        // The regression itself, at the byte level: the values must differ
        // across the chord's records rather than repeat the first note's.
        const { payload } = box.mod.encodeTrackNotes(box.payload, t, chord(0));
        const sounding = recordsAt(box, payload, t, 0).filter(r => r.note !== 0xff);
        expect(sounding).toHaveLength(4);
        for (const field of ['velocity', 'length', 'micro']) {
          expect(new Set(sounding.map(r => r[field])).size, `${field} was mirrored`).toBe(4);
        }
      });

      it('still mirrors a lone note across its whole record group, as the box does', () => {
        // The property that makes this change a no-op for every single-note
        // trig ever written: a quad's unused slots keep carrying the one
        // note's values, so those bytes are what mirroring always produced.
        const one = [{ step: 3, pitch: 55, velocity: 77, len: 2, micro: 5 / 24, prob: null, fill: null, cond: null }];
        const { payload } = box.mod.encodeTrackNotes(box.payload, t, one);
        const recs = recordsAt(box, payload, t, 3);
        expect(recs.length).toBe(box.mod.SPEC.trig.layout === 'quad' ? 4 : 1);
        for (const r of recs) {
          expect(r.velocity).toBe(77);
          expect(r.length).toBe(30); // two steps
          expect(r.micro).toBe(5);
        }
      });

      it('keeps the write minimal — a chord still only touches this track', () => {
        const { payload } = box.mod.encodeTrackNotes(box.payload, t, chord(0));
        expectOnlyTrackBytesChanged(box, box.payload, payload, t);
      });

      it('is stable on a second pass', () => {
        const first = box.mod.encodeTrackNotes(box.payload, t, chord(0)).payload;
        const notes = box.mod.trackNotes(box.mod.decodePatternKit(first), t);
        const second = box.mod.encodeTrackNotes(first, t, deviceNotesToEncoder(notes)).payload;
        expect(box.mod.diffPayloads(first, second, 100000)).toEqual([]);
      });
    });
  }
});

// Ground truth for the above, captured read-only from a Digitone II (OS 1.10D,
// build 0049) on 2026-08-04: chords entered on the box itself through NOTE
// EDIT, one variable per step — velocities on step 1, lengths on step 5,
// micro-timing on step 9. This is the dump that proved the boxes store all
// three per note rather than per trig.
const CHORD_FIXTURE = fileURLToPath(new URL('../dumps/digitone2-pernote-chords-2026-08-04.syx', import.meta.url));
const haveChordFixture = existsSync(CHORD_FIXTURE);

describe.skipIf(!haveChordFixture)('a DN2 chord the box itself wrote', () => {
  // Read lazily behind a getter: describe.skipIf skips the *tests*, but vitest
  // still runs this callback at collection time, so reading here directly would
  // ENOENT on a checkout without the gitignored fixture. Memoised, so every
  // test still shares one payload instance as before.
  let cached;
  const box = {
    name: 'DN2', mod: dn2, trackIndex: 0,
    get payload() { return (cached ??= payloadOf(CHORD_FIXTURE, 0)); },
    stepWords: t => [4 + t * 1187, 4 + t * 1187 + 256],
    pool: [18996, 68148],
  };
  // The encoder groups a step's notes by pitch, so a write-back reorders the
  // box's records (it stores them in entry order — step 9 came off the box as
  // 68, 64, 61). Harmless now that each value travels with its own note, but
  // it means these comparisons sort before matching.
  const byPitch = ns => [...ns].sort((a, b) => a.step - b.step || a.pitch - b.pitch);
  const notesOf = payload => byPitch(box.mod.trackNotes(box.mod.decodePatternKit(payload), 0));

  it('reads back exactly the per-note values seen on the hardware', () => {
    expect(notesOf(box.payload)).toEqual([
      { step: 0, pitch: 60, velocity: 127, lenSteps: 1, micro: 0 },
      { step: 0, pitch: 63, velocity: 52, lenSteps: 1, micro: 0 },
      { step: 0, pitch: 67, velocity: 69, lenSteps: 1, micro: 0 },
      { step: 4, pitch: 62, velocity: 40, lenSteps: 3.25, micro: 0 },
      { step: 4, pitch: 65, velocity: 40, lenSteps: 2.5, micro: 0 },
      { step: 4, pitch: 69, velocity: 40, lenSteps: 2, micro: 0 },
      { step: 8, pitch: 61, velocity: 40, lenSteps: 1, micro: 2 / 24 },
      { step: 8, pitch: 64, velocity: 40, lenSteps: 1, micro: -9 / 24 },
      { step: 8, pitch: 68, velocity: 40, lenSteps: 1, micro: -14 / 24 },
    ]);
  });

  it('comes home unharmed through the piano roll', () => {
    const { payload, dropped } = roundTrip(box, box.payload, 0);
    expect(dropped).toBe(0);
    expect(notesOf(payload)).toEqual(notesOf(box.payload));
  });

  it('touches nothing outside the track it writes', () => {
    const { payload } = roundTrip(box, box.payload, 0);
    expectOnlyTrackBytesChanged(box, box.payload, payload, 0);
  });
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
    expect(rollNotesToDevice(roll)).toEqual([{
      step: 3, pitch: 40, velocity: 90, len: 2, micro: -5 / 24,
      prob: null, fill: null, cond: null, // unlocked, as an untouched note is
    }]);
  });

  it('clamps pitch and length to what the roll can draw', () => {
    const roll = deviceNotesToRoll([
      { step: 0, pitch: 12, velocity: 90, lenSteps: 1, micro: 0 },   // below the roll's lowest row
      { step: 0, pitch: 120, velocity: 90, lenSteps: 1, micro: 0 },  // above the roll's highest row
      { step: 14, pitch: 60, velocity: 90, lenSteps: 32, micro: 0 }, // runs past the end
      // Shorter than a step: kept, not rounded up. The roll draws fractions now,
      // and 0.25 is a length the box genuinely stores.
      { step: 0, pitch: 60, velocity: 90, lenSteps: 0.25, micro: 0 },
      { step: 0, pitch: 60, velocity: 90, lenSteps: 0.01, micro: 0 }, // below the shortest byte
    ], 16);
    expect(roll.map(n => n.pitch)).toEqual([24, 96, 60, 60, 60]);
    expect(roll.map(n => n.len)).toEqual([1, 1, 2, 0.25, 0.125]);
  });

  it('brings a fractional length home exactly', () => {
    // The DN2 fixture's 4.75-step trig is the reason this feature exists: it
    // used to arrive as 5 and go back to the box a quarter-step too long.
    const roll = deviceNotesToRoll([{ step: 0, pitch: 60, velocity: 90, lenSteps: 4.75, micro: 0 }], 16);
    expect(roll[0].len).toBe(4.75);
    expect(rollNotesToDevice(roll)[0].len).toBe(4.75);
  });

  it('passes device notes straight through for cross-device copy, unclamped', () => {
    // The roll can't draw a pitch-12 note, but a box can hold one; copying
    // between boxes must not transpose it into range.
    expect(deviceNotesToEncoder([{ step: 0, pitch: 12, velocity: 90, lenSteps: 0.25, micro: 1 / 24 }]))
      .toEqual([{
        step: 0, pitch: 12, velocity: 90, len: 0.25, micro: 1 / 24,
        // Trig conditions come from the per-step lanes, not from a decoded
        // note, so they start unlocked and attachTrigSettings fills them in.
        prob: null, fill: null, cond: null,
      }]);
  });

  it('rounds a track length up to whole bars for the roll', () => {
    expect(rollLengthForTrack({ lengthSteps: 16 })).toBe(16);
    expect(rollLengthForTrack({ lengthSteps: 17 })).toBe(32);
    expect(rollLengthForTrack({ lengthSteps: 4 })).toBe(16);
    expect(rollLengthForTrack({ lengthSteps: 999 })).toBe(128);
  });
});

describe('fine note lengths', () => {
  // The roll's shift-resize snapper. The scale it snaps to is the boxes' own
  // LEN byte table (pattern-core's lengthByteToSteps): 1/16-step resolution
  // below two steps, doubling every octave above.
  const roundTripsExactly = len =>
    dt2.lengthByteToSteps(dt2.stepsToLengthByte(len)) === len;

  it('snaps to values the box can actually store', () => {
    for (const len of [0.3, 1.1, 2.4, 4.8, 9.7, 33]) {
      expect(roundTripsExactly(snapLenFine(len)), `${len} → ${snapLenFine(len)}`).toBe(true);
    }
  });

  it('leaves a length that is already representable alone', () => {
    for (const len of [LEN_MIN, 0.25, 1, 2, 4.75, 8, 16]) {
      expect(snapLenFine(len), `${len}`).toBe(len);
    }
  });

  it('resolves to a sixteenth of a step below two steps', () => {
    expect(snapLenFine(1.03)).toBe(1);
    expect(snapLenFine(1.05)).toBe(1.0625);
    expect(snapLenFine(1.92)).toBe(1.9375);
    // ...and to an eighth between two steps and four, where the scale doubles.
    expect(snapLenFine(3.9)).toBe(3.875);
  });

  it('never goes below the shortest note the box has', () => {
    expect(snapLenFine(0)).toBe(LEN_MIN);
    expect(snapLenFine(-4)).toBe(LEN_MIN);
    expect(snapLenFine(0.01)).toBe(LEN_MIN);
  });

  it('stays inside the room left in the pattern, even when snapping rounds up', () => {
    // 3.95 is nearest to 4, so a note with only 3.95 steps of room has to come
    // back down the scale to the next representable value that fits.
    expect(snapLenFine(3.95)).toBe(4);
    const fitted = snapLenFine(3.95, 3.95);
    expect(fitted).toBeLessThanOrEqual(3.95);
    expect(roundTripsExactly(fitted)).toBe(true);
    for (const room of [1, 2, 4.75, 16]) {
      expect(snapLenFine(999, room), `room ${room}`).toBeLessThanOrEqual(room);
    }
  });

  it('gives a note with no room at all the shortest length there is', () => {
    expect(snapLenFine(4, 0)).toBe(LEN_MIN);
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
