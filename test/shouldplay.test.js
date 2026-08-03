import { describe, it, expect } from 'vitest';
import { shouldPlay } from '../js/midi.js';

// The browser preview's evaluation of trig conditions. It is deliberately
// partial — see the comment on shouldPlay — and the rule that matters is that
// whatever it cannot simulate still plays, so the preview is never quieter
// than the box.
const note = (extra = {}) => ({ prob: null, fill: null, cond: null, ...extra });
const always = () => 0;    // rng that always passes a probability check
const never = () => 0.999; // rng that fails anything under 100%

describe('an unlocked note', () => {
  it('always plays', () => {
    for (const loop of [0, 1, 2, 7]) expect(shouldPlay(note(), loop, never)).toBe(true);
  });
});

describe('probability', () => {
  it('plays when the roll comes in under the odds', () => {
    expect(shouldPlay(note({ prob: 50 }), 0, () => 0.49)).toBe(true);
  });

  it('is silenced when the roll comes in over', () => {
    expect(shouldPlay(note({ prob: 50 }), 0, () => 0.5)).toBe(false);
  });

  it('never plays at 0 and always plays at 100', () => {
    expect(shouldPlay(note({ prob: 0 }), 0, () => 0)).toBe(false);
    expect(shouldPlay(note({ prob: 100 }), 0, () => 0.999)).toBe(true);
  });

  it('combines with a condition rather than replacing it', () => {
    // 2:4 is false on loop 0, so it stays silent even with the odds passing.
    expect(shouldPlay(note({ prob: 100, cond: '2:4' }), 0, always)).toBe(false);
    expect(shouldPlay(note({ prob: 100, cond: '2:4' }), 1, always)).toBe(true);
    // ...and passes the condition but fails the dice.
    expect(shouldPlay(note({ prob: 50, cond: '2:4' }), 1, never)).toBe(false);
  });
});

describe('the track-level PROB default', () => {
  it('is what a trig with no lock of its own runs at', () => {
    expect(shouldPlay(note(), 0, () => 0.29, 30)).toBe(true);
    expect(shouldPlay(note(), 0, () => 0.30, 30)).toBe(false);
  });

  it('is overridden by an explicit lock, in either direction', () => {
    // The user's case: a 30% track with a few trigs pinned at 100.
    expect(shouldPlay(note({ prob: 100 }), 0, never, 30)).toBe(true);
    expect(shouldPlay(note({ prob: 0 }), 0, always, 100)).toBe(false);
  });

  it('defaults to always, so callers that don\'t model it behave as before', () => {
    expect(shouldPlay(note(), 0, never)).toBe(true);
    expect(shouldPlay(note(), 0, never, 100)).toBe(true);
  });

  it('silences an unlocked trig entirely at 0', () => {
    expect(shouldPlay(note(), 0, () => 0, 0)).toBe(false);
  });

  it('still lets the condition have its say', () => {
    // Track odds pass, but 2:4 is false on loop 0.
    expect(shouldPlay(note({ cond: '2:4' }), 0, always, 50)).toBe(false);
    expect(shouldPlay(note({ cond: '2:4' }), 1, always, 50)).toBe(true);
  });
});

describe('ratio conditions', () => {
  const plays = (cond, loops) => loops.filter(l => shouldPlay(note({ cond }), l, always));

  it('plays 1:2 on every other loop, starting with the first', () => {
    expect(plays('1:2', [0, 1, 2, 3, 4, 5])).toEqual([0, 2, 4]);
  });

  it('plays 2:2 on the off loops', () => {
    expect(plays('2:2', [0, 1, 2, 3, 4, 5])).toEqual([1, 3, 5]);
  });

  it('plays 2:4 on loop 2 of every 4', () => {
    expect(plays('2:4', [0, 1, 2, 3, 4, 5, 6, 7])).toEqual([1, 5]);
  });

  it('plays a negated ratio on exactly the loops the positive skips', () => {
    const loops = [0, 1, 2, 3, 4, 5, 6, 7];
    for (const cond of ['1:2', '2:4', '3:5', '8:8']) {
      const yes = new Set(plays(cond, loops));
      const no = new Set(plays(`!${cond}`, loops));
      expect([...yes].some(l => no.has(l)), cond).toBe(false);
      expect(yes.size + no.size).toBe(loops.length);
    }
  });

  it('plays 1:1-style full-cycle conditions every loop', () => {
    expect(plays('8:8', [7, 15, 23])).toEqual([7, 15, 23]);
  });
});

describe('first-loop conditions', () => {
  it('plays 1ST only on the first pass', () => {
    expect(shouldPlay(note({ cond: '1ST' }), 0, always)).toBe(true);
    expect(shouldPlay(note({ cond: '1ST' }), 1, always)).toBe(false);
  });

  it('plays !1ST on every pass but the first', () => {
    expect(shouldPlay(note({ cond: '!1ST' }), 0, always)).toBe(false);
    expect(shouldPlay(note({ cond: '!1ST' }), 3, always)).toBe(true);
  });
});

describe('what the browser cannot simulate', () => {
  it('plays PRE, NEI and LST rather than guessing', () => {
    for (const cond of ['PRE', '!PRE', 'NEI', '!NEI', 'LST', '!LST']) {
      for (const loop of [0, 1, 5]) {
        expect(shouldPlay(note({ cond }), loop, always), `${cond} @ ${loop}`).toBe(true);
      }
    }
  });

  it('ignores fill entirely — there is no FILL button here', () => {
    expect(shouldPlay(note({ fill: true }), 0, always)).toBe(true);
    expect(shouldPlay(note({ fill: false }), 0, always)).toBe(true);
  });

  it('still applies probability to a note whose condition it cannot evaluate', () => {
    expect(shouldPlay(note({ cond: 'PRE', prob: 50 }), 0, never)).toBe(false);
  });
});
