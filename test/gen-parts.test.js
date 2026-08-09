import { describe, it, expect } from 'vitest';
import { generateBass } from '../js/gen/parts/bass.js';
import { generateChords } from '../js/gen/parts/chords.js';
import { generateLead } from '../js/gen/parts/lead.js';
import { resolveContext, defaultGenContext } from '../js/gen/context.js';
import { windowFor, scaleIntervals } from '../js/gen/theory.js';
import { rngFor } from '../js/gen/rng.js';
import { GENRE_IDS } from '../js/gen/genres.js';
import { MICRO_TICK, MICRO_LIMIT } from '../js/gen/rhythm.js';
import { snapLenFine, LEN_MIN } from '../js/roll-bridge.js';
import { MAX_CHORD_NOTES } from '../js/chords.js';
import { isCondKey } from '../js/elektron/conditions.js';

// The three parts, against every genre. Most of what follows is one contract:
// **a generated note must be something the hardware can hold.** The generator
// leaves for the box through the same encoder a hand-drawn note does, so a
// velocity of 0, an unsnapped length or a micro offset the byte can't carry would
// be silently mangled on write rather than caught here.

const ctxFor = (over = {}) => resolveContext({ ...defaultGenContext(), ...over });

const PARTS = {
  bass: generateBass,
  chords: generateChords,
  lead: generateLead,
};

const generate = (role, ctx, band = { busy: new Set() }, seed = ctx.seed) =>
  PARTS[role](ctx, rngFor(seed, role), band);

function expectPlayable(notes, ctx, role) {
  const [min, max] = windowFor(ctx.roles[role], ctx.parts[role].octave);
  for (const n of notes) {
    expect(Number.isInteger(n.step)).toBe(true);
    expect(n.step).toBeGreaterThanOrEqual(0);
    expect(n.step).toBeLessThan(ctx.lengthSteps);

    expect(Number.isInteger(n.pitch)).toBe(true);
    expect(n.pitch, `${role} pitch in window`).toBeGreaterThanOrEqual(min);
    expect(n.pitch, `${role} pitch in window`).toBeLessThanOrEqual(max);

    // Length: representable on the boxes' own LEN scale, and inside the pattern.
    expect(n.len).toBeGreaterThanOrEqual(LEN_MIN);
    expect(n.len).toBeLessThanOrEqual(ctx.lengthSteps - n.step);
    expect(snapLenFine(n.len, ctx.lengthSteps - n.step)).toBeCloseTo(n.len, 10);

    expect(Number.isInteger(n.velocity)).toBe(true);
    expect(n.velocity).toBeGreaterThanOrEqual(1);
    expect(n.velocity).toBeLessThanOrEqual(127);

    // Micro: a whole number of the 1/24-step ticks the micro byte holds.
    expect(Math.abs(n.micro)).toBeLessThanOrEqual(MICRO_LIMIT + 1e-9);
    expect(Math.abs(n.micro / MICRO_TICK - Math.round(n.micro / MICRO_TICK))).toBeLessThan(1e-9);

    if (n.prob != null) {
      expect(Number.isInteger(n.prob)).toBe(true);
      expect(n.prob).toBeGreaterThanOrEqual(0);
      expect(n.prob).toBeLessThanOrEqual(100);
    }
    if (n.fill != null) expect(typeof n.fill).toBe('boolean');
    if (n.cond != null) expect(isCondKey(n.cond)).toBe(true);
  }
}

// Every note sharing a step is one trig on the box, so they must agree about
// PROB/FILL/COND — the rule the encoder resolves by lowest pitch when it is broken.
function expectStepUniformity(notes) {
  const byStep = new Map();
  for (const n of notes) {
    const first = byStep.get(n.step);
    if (!first) byStep.set(n.step, n);
    else expect([n.prob, n.fill, n.cond]).toEqual([first.prob, first.fill, first.cond]);
  }
}

const noDuplicates = notes => {
  const seen = new Set();
  for (const n of notes) {
    const key = `${n.step}:${n.pitch}`;
    expect(seen.has(key)).toBe(false);
    seen.add(key);
  }
};

describe.each(GENRE_IDS)('%s', genre => {
  describe.each(['bass', 'chords', 'lead'])('%s', role => {
    it('produces notes the hardware can hold, at every density', () => {
      for (const density of [0, 40, 100]) {
        for (let seed = 0; seed < 6; seed++) {
          const ctx = ctxFor({
            genre, seed, bars: 2,
            parts: { ...defaultGenContext().parts, [role]: { ...defaultGenContext().parts[role], density } },
          });
          const { notes } = generate(role, ctx);
          expect(notes.length).toBeGreaterThan(0);
          expectPlayable(notes, ctx, role);
          expectStepUniformity(notes);
          noDuplicates(notes);
        }
      }
    });

    it('is deterministic for a seed, and different for another', () => {
      const ctx = ctxFor({ genre, seed: 4242 });
      const a = generate(role, ctx).notes;
      const b = generate(role, ctx).notes;
      expect(a).toEqual(b);
      expect(generate(role, ctx, { busy: new Set() }, 4243).notes).not.toEqual(a);
    });

    it('works at every pattern length', () => {
      for (const bars of [1, 2, 4, 8]) {
        const ctx = ctxFor({ genre, bars, seed: 7 });
        const { notes } = generate(role, ctx);
        expectPlayable(notes, ctx, role);
        expect(Math.max(...notes.map(n => n.step))).toBeLessThan(bars * 16);
      }
    });

    it('writes no conditions at all at Looseness 0', () => {
      const ctx = ctxFor({ genre, seed: 11, feel: { motion: 50, looseness: 0, humanize: 30 } });
      for (const n of generate(role, ctx).notes) {
        expect([n.prob, n.fill, n.cond]).toEqual([null, null, null]);
      }
    });
  });
});

describe('the bassline', () => {
  it('always plays the 1', () => {
    for (const genre of GENRE_IDS) {
      for (let seed = 0; seed < 10; seed++) {
        const ctx = ctxFor({ genre, seed });
        expect(generate('bass', ctx).notes.some(n => n.step === 0)).toBe(true);
      }
    }
  });

  it('is one note per step — a bass part, not a chord part', () => {
    const ctx = ctxFor({ genre: 'dnb', seed: 3 });
    const { notes } = generate('bass', ctx);
    expect(new Set(notes.map(n => n.step)).size).toBe(notes.length);
  });

  it('sits mostly on the root of whatever chord the bar is on', () => {
    const ctx = ctxFor({ genre: 'dnb', seed: 5, progression: 'i VI' });
    const { notes } = generate('bass', ctx);
    const roots = new Set(ctx.barSlots.map((s, bar) => bar));
    let onRoot = 0;
    for (const n of notes) {
      const degree = ctx.barSlots[Math.floor(n.step / 16)].degree;
      const rootClass = (ctx.root + scaleIntervals(ctx.scale)[degree - 1]) % 12;
      if (n.pitch % 12 === rootClass) onRoot++;
    }
    expect(roots.size).toBeGreaterThan(0);
    expect(onRoot / notes.length).toBeGreaterThan(0.4);
  });

  it('puts house\'s bass on the off-beats', () => {
    const ctx = ctxFor({ genre: 'house', seed: 2, bars: 1 });
    const { notes } = generate('bass', ctx);
    const offbeat = notes.filter(n => n.step % 4 === 2).length;
    expect(offbeat / notes.length).toBeGreaterThan(0.5);
  });

  it('keeps electro\'s bass staccato and busy', () => {
    const dnb = generate('bass', ctxFor({ genre: 'dnb', seed: 8, bars: 2 })).notes;
    const electro = generate('bass', ctxFor({ genre: 'electro', seed: 8, bars: 2 })).notes;
    expect(electro.length).toBeGreaterThan(dnb.length);
    expect(Math.max(...electro.map(n => n.len))).toBeLessThanOrEqual(1);
  });

  it('holds DnB\'s anchor note on the 1', () => {
    const ctx = ctxFor({ genre: 'dnb', seed: 6, parts: {
      ...defaultGenContext().parts, bass: { on: true, slot: 0, density: 20, octave: 2 },
    } });
    const first = generate('bass', ctx).notes.find(n => n.step === 0);
    expect(first.len).toBeGreaterThan(1);
  });
});

describe('the chord part', () => {
  it('never exceeds the hardware\'s four notes per trig', () => {
    for (const genre of GENRE_IDS) {
      const ctx = ctxFor({ genre, seed: 1, progression: 'i7 iv7 VI7 v7', bars: 4 });
      const { notes } = generate('chords', ctx);
      const perStep = new Map();
      for (const n of notes) perStep.set(n.step, (perStep.get(n.step) ?? 0) + 1);
      for (const [, count] of perStep) expect(count).toBeLessThanOrEqual(MAX_CHORD_NOTES);
    }
  });

  it('walks between chords instead of jumping an octave', () => {
    const ctx = ctxFor({ genre: 'house', seed: 3, progression: 'i7 iv7 VI7 v7', bars: 4 });
    const { notes } = generate('chords', ctx);
    const steps = [...new Set(notes.map(n => n.step))].sort((a, b) => a - b);
    const mean = step => {
      const on = notes.filter(n => n.step === step);
      return on.reduce((a, n) => a + n.pitch, 0) / on.length;
    };
    for (let i = 1; i < steps.length; i++) {
      expect(Math.abs(mean(steps[i]) - mean(steps[i - 1]))).toBeLessThan(9);
    }
  });

  it('plays the notes of the bar\'s chord', () => {
    const ctx = ctxFor({ genre: 'dnb', seed: 4, progression: 'i', bars: 1 });
    const { notes } = generate('chords', ctx);
    // C minor triad: C Eb G.
    for (const n of notes) expect([0, 3, 7]).toContain(n.pitch % 12);
  });

  it('staggers a strummed chord with real micro-timing', () => {
    const ctx = ctxFor({ genre: 'breaks', seed: 9, feel: { motion: 0, looseness: 0, humanize: 0 } });
    const { notes } = generate('chords', ctx);
    const step = notes[0].step;
    const chord = notes.filter(n => n.step === step);
    expect(chord.length).toBeGreaterThan(1);
    expect(new Set(chord.map(n => n.micro)).size).toBeGreaterThan(1);
  });

  it('tapers a chord\'s velocity so the top note sings', () => {
    const ctx = ctxFor({ genre: 'dnb', seed: 12, feel: { motion: 0, looseness: 0, humanize: 0 } });
    const { notes } = generate('chords', ctx);
    const step = notes[0].step;
    const chord = notes.filter(n => n.step === step).sort((a, b) => a.pitch - b.pitch);
    expect(chord.at(-1).velocity).toBeGreaterThanOrEqual(chord[0].velocity);
  });
});

describe('the lead', () => {
  it('answers the bass rather than doubling it', () => {
    let onBass = 0;
    let free = 0;
    for (let seed = 0; seed < 25; seed++) {
      const ctx = ctxFor({ genre: 'dnb', seed, bars: 2 });
      const bass = generate('bass', ctx);
      const busy = new Set(bass.trigs.map(t => t.step));
      const lead = generate('lead', ctx, { busy });
      for (const n of lead.notes) (busy.has(n.step) ? onBass++ : free++);
    }
    expect(free).toBeGreaterThan(onBass * 2);
  });

  it('lands on chord tones on the beats', () => {
    const ctx = ctxFor({ genre: 'electro', seed: 6, progression: 'i', bars: 1 });
    const { notes } = generate('lead', ctx);
    const onBeat = notes.filter(n => n.step % 4 === 0);
    expect(onBeat.length).toBeGreaterThan(0);
    for (const n of onBeat) expect([0, 3, 7]).toContain(n.pitch % 12);
  });

  it('stays in the scale', () => {
    const ctx = ctxFor({ genre: 'dnb', seed: 7, scale: 'Minor', root: 2, bars: 2 });
    const classes = new Set(scaleIntervals('Minor').map(i => (i + 2) % 12));
    for (const n of generate('lead', ctx).notes) expect(classes.has(n.pitch % 12)).toBe(true);
  });

  it('is one note per step — a line, not a chord', () => {
    for (let seed = 0; seed < 10; seed++) {
      const { notes } = generate('lead', ctxFor({ genre: 'breaks', seed }));
      expect(new Set(notes.map(n => n.step)).size).toBe(notes.length);
    }
  });

  it('develops the motif rather than repeating it four times', () => {
    const ctx = ctxFor({ genre: 'dnb', seed: 2, bars: 4, feel: { motion: 0, looseness: 80, humanize: 0 } });
    const { notes } = generate('lead', ctx);
    const bars = [0, 1, 2, 3].map(b =>
      notes.filter(n => Math.floor(n.step / 16) === b).map(n => `${n.step % 16}:${n.pitch}`).join(','));
    expect(new Set(bars).size).toBeGreaterThan(1);
  });

  it('plays less at low density than at high', () => {
    const at = density => {
      let total = 0;
      for (let seed = 0; seed < 10; seed++) {
        const ctx = ctxFor({ genre: 'breaks', seed, bars: 2, parts: {
          ...defaultGenContext().parts, lead: { on: true, slot: 2, density, octave: 5 },
        } });
        total += generate('lead', ctx).notes.length;
      }
      return total;
    };
    expect(at(100)).toBeGreaterThan(at(10));
  });
});
