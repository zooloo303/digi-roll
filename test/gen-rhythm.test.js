import { describe, it, expect } from 'vitest';
import {
  rhythmFor, trigCountFor, velocityFor, microFor, gapAfter, trigFeelFor,
  snapMicro, MICRO_TICK, isBeat,
} from '../js/gen/rhythm.js';
import { mulberry32 } from '../js/gen/rng.js';
import { isCondKey } from '../js/elektron/conditions.js';
import { GENRES } from '../js/gen/genres.js';

const EVEN = new Array(16).fill(1);
const BEATS_ONLY = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 1 : 0));
const rng = seed => mulberry32(seed);

describe('how many trigs a density asks for', () => {
  it('runs from the genre\'s own floor to its ceiling', () => {
    expect(trigCountFor({ trigsPerBar: [2, 8], density: 0, bars: 1 })).toBe(2);
    expect(trigCountFor({ trigsPerBar: [2, 8], density: 100, bars: 1 })).toBe(8);
    expect(trigCountFor({ trigsPerBar: [2, 8], density: 50, bars: 2 })).toBe(10);
  });

  it('never asks for silence — that is the checkbox\'s job, not the slider\'s', () => {
    expect(trigCountFor({ trigsPerBar: [0, 4], density: 0, bars: 1 })).toBe(1);
  });

  it('rises with density and with bars', () => {
    let last = 0;
    for (const density of [0, 25, 50, 75, 100]) {
      const n = trigCountFor({ trigsPerBar: [2, 10], density, bars: 2 });
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });
});

describe('the trig list', () => {
  it('is deterministic for a seed', () => {
    const opts = { weights: EVEN, trigsPerBar: [4, 8], density: 60, bars: 2 };
    const a = rhythmFor({ ...opts, rng: rng(5) }).map(t => t.step);
    const b = rhythmFor({ ...opts, rng: rng(5) }).map(t => t.step);
    expect(a).toEqual(b);
    expect(a).not.toEqual(rhythmFor({ ...opts, rng: rng(6) }).map(t => t.step));
  });

  it('is ascending, distinct and inside the pattern', () => {
    for (let seed = 0; seed < 20; seed++) {
      const trigs = rhythmFor({
        weights: EVEN, trigsPerBar: [4, 12], density: 80, bars: 2, rng: rng(seed),
      });
      const steps = trigs.map(t => t.step);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
      expect(new Set(steps).size).toBe(steps.length);
      for (const s of steps) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(32);
      }
    }
  });

  it('never puts a trig on a zero-weight step', () => {
    for (let seed = 0; seed < 20; seed++) {
      const trigs = rhythmFor({
        weights: BEATS_ONLY, trigsPerBar: [4, 16], density: 100, bars: 2, rng: rng(seed),
      });
      for (const t of trigs) expect(t.step % 4).toBe(0);
    }
  });

  it('always keeps its anchors, at any density', () => {
    for (const density of [0, 50, 100]) {
      const trigs = rhythmFor({
        weights: EVEN, trigsPerBar: [1, 8], density, bars: 2, rng: rng(3), anchors: [0],
      });
      expect(trigs.map(t => t.step)).toContain(0);
      expect(trigs.find(t => t.step === 0).accent).toBe(true);
    }
  });

  it('marks beats as accents and low-weight off-beats as ghosts', () => {
    const weights = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 1 : 0.2));
    const trigs = rhythmFor({
      weights, trigsPerBar: [8, 16], density: 100, bars: 1, rng: rng(4),
    });
    for (const t of trigs) {
      if (t.step % 4 === 0) {
        expect(t.accent).toBe(true);
        expect(t.ghost).toBe(false);
      } else {
        expect(t.ghost).toBe(true);
      }
    }
  });

  it('avoids steps another part owns, in proportion to `avoid`', () => {
    // The lead's rule: with a full penalty it should land off the bass's steps
    // far more often than on them.
    const busy = new Set([0, 2, 4, 6, 8, 10, 12, 14]);
    let collisions = 0;
    let free = 0;
    for (let seed = 0; seed < 60; seed++) {
      const trigs = rhythmFor({
        weights: EVEN, trigsPerBar: [4, 4], density: 50, bars: 1, rng: rng(seed),
        busy, avoid: 0.85,
      });
      for (const t of trigs) (busy.has(t.step) ? collisions++ : free++);
    }
    expect(free).toBeGreaterThan(collisions * 3);
  });

  it('tags each trig with its bar', () => {
    const trigs = rhythmFor({
      weights: EVEN, trigsPerBar: [8, 8], density: 100, bars: 2, rng: rng(8),
    });
    for (const t of trigs) expect(t.bar).toBe(Math.floor(t.step / 16));
  });
});

describe('dynamics', () => {
  const velocity = { accent: 120, normal: 100, ghost: 60 };

  it('uses the profile\'s exact levels when Humanize is 0', () => {
    const r = rng(1);
    expect(velocityFor({ accent: true, ghost: false }, { velocity, humanize: 0, rng: r })).toBe(120);
    expect(velocityFor({ accent: false, ghost: false }, { velocity, humanize: 0, rng: r })).toBe(100);
    expect(velocityFor({ accent: false, ghost: true }, { velocity, humanize: 0, rng: r })).toBe(60);
  });

  it('wobbles with Humanize but stays a legal velocity', () => {
    const r = rng(2);
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      const v = velocityFor({ accent: false, ghost: false }, { velocity, humanize: 100, rng: r });
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(127);
      seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('clamps a hot accent rather than sending 130', () => {
    const r = rng(3);
    for (let i = 0; i < 200; i++) {
      expect(velocityFor({ accent: true }, {
        velocity: { accent: 127, normal: 120, ghost: 90 }, humanize: 100, rng: r,
      })).toBeLessThanOrEqual(127);
    }
  });
});

describe('groove micro-timing', () => {
  it('snaps to the 1/24-step grid the boxes store', () => {
    for (const m of [0.1, -0.1, 0.333, 0.49, -0.49, 0]) {
      const snapped = snapMicro(m);
      expect(Math.abs(snapped / MICRO_TICK - Math.round(snapped / MICRO_TICK))).toBeLessThan(1e-9);
    }
  });

  it('clamps to what a micro byte can hold (±23/24)', () => {
    expect(snapMicro(5)).toBeCloseTo(23 / 24, 10);
    expect(snapMicro(-5)).toBeCloseTo(-23 / 24, 10);
  });

  it('is exactly the genre\'s groove when Humanize is 0', () => {
    const groove = GENRES.house.groove; // shuffle: off-16ths pushed late
    const r = rng(7);
    expect(microFor(0, { groove, humanize: 0, rng: r })).toBe(0);
    expect(microFor(1, { groove, humanize: 0, rng: r })).toBeCloseTo(snapMicro(groove[1]), 10);
    // …and it repeats per bar, so bar 2 shuffles like bar 1
    expect(microFor(17, { groove, humanize: 0, rng: r }))
      .toBeCloseTo(microFor(1, { groove, humanize: 0, rng: r }), 10);
  });

  it('stays inside the roll\'s own range with Humanize at full', () => {
    const r = rng(9);
    for (let step = 0; step < 32; step++) {
      const m = microFor(step, { groove: GENRES.breaks.groove, humanize: 100, rng: r });
      expect(m).toBeGreaterThan(-1);
      expect(m).toBeLessThan(1);
    }
  });
});

describe('the gap to the next trig', () => {
  const trigs = [{ step: 0 }, { step: 4 }, { step: 6 }];
  it('measures to the next trig, and to the end for the last', () => {
    expect(gapAfter(trigs, 0, 16)).toBe(4);
    expect(gapAfter(trigs, 1, 16)).toBe(2);
    expect(gapAfter(trigs, 2, 16)).toBe(10);
  });
});

describe('per-trig conditions', () => {
  const trigs = [
    { step: 0, bar: 0, accent: true, ghost: false },
    { step: 3, bar: 0, accent: false, ghost: true },
    { step: 6, bar: 0, accent: false, ghost: false },
    { step: 18, bar: 1, accent: false, ghost: true },
    { step: 20, bar: 1, accent: true, ghost: false },
  ];
  const recipe = [
    { kind: 'altBar', chance: 1 },
    { kind: 'probGhost', chance: 1, range: [60, 85] },
    { kind: 'fill', chance: 1, mode: 'on' },
  ];

  it('writes nothing at all at Looseness 0', () => {
    expect(trigFeelFor(trigs, { recipe, looseness: 0, bars: 2, rng: rng(1) }).size).toBe(0);
  });

  it('only reports steps that actually got a lock', () => {
    const feel = trigFeelFor(trigs, {
      recipe: [{ kind: 'probGhost', chance: 1, range: [70, 70] }], looseness: 100, bars: 2, rng: rng(2),
    });
    expect([...feel.keys()].sort((a, b) => a - b)).toEqual([3, 18]);
    expect(feel.get(3)).toMatchObject({ prob: 70, fill: null, cond: null });
  });

  it('alternates bars so a two-bar loop is not two identical bars', () => {
    const feel = trigFeelFor(trigs, {
      recipe: [{ kind: 'altBar', chance: 1 }], looseness: 100, bars: 2, rng: rng(3),
    });
    expect(feel.get(0).cond).toBe('1:2');
    expect(feel.get(18).cond).toBe('2:2');
  });

  it('leaves alternation alone in a one-bar pattern, where 1:2 would just mute half the loops', () => {
    const feel = trigFeelFor(trigs.slice(0, 3), {
      recipe: [{ kind: 'altBar', chance: 1 }], looseness: 100, bars: 1, rng: rng(4),
    });
    expect(feel.size).toBe(0);
  });

  it('keeps PROB inside the recipe\'s range', () => {
    const feel = trigFeelFor(trigs, {
      recipe: [{ kind: 'probWeak', chance: 1, range: [60, 85] }], looseness: 100, bars: 2, rng: rng(5),
    });
    for (const [, s] of feel) {
      expect(s.prob).toBeGreaterThanOrEqual(60);
      expect(s.prob).toBeLessThanOrEqual(85);
    }
  });

  it('never touches an accent with FILL or a ratio, so the groove survives a fill', () => {
    const feel = trigFeelFor(trigs, {
      recipe: [
        { kind: 'fill', chance: 1, mode: 'on' },
        { kind: 'everyFourth', chance: 1, keys: ['3:4'] },
        { kind: 'logic', chance: 1, keys: ['PRE'] },
      ],
      looseness: 100, bars: 2, rng: rng(6),
    });
    expect(feel.has(0)).toBe(false);
    expect(feel.has(20)).toBe(false);
  });

  it('gives a step at most one COND and one FILL, and only conditions the box knows', () => {
    for (let seed = 0; seed < 30; seed++) {
      const feel = trigFeelFor(trigs, { recipe, looseness: 100, bars: 2, rng: rng(seed) });
      for (const [, s] of feel) {
        if (s.cond != null) expect(isCondKey(s.cond)).toBe(true);
        if (s.fill != null) expect(typeof s.fill).toBe('boolean');
        if (s.prob != null) expect(Number.isInteger(s.prob)).toBe(true);
      }
    }
  });

  it('writes every condition every genre asks for as a key the hardware table has', () => {
    // A typo in a recipe would otherwise only show up when a write threw.
    const many = Array.from({ length: 32 }, (_, i) => ({
      step: i, bar: Math.floor(i / 16), accent: false, ghost: i % 3 === 0,
    }));
    for (const genre of Object.values(GENRES)) {
      for (const role of Object.values(genre.roles)) {
        const feel = trigFeelFor(many, {
          recipe: role.conditions, looseness: 100, bars: 2, rng: rng(11),
        });
        for (const [, s] of feel) if (s.cond != null) expect(isCondKey(s.cond)).toBe(true);
      }
    }
  });
});

describe('isBeat', () => {
  it('is the four quarters of a bar', () => {
    expect([0, 4, 8, 12, 16, 20].every(isBeat)).toBe(true);
    expect([1, 2, 3, 5, 6, 7, 15].some(isBeat)).toBe(false);
  });
});
