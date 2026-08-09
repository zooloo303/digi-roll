import { describe, it, expect } from 'vitest';
import {
  mulberry32, hashTag, rngFor, chance, range, intRange, pick, weighted, sampleWeighted, shuffle,
} from '../js/gen/rng.js';

// The generator's whole reproducibility story rests on this file: same seed ⇒
// same music, and one part's stream never disturbing another's.

const take = (rng, n) => Array.from({ length: n }, () => rng());

describe('the PRNG', () => {
  it('gives the same sequence for the same seed', () => {
    expect(take(mulberry32(12345), 8)).toEqual(take(mulberry32(12345), 8));
  });

  it('gives a different sequence for a neighbouring seed', () => {
    expect(take(mulberry32(12345), 8)).not.toEqual(take(mulberry32(12346), 8));
  });

  it('stays inside [0, 1)', () => {
    for (const v of take(mulberry32(7), 500)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('per-part streams', () => {
  it('are independent: a different tag is a different stream', () => {
    expect(take(rngFor(99, 'bass'), 12)).not.toEqual(take(rngFor(99, 'lead'), 12));
  });

  it('are reproducible: same seed and tag, same stream', () => {
    expect(take(rngFor(99, 'lead'), 12)).toEqual(take(rngFor(99, 'lead'), 12));
  });

  it('do not march in step for adjacent seeds or adjacent tags', () => {
    // The failure this guards against is a derivation like `seed + tag.length`,
    // where two streams differ only by their starting point and so produce the
    // same numbers one draw apart.
    const a = take(rngFor(1000, 'bass'), 20);
    const b = take(rngFor(1001, 'bass'), 20);
    const c = take(rngFor(1000, 'bass2'), 20);
    expect(a.slice(1)).not.toEqual(b.slice(0, 19));
    expect(a.slice(1)).not.toEqual(c.slice(0, 19));
  });

  it('hashes tags to distinct stream ids', () => {
    const ids = new Set(['bass', 'chords', 'lead', 'bass.lanes', 'chords.lanes', 'lead.lanes']
      .map(t => hashTag(t, 4242)));
    expect(ids.size).toBe(6);
  });
});

describe('the helpers', () => {
  it('chance(0) never fires and chance(1) always does', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      expect(chance(rng, 0)).toBe(false);
      expect(chance(rng, 1)).toBe(true);
    }
  });

  it('range and intRange stay in bounds, intRange inclusive at both ends', () => {
    const rng = mulberry32(5);
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      const f = range(rng, -3, 3);
      expect(f).toBeGreaterThanOrEqual(-3);
      expect(f).toBeLessThanOrEqual(3);
      const n = intRange(rng, 1, 4);
      expect(Number.isInteger(n)).toBe(true);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('pick returns null for nothing and a member otherwise', () => {
    const rng = mulberry32(9);
    expect(pick(rng, [])).toBe(null);
    expect(['a', 'b', 'c']).toContain(pick(rng, ['a', 'b', 'c']));
  });

  it('weighted never returns a zero-weight item while a positive one exists', () => {
    const rng = mulberry32(11);
    const items = [{ id: 'no', weight: 0 }, { id: 'yes', weight: 1 }];
    for (let i = 0; i < 200; i++) expect(weighted(rng, items).id).toBe('yes');
  });

  it('weighted falls back to uniform when every weight is zero', () => {
    const rng = mulberry32(13);
    const items = [{ id: 'a', weight: 0 }, { id: 'b', weight: 0 }];
    expect(items).toContain(weighted(rng, items));
  });

  it('weighted follows the weights over many draws', () => {
    const rng = mulberry32(17);
    const items = [{ id: 'rare', weight: 1 }, { id: 'common', weight: 9 }];
    let common = 0;
    for (let i = 0; i < 2000; i++) if (weighted(rng, items).id === 'common') common++;
    expect(common).toBeGreaterThan(1600);
    expect(common).toBeLessThan(1980);
  });
});

describe('sampleWeighted — N distinct, weighted', () => {
  const steps = Array.from({ length: 16 }, (_, step) => ({ step, weight: step % 4 === 0 ? 1 : 0.1 }));

  it('returns exactly N distinct items', () => {
    const got = sampleWeighted(mulberry32(21), steps, 6);
    expect(got.length).toBe(6);
    expect(new Set(got.map(s => s.step)).size).toBe(6);
  });

  it('never returns a zero-weight item', () => {
    const mixed = [{ id: 'a', weight: 0 }, { id: 'b', weight: 1 }, { id: 'c', weight: 0 }];
    expect(sampleWeighted(mulberry32(22), mixed, 3).map(i => i.id)).toEqual(['b']);
  });

  it('caps at the number of usable items rather than padding', () => {
    expect(sampleWeighted(mulberry32(23), steps, 99).length).toBe(16);
    expect(sampleWeighted(mulberry32(23), steps, 0)).toEqual([]);
    expect(sampleWeighted(mulberry32(23), [], 4)).toEqual([]);
  });

  it('favours the heavy items', () => {
    // The four beats have 10× the weight of the sixteenths between them, so a
    // four-of-sixteen draw should keep landing on them.
    let onBeat = 0;
    const rng = mulberry32(24);
    for (let i = 0; i < 200; i++) {
      onBeat += sampleWeighted(rng, steps, 4).filter(s => s.step % 4 === 0).length;
    }
    expect(onBeat / 800).toBeGreaterThan(0.7);
  });

  it('is deterministic for a seed', () => {
    const a = sampleWeighted(mulberry32(25), steps, 5).map(s => s.step);
    const b = sampleWeighted(mulberry32(25), steps, 5).map(s => s.step);
    expect(a).toEqual(b);
  });
});

describe('shuffle', () => {
  it('keeps every member and leaves the input alone', () => {
    const input = [1, 2, 3, 4, 5, 6];
    const out = shuffle(mulberry32(31), input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
  });
});
