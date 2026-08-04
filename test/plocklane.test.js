import { describe, it, expect } from 'vitest';
import { makePLockLane } from '../js/state.js';

// The p-lock lane's rules, canvas-free — the triglane.test.js idiom. The module
// imports pianoroll.js for the grid geometry, which reaches for `window`, so the
// same DOM stubs that test uses are set up before the import.
globalThis.window ??= { devicePixelRatio: 1, addEventListener() {} };
globalThis.document ??= { createElement: () => ({ style: {}, classList: { toggle() {} } }) };

const {
  laneParam, laneIsEditable, laneReadOnlyReason, laneDisplayValue,
  valueFromRowY, barFraction, setLaneValue, clearLaneValue, describeLane, ROW_H, BAR_PAD,
} = await import('../js/plocklane.js');
const { paramTableFor } = await import('../js/elektron/param-tables.js');
const { paramByName, plainPlock } = await import('../js/elektron/params.js');

const CUTOFF = paramByName(paramTableFor('DT2'), 'filter.cutoff');
const PAN = paramByName(paramTableFor('DT2'), 'amp.pan');

// Give a real curated parameter a measured p-lock slot for the length of one
// test. Phase 0 landed 2026-08-04, so the shipped tables are already measured —
// this now exists to pin a *specific* id/scaling for a test's arithmetic.
function withMeasuredPlock(param, id, fn) {
  const saved = param.plock;
  param.plock = plainPlock(id);
  param.writable = true;
  try {
    return fn();
  } finally {
    param.plock = saved;
    param.writable = saved != null;
  }
}

// The inverse: strip the measurement for the length of one test, to exercise the
// draw-and-hear-but-can't-write state a future table entry (retrig) starts in.
function withUnmeasuredPlock(param, fn) {
  const saved = param.plock;
  param.plock = null;
  param.writable = false;
  try {
    return fn();
  } finally {
    param.plock = saved;
    param.writable = saved != null;
  }
}

const named = (name, byStep = {}, kind = 'DT2') => makePLockLane({
  name, deviceKind: kind, values: Array.from({ length: 128 }, (_, s) => byStep[s] ?? null),
});

const raw = (paramId, byStep = {}, trigless = false) => makePLockLane({
  paramId, deviceKind: 'DT2', trigless,
  values: Array.from({ length: 128 }, (_, s) => byStep[s] ?? null),
});

describe('which lanes may be edited', () => {
  it('opens up a curated parameter even before its p-lock slot is measured', () => {
    // The point of the whole audition path: a lane you can draw and hear before
    // anyone knows which byte the pattern format stores it in. The shipped
    // cutoff is measured now, so strip it back to that state for the test.
    withUnmeasuredPlock(CUTOFF, () => {
      const l = named('filter.cutoff');
      expect(laneIsEditable(l)).toBe(true);
      expect(laneReadOnlyReason(l)).toBe(null);
      expect(laneParam(l).label).toBe('FLTR CUTOFF');
      expect(laneParam(l).auditable).toBe(true);
      expect(laneParam(l).writable).toBe(false);
    });
  });

  it('opens up a measured parameter as fully writable', () => {
    const l = named('filter.cutoff');
    expect(laneIsEditable(l)).toBe(true);
    expect(laneParam(l).writable).toBe(true);
  });

  it('holds a lane off a box read-only while its paramId means nothing to us', () => {
    const l = raw(0x2a);
    expect(laneIsEditable(l)).toBe(false);
    expect(laneReadOnlyReason(l)).toMatch(/isn't a parameter digi-roll has mapped/);
    expect(laneParam(l).curated).toBe(false);
    expect(laneParam(l).label).toBe('DT2 param 0x2a');
  });

  it('recognises an imported lane once its paramId is measured', () => {
    withMeasuredPlock(CUTOFF, 0x14, () => {
      const l = raw(0x14);
      expect(laneIsEditable(l)).toBe(true);
      expect(laneParam(l).name).toBe('filter.cutoff');
    });
  });

  it('keeps a curated lane read-only when the box had trigless locks in it', () => {
    const l = makePLockLane({ name: 'filter.cutoff', deviceKind: 'DT2', trigless: true });
    expect(laneIsEditable(l)).toBe(false);
    expect(laneReadOnlyReason(l)).toMatch(/no trig/);
  });

  it('uses the right box\'s descriptor for the same knob', () => {
    expect(laneParam(named('amp.pan', {}, 'DT2')).midi.cc).toBe(90);
    expect(laneParam(named('amp.pan', {}, 'DN2')).midi.cc).toBe(89);
  });

  it('treats an unknown device kind as uncurated rather than throwing', () => {
    const l = makePLockLane({ name: 'filter.cutoff', deviceKind: 'DT3' });
    expect(laneIsEditable(l)).toBe(false);
  });
});

describe('values in and out', () => {
  it('reads a step\'s value straight off the lane\'s display axis', () => {
    const l = named('filter.cutoff', { 0: 0, 1: 64, 2: 127 });
    expect(laneDisplayValue(l, 0)).toBe(0);
    expect(laneDisplayValue(l, 1)).toBe(64);
    expect(laneDisplayValue(l, 2)).toBe(127);
    expect(laneDisplayValue(l, 3)).toBe(null);
  });

  it('writes across steps and reports whether anything moved', () => {
    const l = named('filter.cutoff');
    expect(setLaneValue(l, [1, 2, 3], 64)).toBe(true);
    expect(l.values.slice(1, 4)).toEqual([64, 64, 64]);
    expect(setLaneValue(l, [1, 2, 3], 64)).toBe(false); // no change, no undo entry
    expect(setLaneValue(l, [200], 64)).toBe(false);     // off the end of the lane
  });

  it('clamps a written value onto the MIDI range', () => {
    const l = named('filter.cutoff');
    setLaneValue(l, [0], 999);
    setLaneValue(l, [1], -50);
    expect(l.values[0]).toBe(127);
    expect(l.values[1]).toBe(0);
  });

  it('stores a zero rather than treating it as unlocked', () => {
    const l = named('filter.cutoff');
    setLaneValue(l, [4], 0);
    expect(l.values[4]).toBe(0);
    expect(laneDisplayValue(l, 4)).toBe(0);
  });

  it('clears steps', () => {
    const l = named('filter.cutoff', { 1: 10, 2: 20 });
    expect(clearLaneValue(l, [1])).toBe(true);
    expect(l.values[1]).toBe(null);
    expect(l.values[2]).toBe(20);
    expect(clearLaneValue(l, [1])).toBe(false);
  });
});

describe('the bar geometry', () => {
  it('reads the top of a row as the maximum and the bottom as the minimum', () => {
    expect(valueFromRowY(CUTOFF, 0, ROW_H)).toBe(127);
    expect(valueFromRowY(CUTOFF, ROW_H, ROW_H)).toBe(0);
    expect(valueFromRowY(CUTOFF, -20, ROW_H)).toBe(127);     // dragged above the row
    expect(valueFromRowY(CUTOFF, ROW_H * 3, ROW_H)).toBe(0);  // and below it
  });

  it('agrees with the drawing: the pointer sits on the bar it just set', () => {
    // The invariant that makes dragging feel right — grab a bar's top edge and
    // the value doesn't jump. Same geometry both ways, BAR_PAD included.
    const barTopY = (param, v) => ROW_H - barFraction(param, v) * (ROW_H - BAR_PAD);
    for (const param of [CUTOFF, PAN]) {
      for (const v of [0, 32, 64, 100, 127]) {
        expect(valueFromRowY(param, barTopY(param, v), ROW_H), `${param.name} ${v}`).toBe(v);
      }
    }
  });

  it('turns a value into a bar height between 0 and 1', () => {
    expect(barFraction(CUTOFF, 0)).toBe(0);
    expect(barFraction(CUTOFF, 127)).toBe(1);
    expect(barFraction(CUTOFF, 999)).toBe(1);
    expect(barFraction(CUTOFF, 64)).toBeCloseTo(0.504, 2);
  });

  it('knows which parameters are centred, so their bars can draw from the middle', () => {
    expect(PAN.bipolar).toBe(true);
    expect(CUTOFF.bipolar).toBe(false);
  });
});

describe('the panel\'s one-liner', () => {
  it('counts locked steps and marks a lane that can only be previewed', () => {
    withUnmeasuredPlock(CUTOFF, () => {
      expect(describeLane(named('filter.cutoff', { 1: 1 })))
        .toBe('FLTR CUTOFF · 1 step · preview only');
      expect(describeLane(named('filter.cutoff'))).toBe('FLTR CUTOFF · 0 steps · preview only');
    });
  });

  it('drops the marker once the parameter can actually be written', () => {
    expect(describeLane(named('filter.cutoff', { 1: 1, 2: 2 }))).toBe('FLTR CUTOFF · 2 steps');
  });

  it('says read-only for a lane off a box we can\'t identify', () => {
    expect(describeLane(raw(0x2a, { 1: 1, 2: 2 }))).toBe('DT2 param 0x2a · 2 steps · read-only');
  });
});
