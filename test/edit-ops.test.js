import { describe, it, expect } from 'vitest';
import {
  clipboardAnchor, placeClipboard, resizeSelectionBy, setSelectionLength, adoptStepTrig,
} from '../js/edit-ops.js';
import { snapLenFine, LEN_MIN } from '../js/roll-bridge.js';
import { PITCH_MIN, PITCH_MAX } from '../js/pianoroll.js';

// Paste placement, canvas-free. The rule that matters is that a block keeps its
// shape: relative timing and pitch survive, and anything that would have to be
// moved to fit is dropped instead of quietly stacking somewhere else.

const clip = (...notes) => notes.map(([step, pitch, len = 1]) =>
  ({ step, pitch, len, velocity: 100, micro: 0, prob: null, fill: null, cond: null }));

const bounds = (lengthSteps = 16) => ({ lengthSteps, pitchMin: PITCH_MIN, pitchMax: PITCH_MAX });

const shape = notes => notes.map(n => [n.step, n.pitch, n.len]);

describe('the anchor a paste hangs off', () => {
  it('is the earliest step', () => {
    expect(clipboardAnchor(clip([4, 60], [1, 64], [7, 67]))).toMatchObject({ step: 1, pitch: 64 });
  });

  it('is the highest pitch among notes sharing that step', () => {
    expect(clipboardAnchor(clip([2, 60], [2, 67], [2, 64]))).toMatchObject({ step: 2, pitch: 67 });
  });
});

describe('pasting at the caret', () => {
  it('lands the anchor on the caret and keeps the block\'s shape', () => {
    const { notes, dropped } = placeClipboard(
      clip([4, 60], [6, 64], [8, 67]), { step: 0, pitch: 72 }, bounds());
    expect(dropped).toBe(0);
    // Anchor (4, 60) → (0, 72), so everything shifts −4 steps and +12 semitones.
    expect(shape(notes)).toEqual([[0, 72, 1], [2, 76, 1], [4, 79, 1]]);
  });

  it('shifts a chord as one block, not note by note', () => {
    const { notes } = placeClipboard(clip([2, 60], [2, 64], [2, 67]), { step: 9, pitch: 60 }, bounds());
    // Anchor is the top note (67), so the whole chord comes down a fifth.
    expect(shape(notes)).toEqual([[9, 53, 1], [9, 57, 1], [9, 60, 1]]);
  });

  it('carries velocity, micro-timing and the trig conditions across', () => {
    const src = [{ step: 1, pitch: 60, len: 2, velocity: 42, micro: 0.25, prob: 30, fill: false, cond: '2:4' }];
    const { notes } = placeClipboard(src, { step: 5, pitch: 62 }, bounds());
    expect(notes[0]).toMatchObject({ velocity: 42, micro: 0.25, prob: 30, fill: false, cond: '2:4' });
  });

  it('drops notes whose start falls past the end of the pattern', () => {
    const { notes, dropped } = placeClipboard(clip([0, 60], [8, 62]), { step: 12, pitch: 60 }, bounds());
    expect(shape(notes)).toEqual([[12, 60, 1]]);
    expect(dropped).toBe(1);
  });

  it('drops notes pushed off the bottom of the drawable rows', () => {
    const { notes, dropped } = placeClipboard(
      clip([0, 72], [1, 30]), { step: 0, pitch: PITCH_MIN + 2 }, bounds());
    // The block drops 46 semitones: the low note would land under PITCH_MIN.
    expect(shape(notes)).toEqual([[0, PITCH_MIN + 2, 1]]);
    expect(dropped).toBe(1);
  });

  it('shortens a note that overruns the end rather than dropping it', () => {
    const { notes, dropped } = placeClipboard(clip([0, 60, 8]), { step: 12, pitch: 60 }, bounds());
    expect(shape(notes)).toEqual([[12, 60, 4]]);
    expect(dropped).toBe(0);
  });

  it('reports everything dropped when the block lands entirely off the grid', () => {
    const { notes, dropped } = placeClipboard(clip([0, 60], [1, 61]), { step: 15, pitch: 60 }, bounds());
    expect(shape(notes)).toEqual([[15, 60, 1]]);
    expect(dropped).toBe(1);
  });
});

describe('pasting with no caret yet', () => {
  it('keeps the old absolute-position behaviour', () => {
    const { notes, dropped } = placeClipboard(clip([4, 60], [6, 64]), null, bounds());
    expect(shape(notes)).toEqual([[4, 60, 1], [6, 64, 1]]);
    expect(dropped).toBe(0);
  });

  it('backstops a note past the end onto the last step instead of dropping it', () => {
    const { notes, dropped } = placeClipboard(clip([40, 60, 4]), null, bounds());
    expect(shape(notes)).toEqual([[15, 60, 1]]);
    expect(dropped).toBe(0);
  });
});

describe('an empty clipboard', () => {
  it('places nothing', () => {
    expect(placeClipboard([], { step: 0, pitch: 60 }, bounds())).toEqual({ notes: [], dropped: 0 });
  });
});

// Resizing a selection. The two entry points answer different questions, so
// they clamp differently and the tests below are mostly about the edges: a drag
// exists to keep long and short notes different, the LEN control exists to make
// them the same.
const sel = (...pairs) => pairs.map(([step, len]) => ({ step, len }));

describe('dragging one edge with a selection behind it', () => {
  it('moves every note by the same delta, so the shape survives', () => {
    expect(resizeSelectionBy(sel([0, 1], [4, 2], [8, 4]), 1, { lengthSteps: 16 }))
      .toEqual([2, 3, 5]);
  });

  it('shrinks by the same delta too', () => {
    expect(resizeSelectionBy(sel([0, 4], [4, 3]), -2, { lengthSteps: 16 }))
      .toEqual([2, 1]);
  });

  it('stops the whole group at the first note that runs out of room', () => {
    // A 1-step note at step 14 of a 16-step pattern can grow by exactly one
    // before it hits the end, so asking for four holds everyone to one rather
    // than letting the others run on and flatten the differences this mode
    // exists to keep.
    expect(resizeSelectionBy(sel([0, 1], [14, 1]), 4, { lengthSteps: 16 }))
      .toEqual([2, 2]);
  });

  it('stops the whole group at the shortest note when shrinking', () => {
    expect(resizeSelectionBy(sel([0, 4], [4, 1]), -3, { lengthSteps: 16 }))
      .toEqual([4, 1]);
  });

  it('never shrinks past the floor it is given', () => {
    const lens = resizeSelectionBy(sel([0, 2], [4, 8]), -100, { lengthSteps: 16 });
    expect(lens).toEqual([1, 7]); // the 2-step note hits 1, so the delta stops at -1
  });

  it('snaps every result to what the device can store', () => {
    // A fine drag: the delta lands each note on the box's own LEN scale rather
    // than on some value that would quietly round on write.
    const lens = resizeSelectionBy(sel([0, 1], [4, 2]), 0.1,
      { lengthSteps: 16, snapLen: snapLenFine, minLen: LEN_MIN });
    expect(lens).toEqual([snapLenFine(1.1), snapLenFine(2.1)]);
    for (const len of lens) expect(snapLenFine(len)).toBe(len); // already representable
  });

  it('places no lengths for an empty selection', () => {
    expect(resizeSelectionBy([], 2, { lengthSteps: 16 })).toEqual([]);
  });
});

describe('the LEN control over a selection', () => {
  it('makes every note the same length', () => {
    expect(setSelectionLength(sel([0, 1], [4, 2], [8, 4]), 3, { lengthSteps: 16 }))
      .toEqual([3, 3, 3]);
  });

  it('clamps per note, so a note short of room takes what it has', () => {
    // Deliberately unlike the drag: one cramped note must not hold the rest
    // back from the length that was actually asked for.
    expect(setSelectionLength(sel([0, 1], [14, 1]), 4, { lengthSteps: 16 }))
      .toEqual([4, 2]);
  });

  it('snaps to the device scale and honours its floor', () => {
    expect(setSelectionLength(sel([0, 4]), 0.01,
      { lengthSteps: 16, snapLen: snapLenFine, minLen: LEN_MIN })).toEqual([LEN_MIN]);
  });
});

describe('notes joining an occupied step (adoptStepTrig)', () => {
  // PROB/FILL/COND are per trig on the box, so notes sharing a step must agree
  // — and when they don't, the encoder silently believes the lowest pitch.
  // adoptStepTrig is what keeps paste / move / alt-drag-copy from ever creating
  // that disagreement: the arriving note takes the incumbent trig's conditions.
  let nextId = 0;
  const note = (step, pitch, trig = {}) => ({
    id: `n${nextId++}`, step, pitch, len: 1, velocity: 100, micro: 0,
    prob: null, fill: null, cond: null, ...trig,
  });

  it('an arriving note takes the incumbent trig\'s conditions', () => {
    const incumbent = note(4, 48, { prob: 40, fill: true, cond: '2:4' });
    const arriving = note(4, 60, { cond: 'PRE' });
    const changed = adoptStepTrig([incumbent, arriving], [arriving]);
    expect(changed).toBe(1);
    expect(arriving).toMatchObject({ prob: 40, fill: true, cond: '2:4' });
    // The incumbent is the trig; it never moves toward the arrival.
    expect(incumbent).toMatchObject({ prob: 40, fill: true, cond: '2:4' });
  });

  it('keeps its own conditions on an empty step', () => {
    const arriving = note(6, 60, { cond: '2:4' });
    const other = note(3, 48, { cond: 'PRE' });
    expect(adoptStepTrig([other, arriving], [arriving])).toBe(0);
    expect(arriving.cond).toBe('2:4');
  });

  it('adopts from the lowest-pitch incumbent — the note the encoder believes', () => {
    const low = note(4, 40, { prob: 75 });
    const high = note(4, 70, { prob: 30 });
    const arriving = note(4, 60);
    adoptStepTrig([high, low, arriving], [arriving]);
    expect(arriving.prob).toBe(75);
  });

  it('other arrivals are not incumbents — a pasted chord on an empty step keeps its conditions', () => {
    const a = note(2, 60, { cond: '2:4' });
    const b = note(2, 64, { cond: '2:4' });
    expect(adoptStepTrig([a, b], [a, b])).toBe(0);
    expect(a.cond).toBe('2:4');
    expect(b.cond).toBe('2:4');
  });

  it('counts only notes that actually changed', () => {
    const incumbent = note(4, 48, { cond: '2:4' });
    const agrees = note(4, 60, { cond: '2:4' });
    const differs = note(4, 64, { cond: null });
    expect(adoptStepTrig([incumbent, agrees, differs], [agrees, differs])).toBe(1);
  });

  it('explicit defaults adopt too — an all-null incumbent strips an arriving lock', () => {
    // Joining a trig means taking it as it is, including "no locks at all";
    // anything else would leave the step non-uniform in the other direction.
    const incumbent = note(4, 48);
    const arriving = note(4, 60, { prob: 40, cond: '2:4' });
    expect(adoptStepTrig([incumbent, arriving], [arriving])).toBe(1);
    expect(arriving).toMatchObject({ prob: null, fill: null, cond: null });
  });
});
