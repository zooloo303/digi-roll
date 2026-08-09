import { describe, it, expect } from 'vitest';
import { designLanes, lanesWanted, LANE_SHAPES, laneValuesFor } from '../js/gen/plockdesign.js';
import { GENRES, GENRE_IDS } from '../js/gen/genres.js';
import { mulberry32 } from '../js/gen/rng.js';
import { PLOCK_STEPS } from '../js/state.js';
import { writableParamsFor, DEVICE_KINDS } from '../js/elektron/param-tables.js';
import { paramTableFor } from '../js/elektron/param-tables.js';
import { rollPLocksToDevice } from '../js/roll-bridge.js';
import { MIDI_MIN, MIDI_MAX } from '../js/elektron/params.js';

const rng = seed => mulberry32(seed);

const trigsAt = (...steps) => steps.map(step => ({
  step, bar: Math.floor(step / 16), accent: step % 4 === 0, ghost: false, weight: 1,
}));

const TRIGS = trigsAt(0, 3, 6, 8, 11, 14, 16, 20, 22, 27);
const ROLE = GENRES.dnb.roles.bass;

describe('when the generator refuses to make lanes', () => {
  it('makes none at Motion 0 — the slider\'s off position means off', () => {
    const { lanes } = designLanes({
      role: ROLE, deviceKind: 'DT2', trigs: TRIGS, total: 32, motion: 0, rng: rng(1),
    });
    expect(lanes).toEqual([]);
  });

  it('makes none with no resolvable box, and says why', () => {
    const { lanes, warnings } = designLanes({
      role: ROLE, deviceKind: null, trigs: TRIGS, total: 32, motion: 100, rng: rng(2),
    });
    expect(lanes).toEqual([]);
    expect(warnings.join(' ')).toMatch(/can't tell which box/);
  });

  it('makes none for a part with no trigs', () => {
    const { lanes } = designLanes({
      role: ROLE, deviceKind: 'DN2', trigs: [], total: 32, motion: 100, rng: rng(3),
    });
    expect(lanes).toEqual([]);
  });

  it('makes none for a box whose parameters are not measured', () => {
    const { lanes, warnings } = designLanes({
      role: ROLE, deviceKind: 'SOMETHING_ELSE', trigs: TRIGS, total: 32, motion: 100, rng: rng(4),
    });
    expect(lanes).toEqual([]);
    expect(warnings.join(' ')).toMatch(/measured parameters/);
  });
});

describe('how many lanes Motion asks for', () => {
  it('is none at 0, and everything in the recipe at 100', () => {
    const recipes = [1, 2, 3];
    expect(lanesWanted(recipes, 0)).toBe(0);
    expect(lanesWanted(recipes, 100)).toBe(3);
  });

  it('rises with Motion and always leaves at least one lane once it is on', () => {
    let last = 0;
    for (const motion of [1, 25, 50, 75, 100]) {
      const n = lanesWanted([1, 2, 3], motion);
      expect(n).toBeGreaterThanOrEqual(Math.max(1, last));
      last = n;
    }
  });
});

describe.each(DEVICE_KINDS)('lanes for a %s', kind => {
  const writable = new Set(writableParamsFor(kind).map(p => p.name));

  it('only ever automates a parameter measured on that box', () => {
    for (const genre of GENRE_IDS) {
      for (const role of Object.values(GENRES[genre].roles)) {
        const { lanes } = designLanes({
          role, deviceKind: kind, trigs: TRIGS, total: 32, motion: 100, rng: rng(7),
        });
        for (const lane of lanes) {
          expect(writable.has(lane.name), `${lane.name} on ${kind}`).toBe(true);
          expect(lane.deviceKind).toBe(kind);
        }
      }
    }
  });

  it('holds values only on steps that have trigs — the v1 p-lock rule', () => {
    const live = new Set(TRIGS.map(t => t.step));
    const { lanes } = designLanes({
      role: ROLE, deviceKind: kind, trigs: TRIGS, total: 32, motion: 80, rng: rng(8),
    });
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      expect(lane.values.length).toBe(PLOCK_STEPS);
      lane.values.forEach((v, step) => {
        if (v != null) expect(live.has(step), `value on trigless step ${step}`).toBe(true);
      });
      expect(lane.values.filter(v => v != null).length).toBe(live.size);
    }
  });

  it('stays on the MIDI display axis, in whole steps', () => {
    for (const motion of [10, 50, 100]) {
      const { lanes } = designLanes({
        role: ROLE, deviceKind: kind, trigs: TRIGS, total: 32, motion, rng: rng(9),
      });
      for (const lane of lanes) {
        for (const v of lane.values.filter(x => x != null)) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(MIDI_MIN);
          expect(v).toBeLessThanOrEqual(MIDI_MAX);
        }
      }
    }
  });

  it('produces lanes the existing write seam accepts without a warning', () => {
    // The safety story in one test: what the generator makes goes to the box
    // through rollPLocksToDevice untouched, so nothing here may be un-writable.
    const { lanes } = designLanes({
      role: ROLE, deviceKind: kind, trigs: TRIGS, total: 32, motion: 100, rng: rng(10),
    });
    const asRollLanes = lanes.map(l => ({ ...l, paramId: null, trigless: false }));
    const { lanes: out, warnings } = rollPLocksToDevice(asRollLanes, kind);
    expect(warnings).toEqual([]);
    expect(out.length).toBe(lanes.length);
    for (const l of out) {
      expect(Number.isInteger(l.paramId)).toBe(true);
      for (const w of l.values.filter(v => v != null)) {
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(0xffff);
      }
    }
  });
});

describe('the lane shapes', () => {
  it('all stay inside 0..1 across a whole pattern', () => {
    for (const [name, shape] of Object.entries(LANE_SHAPES)) {
      for (let step = 0; step < 32; step++) {
        const v = shape(step / 31, { step, accent: step % 4 === 0, ghost: false, walk: 0.5 });
        expect(v, name).toBeGreaterThanOrEqual(0);
        expect(v, name).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rise really does open across the pattern', () => {
    const values = laneValuesFor({
      recipe: { name: 'filter.cutoff', shape: 'rise', from: 20, to: 100 },
      trigs: TRIGS, total: 32, motion: 100, rng: rng(11),
    });
    expect(values.at(-1).value).toBeGreaterThan(values[0].value);
  });

  it('fall closes across it', () => {
    const values = laneValuesFor({
      recipe: { name: 'filter.cutoff', shape: 'fall', from: 20, to: 100 },
      trigs: TRIGS, total: 32, motion: 100, rng: rng(12),
    });
    expect(values.at(-1).value).toBeLessThan(values[0].value);
  });

  it('accent puts the high value on the accented trigs and nowhere else', () => {
    const values = laneValuesFor({
      recipe: { name: 'fx.overdrive', shape: 'accent', from: 10, to: 90 },
      trigs: TRIGS, total: 32, motion: 100, rng: rng(13),
    });
    const on = values.filter(v => TRIGS.find(t => t.step === v.step).accent).map(v => v.value);
    const off = values.filter(v => !TRIGS.find(t => t.step === v.step).accent).map(v => v.value);
    expect(Math.min(...on)).toBeGreaterThan(Math.max(...off));
  });

  it('swell saves its lift for the end of the loop', () => {
    const values = laneValuesFor({
      recipe: { name: 'fx.reverbSend', shape: 'swell', from: 20, to: 90 },
      trigs: TRIGS, total: 32, motion: 100, rng: rng(14),
    });
    const early = values.filter(v => v.step < 24).map(v => v.value);
    expect(values.at(-1).value).toBeGreaterThan(Math.max(...early));
  });

  it('a lower Motion is the same gesture, gentler', () => {
    const spread = motion => {
      const values = laneValuesFor({
        recipe: { name: 'filter.cutoff', shape: 'rise', from: 20, to: 100 },
        trigs: TRIGS, total: 32, motion, rng: rng(15),
      }).map(v => v.value);
      return Math.max(...values) - Math.min(...values);
    };
    expect(spread(100)).toBeGreaterThan(spread(40));
    expect(spread(40)).toBeGreaterThan(spread(10));
  });

  it('is deterministic for a seed, wander included', () => {
    const once = seed => laneValuesFor({
      recipe: { name: 'amp.pan', shape: 'wander', from: 30, to: 90 },
      trigs: TRIGS, total: 32, motion: 100, rng: rng(seed),
    }).map(v => v.value);
    expect(once(16)).toEqual(once(16));
    expect(once(16)).not.toEqual(once(17));
  });

  it('falls back to a rise for a shape nobody has written', () => {
    const values = laneValuesFor({
      recipe: { name: 'filter.cutoff', shape: 'nonsense', from: 20, to: 100 },
      trigs: TRIGS, total: 32, motion: 100, rng: rng(18),
    });
    expect(values.at(-1).value).toBeGreaterThan(values[0].value);
  });
});

describe('every genre\'s recipe', () => {
  it('names only parameters both boxes actually have', () => {
    // A typo in genres.js would otherwise mean a lane that silently never appears.
    for (const genre of GENRE_IDS) {
      for (const [role, profile] of Object.entries(GENRES[genre].roles)) {
        for (const recipe of profile.lanes ?? []) {
          for (const kind of DEVICE_KINDS) {
            const known = paramTableFor(kind).some(p => p.name === recipe.name);
            expect(known, `${genre}/${role}: ${recipe.name} on ${kind}`).toBe(true);
          }
          expect(LANE_SHAPES[recipe.shape], `${genre}/${role}: shape ${recipe.shape}`).toBeTruthy();
        }
      }
    }
  });
});
