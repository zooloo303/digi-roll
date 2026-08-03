import { describe, it, expect } from 'vitest';
import { stepValue, targetSteps, setTrigField, cycleFill, probFromDrag } from '../js/triglane.js';
import { makeNote, loadState, defaultState } from '../js/state.js';
import { serializePattern, deserializePattern, BANK_SCHEMA } from '../js/bank.js';
import { trigSettingsFromNotes } from '../js/elektron/trig-cond.js';

// The lane's rules, tested without a canvas. The one that matters most is
// step uniformity: prob/fill/cond belong to the trig, so every note on a step
// has to carry the same values or the encoder (which reads the first note of
// each step) would silently drop somebody's edit.

const chordAt = (step, pitches, extra = {}) =>
  pitches.map(p => Object.assign(makeNote(step, p), extra));

describe('reading a step\'s value', () => {
  it('takes it from the step\'s first note', () => {
    const notes = chordAt(4, [60, 64, 67], { cond: '2:4', prob: 50, fill: true });
    expect(stepValue(notes, 4, 'cond')).toBe('2:4');
    expect(stepValue(notes, 4, 'prob')).toBe(50);
    expect(stepValue(notes, 4, 'fill')).toBe(true);
  });

  it('is null on a step with no notes', () => {
    expect(stepValue([], 0, 'cond')).toBeNull();
  });

  it('reports a FILL OFF lock as false, not as absent', () => {
    expect(stepValue(chordAt(1, [60], { fill: false }), 1, 'fill')).toBe(false);
  });
});

describe('which steps an edit reaches', () => {
  it('is just the clicked step when nothing is selected', () => {
    const notes = [...chordAt(0, [60]), ...chordAt(4, [62])];
    expect(targetSteps(notes, 4, new Set())).toEqual([4]);
  });

  it('is just the clicked step when the click lands outside the selection', () => {
    const notes = [...chordAt(0, [60]), ...chordAt(4, [62])];
    expect(targetSteps(notes, 4, new Set([notes[0].id]))).toEqual([4]);
  });

  it('is every selected step when the click lands inside the selection', () => {
    const notes = [...chordAt(0, [60]), ...chordAt(4, [62]), ...chordAt(9, [64]), ...chordAt(12, [65])];
    const selected = new Set([notes[0].id, notes[1].id, notes[2].id]);
    expect(targetSteps(notes, 4, selected)).toEqual([0, 4, 9]);
  });

  it('lists each selected step once even when a chord fills it', () => {
    const notes = chordAt(3, [60, 64, 67]);
    expect(targetSteps(notes, 3, new Set(notes.map(n => n.id)))).toEqual([3]);
  });
});

describe('writing a field across steps', () => {
  it('keeps every note on a step in agreement', () => {
    const notes = [...chordAt(2, [60, 64, 67]), ...chordAt(5, [72])];
    setTrigField(notes, [2], 'cond', '!1ST');
    expect(notes.filter(n => n.step === 2).map(n => n.cond)).toEqual(['!1ST', '!1ST', '!1ST']);
    expect(notes.find(n => n.step === 5).cond).toBeNull();
  });

  it('reports whether anything actually changed', () => {
    const notes = chordAt(0, [60], { prob: 40 });
    expect(setTrigField(notes, [0], 'prob', 40)).toBe(false);
    expect(setTrigField(notes, [0], 'prob', 41)).toBe(true);
  });

  it('clears a lock with null', () => {
    const notes = chordAt(0, [60, 64], { fill: false });
    setTrigField(notes, [0], 'fill', null);
    expect(notes.every(n => n.fill === null)).toBe(true);
  });

  it('leaves the encoder nothing ambiguous to resolve', () => {
    // The whole point of uniformity: whichever note the encoder picks first,
    // the step's stored setting is the same.
    const notes = [...chordAt(7, [72, 60, 64])];
    setTrigField(notes, [7], 'prob', 25);
    setTrigField(notes, [7], 'cond', '3:4');
    expect(trigSettingsFromNotes(notes).get(7)).toEqual({ prob: 25, fill: null, cond: '3:4' });
  });
});

describe('the FILL cycle', () => {
  it('walks all three states and back', () => {
    expect(cycleFill(null)).toBe(true);
    expect(cycleFill(true)).toBe(false);
    expect(cycleFill(false)).toBeNull();
  });
});

describe('dragging probability', () => {
  it('raises the odds upward and lowers them downward', () => {
    expect(probFromDrag(50, -20)).toBe(60); // dragged up 20px
    expect(probFromDrag(50, 20)).toBe(40);
  });

  it('starts from 100 when the step has no lock yet', () => {
    expect(probFromDrag(null, 40)).toBe(80);
  });

  it('locks an explicit 100 at the top of the range', () => {
    // Not "no lock": with a track-level PROB default, pinning one trig at 100
    // is how you say "this one always plays". Clearing is alt/right-click.
    expect(probFromDrag(90, -40)).toBe(100);
    expect(probFromDrag(null, 0)).toBe(100);
  });

  it('clamps at zero rather than going negative', () => {
    expect(probFromDrag(10, 400)).toBe(0);
  });
});

describe('the note model carries the three fields', () => {
  it('defaults every note to unlocked', () => {
    const n = makeNote(0, 60);
    expect(n).toMatchObject({ prob: null, fill: null, cond: null });
  });

  it('accepts a trig setting at construction', () => {
    expect(makeNote(0, 60, 1, 100, 0, { prob: 50, fill: false, cond: '1:2' }))
      .toMatchObject({ prob: 50, fill: false, cond: '1:2' });
  });

  it('backfills notes saved before the feature existed', () => {
    const state = defaultState();
    state.patterns[0].notes = [{ id: 1, step: 0, pitch: 60, len: 1, velocity: 100 }];
    const store = new Map([['digiroll-v1', JSON.stringify(state)]]);
    globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: () => {} };
    const loaded = loadState();
    expect(loaded.patterns[0].notes[0]).toMatchObject({ prob: null, fill: null, cond: null, micro: 0 });
    delete globalThis.localStorage;
  });

  it('backfills a pattern saved before track PROB existed', () => {
    const state = defaultState();
    for (const p of state.patterns) delete p.trackProb;
    const store = new Map([['digiroll-v1', JSON.stringify(state)]]);
    globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: () => {} };
    expect(loadState().patterns.every(p => p.trackProb === 100)).toBe(true);
    delete globalThis.localStorage;
  });
});

describe('bank round-trip', () => {
  const pattern = () => ({
    name: 'conditions', lengthSteps: 16, channel: 3, swing: 55, trackProb: 30, source: null,
    notes: [
      makeNote(0, 60, 1, 100, 0, { prob: 0, fill: true, cond: 'PRE' }),
      makeNote(4, 64, 2, 90, 0.25, { prob: 100, fill: false, cond: '!8:8' }),
      makeNote(8, 67),
    ],
  });

  it('keeps all three fields through save and load', () => {
    const back = deserializePattern(serializePattern(pattern()), makeNote);
    expect(back.notes.map(n => ({ prob: n.prob, fill: n.fill, cond: n.cond }))).toEqual([
      { prob: 0, fill: true, cond: 'PRE' },
      { prob: 100, fill: false, cond: '!8:8' },
      { prob: null, fill: null, cond: null },
    ]);
  });

  it('does not bump the schema, so old digi-rolls still read the file', () => {
    expect(serializePattern(pattern()).schema).toBe(BANK_SCHEMA);
  });

  it('keeps the track-level PROB default', () => {
    expect(deserializePattern(serializePattern(pattern()), makeNote).trackProb).toBe(30);
  });

  it('loads a save made before track PROB existed at the box default', () => {
    const old = serializePattern(pattern());
    delete old.pattern.trackProb;
    expect(deserializePattern(old, makeNote).trackProb).toBe(100);
  });

  it('loads an entry saved before the feature existed, unlocked', () => {
    const old = serializePattern(pattern());
    for (const n of old.pattern.notes) { delete n.prob; delete n.fill; delete n.cond; }
    const back = deserializePattern(old, makeNote);
    expect(back.notes.every(n => n.prob === null && n.fill === null && n.cond === null)).toBe(true);
  });
});
