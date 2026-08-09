import { describe, it, expect } from 'vitest';
import { makeMotif, developMotif, motifPlan, thinMotif, MOTIF_VARIANTS } from '../js/gen/motif.js';
import { mulberry32 } from '../js/gen/rng.js';
import { GENRES } from '../js/gen/genres.js';

const rng = seed => mulberry32(seed);
const WEIGHTS = GENRES.dnb.roles.lead.weights;

describe('making a motif', () => {
  it('is deterministic for a seed', () => {
    const a = makeMotif(rng(1), { notes: [3, 5], window: 8, weights: WEIGHTS });
    const b = makeMotif(rng(1), { notes: [3, 5], window: 8, weights: WEIGHTS });
    expect(a).toEqual(b);
  });

  it('respects the note count and the phrase window', () => {
    for (let seed = 0; seed < 30; seed++) {
      const m = makeMotif(rng(seed), { notes: [3, 5], window: 8, weights: WEIGHTS });
      expect(m.length).toBeGreaterThanOrEqual(1);
      expect(m.length).toBeLessThanOrEqual(5);
      for (const n of m) {
        expect(n.step).toBeGreaterThanOrEqual(0);
        expect(n.step).toBeLessThan(8);
        expect(n.len).toBeGreaterThan(0);
      }
      // ascending and distinct: a motif is a line, not a chord
      const steps = m.map(n => n.step);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
      expect(new Set(steps).size).toBe(steps.length);
    }
  });

  it('keeps its contour within reach — a melody, not a series of leaps', () => {
    for (let seed = 0; seed < 30; seed++) {
      const m = makeMotif(rng(seed), { notes: [4, 6], window: 8, weights: WEIGHTS, spread: 2 });
      for (const n of m) expect(Math.abs(n.deg)).toBeLessThanOrEqual(5);
      for (let i = 1; i < m.length; i++) expect(Math.abs(m[i].deg - m[i - 1].deg)).toBeLessThanOrEqual(2);
    }
  });

  it('never produces an empty motif, even from a window with nothing in it', () => {
    const m = makeMotif(rng(4), { notes: [3, 4], window: 4, weights: new Array(16).fill(0) });
    expect(m.length).toBeGreaterThanOrEqual(1);
  });

  it('always starts the phrase, so the idea is recognisable', () => {
    // Step 0 carries a weight floor precisely so the motif states itself on the 1.
    let onOne = 0;
    for (let seed = 0; seed < 40; seed++) {
      if (makeMotif(rng(seed), { notes: [3, 5], window: 8, weights: WEIGHTS })[0].step === 0) onOne++;
    }
    expect(onOne).toBeGreaterThan(20);
  });
});

describe('developing a motif', () => {
  const motif = [
    { step: 0, deg: 0, len: 1 },
    { step: 2, deg: 1, len: 1 },
    { step: 4, deg: 3, len: 2 },
  ];

  it('repeat gives back the same idea, as a copy', () => {
    const out = developMotif(motif, 'repeat', { window: 8, rng: rng(1) });
    expect(out).toEqual(motif);
    expect(out[0]).not.toBe(motif[0]);
  });

  it('transpose moves every degree by the same amount, keeping the rhythm', () => {
    const out = developMotif(motif, 'transpose', { window: 8, rng: rng(2) });
    expect(out.map(n => n.step)).toEqual([0, 2, 4]);
    const deltas = out.map((n, i) => n.deg - motif[i].deg);
    expect(new Set(deltas).size).toBe(1);
    expect(deltas[0]).not.toBe(0);
  });

  it('invert mirrors around the first note, so the phrase opens the same way', () => {
    const out = developMotif(motif, 'invert', { window: 8, rng: rng(3) });
    expect(out[0].deg).toBe(motif[0].deg);
    expect(out.map(n => n.deg)).toEqual([0, -1, -3]);
  });

  it('retrograde reverses the tune over the same rhythm', () => {
    const out = developMotif(motif, 'retrograde', { window: 8, rng: rng(4) });
    expect(out.map(n => n.step)).toEqual([0, 2, 4]);
    expect(out.map(n => n.deg)).toEqual([3, 1, 0]);
  });

  it('displace pushes the whole phrase later and drops what falls off the end', () => {
    const out = developMotif(motif, 'displace', { window: 5, rng: rng(5) });
    for (const n of out) expect(n.step).toBeLessThan(5);
    expect(out.length).toBeLessThan(motif.length);
    expect(out[0].step).toBeGreaterThan(0);
  });

  it('sparse thins the idea but always keeps its first note', () => {
    for (let seed = 0; seed < 20; seed++) {
      const out = developMotif(motif, 'sparse', { window: 8, rng: rng(seed) });
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out.length).toBeLessThan(motif.length + 1);
      expect(out[0]).toMatchObject({ step: 0, deg: 0 });
    }
  });

  it('leaves the input untouched, whatever the variant', () => {
    const before = JSON.stringify(motif);
    for (const v of MOTIF_VARIANTS) developMotif(motif, v, { window: 8, rng: rng(6) });
    expect(JSON.stringify(motif)).toBe(before);
  });

  it('treats an unknown variant as a repeat rather than throwing', () => {
    expect(developMotif(motif, 'nonsense', { window: 8, rng: rng(7) })).toEqual(motif);
  });
});

describe('the development plan', () => {
  it('states the motif plainly first', () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(motifPlan(rng(seed), 4, 50)[0]).toBe('repeat');
    }
  });

  it('is one variant per phrase, all known', () => {
    const plan = motifPlan(rng(2), 8, 60);
    expect(plan.length).toBe(8);
    for (const v of plan) expect(MOTIF_VARIANTS).toContain(v);
  });

  it('never repeats twice in a row', () => {
    for (let seed = 0; seed < 30; seed++) {
      const plan = motifPlan(rng(seed), 8, 50);
      for (let i = 1; i < plan.length; i++) {
        if (plan[i - 1] === 'repeat') expect(plan[i]).not.toBe('repeat');
      }
    }
  });

  it('reaches further at high Looseness than at low', () => {
    const far = new Set(['invert', 'retrograde', 'displace']);
    const count = looseness => {
      let n = 0;
      for (let seed = 0; seed < 60; seed++) {
        n += motifPlan(rng(seed), 8, looseness).filter(v => far.has(v)).length;
      }
      return n;
    };
    expect(count(100)).toBeGreaterThan(count(5) * 2);
  });

  it('is deterministic for a seed', () => {
    expect(motifPlan(rng(9), 6, 40)).toEqual(motifPlan(rng(9), 6, 40));
  });
});

describe('thinning by density', () => {
  const motif = [0, 1, 2, 3, 4, 5].map(step => ({ step, deg: step % 3, len: 1 }));

  it('keeps more at high density than at low', () => {
    const at = d => thinMotif(motif, d, rng(3)).length;
    expect(at(100)).toBeGreaterThanOrEqual(at(0));
    expect(at(0)).toBeGreaterThanOrEqual(1);
  });

  it('keeps the first note and stays in order', () => {
    for (let seed = 0; seed < 20; seed++) {
      const out = thinMotif(motif, 30, rng(seed));
      expect(out[0].step).toBe(0);
      expect(out.map(n => n.step)).toEqual([...out.map(n => n.step)].sort((a, b) => a - b));
    }
  });

  it('leaves a one-note motif alone', () => {
    const one = [{ step: 0, deg: 0, len: 1 }];
    expect(thinMotif(one, 0, rng(1))).toEqual(one);
  });
});
