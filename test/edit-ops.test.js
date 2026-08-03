import { describe, it, expect } from 'vitest';
import { clipboardAnchor, placeClipboard } from '../js/edit-ops.js';
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
