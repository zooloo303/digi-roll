import { describe, it, expect } from 'vitest';
import {
  defaultGenContext, normalizeGenContext, contextForGenre, resolveContext,
  checkProgression, bpmSuggestion, targetSlots, GEN_ROLES, GEN_BARS,
} from '../js/gen/context.js';
import { GENRES, GENRE_IDS } from '../js/gen/genres.js';
import { progressionsFor, defaultProgressionFor, nextProgressionFor, PROGRESSIONS } from '../js/gen/progressions.js';
import { SCALES } from '../js/pianoroll.js';

describe('the default context', () => {
  it('is a complete, usable song', () => {
    const d = defaultGenContext();
    expect(GENRE_IDS).toContain(d.genre);
    expect(GEN_BARS).toContain(d.bars);
    expect(() => resolveContext(d)).not.toThrow();
    for (const role of GEN_ROLES) {
      expect(d.parts[role].on).toBe(true);
      expect(d.parts[role].slot).toBeGreaterThanOrEqual(0);
    }
  });

  it('puts the three parts in three different slots', () => {
    const slots = GEN_ROLES.map(r => defaultGenContext().parts[r].slot);
    expect(new Set(slots).size).toBe(3);
  });

  it('puts each part in its own register', () => {
    const d = defaultGenContext();
    expect(d.parts.bass.octave).toBeLessThan(d.parts.chords.octave);
    expect(d.parts.chords.octave).toBeLessThan(d.parts.lead.octave);
  });
});

describe('normalizing a saved context', () => {
  it('backfills everything from nothing at all', () => {
    expect(normalizeGenContext(undefined)).toEqual(defaultGenContext());
    expect(normalizeGenContext(null)).toEqual(defaultGenContext());
    expect(normalizeGenContext('junk')).toEqual(defaultGenContext());
    expect(normalizeGenContext({})).toEqual(defaultGenContext());
  });

  it('keeps what is valid and replaces what is not', () => {
    const out = normalizeGenContext({
      genre: 'house', bars: 4, root: 7, scale: 'Dorian', seed: 99, seedLocked: true,
      progression: 'i7 iv7', feel: { motion: 80, looseness: 10, humanize: 0 },
      parts: { bass: { on: false, slot: 5, density: 90, octave: 3 } },
    });
    expect(out).toMatchObject({
      genre: 'house', bars: 4, root: 7, scale: 'Dorian', seed: 99, seedLocked: true,
      progression: 'i7 iv7',
    });
    expect(out.feel).toEqual({ motion: 80, looseness: 10, humanize: 0 });
    expect(out.parts.bass).toEqual({ on: false, slot: 5, density: 90, octave: 3, variation: 0 });
    // …and the parts it said nothing about still come out complete
    expect(out.parts.lead).toEqual(defaultGenContext().parts.lead);
  });

  it('clamps out-of-range numbers rather than trusting them', () => {
    const out = normalizeGenContext({
      root: 99, bars: 3, feel: { motion: 500, looseness: -20, humanize: 'x' },
      parts: { lead: { slot: 40, density: 900, octave: 0 } },
    });
    expect(out.root).toBe(11);
    expect(out.bars).toBe(defaultGenContext().bars);   // 3 isn't an offered length
    expect(out.feel.motion).toBe(100);
    expect(out.feel.looseness).toBe(0);
    expect(out.feel.humanize).toBe(defaultGenContext().feel.humanize);
    expect(out.parts.lead.slot).toBe(7);               // eight slots, zero-based
    expect(out.parts.lead.density).toBe(100);
    expect(out.parts.lead.octave).toBe(1);
  });

  it('takes the slot count from the caller, so it can never aim at a slot that isn\'t there', () => {
    expect(normalizeGenContext({ parts: { bass: { slot: 7 } } }, 4).parts.bass.slot).toBe(3);
  });

  it('falls back to the genre\'s own progression when there isn\'t one', () => {
    expect(normalizeGenContext({ genre: 'house', progression: '   ' }).progression)
      .toBe(defaultProgressionFor('house'));
  });

  it('replaces an unknown genre and keeps its progression sensible', () => {
    const out = normalizeGenContext({ genre: 'jungle' });
    expect(GENRE_IDS).toContain(out.genre);
    expect(() => resolveContext(out)).not.toThrow();
  });

  it('keeps a seed as an unsigned 32-bit number', () => {
    expect(normalizeGenContext({ seed: -1 }).seed).toBe(4294967295);
    expect(normalizeGenContext({ seed: 3.7 }).seed).toBe(3);
    expect(normalizeGenContext({ seed: 'x' }).seed).toBe(defaultGenContext().seed);
  });

  it('is idempotent — normalizing twice changes nothing', () => {
    const once = normalizeGenContext({ genre: 'electro', bars: 8 });
    expect(normalizeGenContext(once)).toEqual(once);
  });
});

describe('switching genre', () => {
  it('takes the new genre\'s bar count and progression', () => {
    const out = contextForGenre(defaultGenContext(), 'house');
    expect(out.genre).toBe('house');
    expect(out.bars).toBe(GENRES.house.bars);
    expect(out.progression).toBe(defaultProgressionFor('house'));
  });

  it('keeps what is yours: the seed, the feel and the parts', () => {
    const before = normalizeGenContext({
      seed: 777, seedLocked: true, feel: { motion: 90, looseness: 5, humanize: 50 },
      parts: { lead: { on: false, slot: 6, density: 20, octave: 6 } },
    });
    const after = contextForGenre(before, 'electro');
    expect(after.seed).toBe(777);
    expect(after.seedLocked).toBe(true);
    expect(after.feel).toEqual(before.feel);
    expect(after.parts).toEqual(before.parts);
  });

  it('keeps a hand-typed progression when asked to', () => {
    const mine = normalizeGenContext({ progression: 'ii7 V7 i7' });
    expect(contextForGenre(mine, 'house', { keepProgression: true }).progression).toBe('ii7 V7 i7');
  });
});

describe('resolving a context for the generator', () => {
  it('works out the derived values once', () => {
    const ctx = resolveContext({ ...defaultGenContext(), bars: 4, progression: 'i VI', scale: 'Dorian', root: 5 });
    expect(ctx.lengthSteps).toBe(64);
    expect(ctx.prog.map(s => s.degree)).toEqual([1, 6]);
    expect(ctx.barSlots.map(s => s.degree)).toEqual([1, 6, 1, 6]);
    expect(ctx.key).toEqual({ root: 5, intervals: SCALES['Dorian'] });
    expect(ctx.roles.bass.weights.length).toBe(16);
    expect(ctx.groove.length).toBe(16);
  });

  it('throws the parser\'s own message for a malformed progression', () => {
    expect(() => resolveContext({ ...defaultGenContext(), progression: 'i VIII' }))
      .toThrow(/isn't a chord quality|roman numerals/);
  });

  it('falls back to minor for a scale nobody has heard of', () => {
    const ctx = resolveContext({ ...defaultGenContext(), scale: 'Klingon' });
    expect(ctx.key.intervals).toEqual(SCALES['Minor']);
  });

  it('resolves every genre', () => {
    for (const genre of GENRE_IDS) {
      const ctx = resolveContext(contextForGenre(defaultGenContext(), genre));
      expect(ctx.profile.id).toBe(genre);
      for (const role of GEN_ROLES) expect(ctx.roles[role].weights.length).toBe(16);
    }
  });
});

describe('checking a progression before committing it', () => {
  it('says yes to a good one, how long it is, and why not to a bad one', () => {
    expect(checkProgression('i VI III VII')).toEqual({ ok: true, error: null, bars: 4 });
    expect(checkProgression('i:2 VI:2').bars).toBe(4);
    const bad = checkProgression('i H');
    expect(bad).toMatchObject({ ok: false, bars: 0 });
    expect(bad.error).toMatch(/roman numerals/);
  });
});

describe('the bpm suggestion', () => {
  it('is the genre\'s own tempo, and knows when the transport is already there', () => {
    expect(bpmSuggestion({ genre: 'dnb' }, 174)).toMatchObject({ bpm: 174, inRange: true });
    expect(bpmSuggestion({ genre: 'dnb' }, 120).inRange).toBe(false);
    expect(bpmSuggestion({ genre: 'house' }, 124)).toMatchObject({ bpm: 124, inRange: true });
  });

  it('has a tempo inside its own range for every genre', () => {
    for (const genre of GENRE_IDS) {
      const { bpm, range } = bpmSuggestion({ genre }, 0);
      expect(bpm).toBeGreaterThanOrEqual(range[0]);
      expect(bpm).toBeLessThanOrEqual(range[1]);
    }
  });
});

describe('which slots a generate would overwrite', () => {
  it('is the checked parts\' slots, in role order', () => {
    const ctx = normalizeGenContext({ parts: { chords: { on: false } } });
    expect(targetSlots(ctx)).toEqual([0, 2]);
    expect(targetSlots(normalizeGenContext({}))).toEqual([0, 1, 2]);
  });
});

describe('the progression library', () => {
  it('has something for every genre', () => {
    for (const genre of GENRE_IDS) {
      expect(progressionsFor(genre).length).toBeGreaterThan(0);
      expect(progressionsFor(genre)[0].text).toBe(defaultProgressionFor(genre));
    }
  });

  it('cycles through a genre\'s own progressions and wraps', () => {
    const list = progressionsFor('house').map(p => p.text);
    let at = list[0];
    for (let i = 1; i < list.length; i++) {
      at = nextProgressionFor('house', at);
      expect(at).toBe(list[i]);
    }
    expect(nextProgressionFor('house', at)).toBe(list[0]);
  });

  it('starts the cycle from the top for something typed by hand', () => {
    expect(nextProgressionFor('dnb', 'ii V i')).toBe(progressionsFor('dnb')[0].text);
  });

  it('describes each entry, for the hint under the field', () => {
    for (const p of PROGRESSIONS) expect(p.note.length).toBeGreaterThan(5);
  });
});
