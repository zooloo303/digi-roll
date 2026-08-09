// Which steps get trigs, and how they feel.
//
// The step-weight table in a genre profile says what is *likely*; the density
// slider says how much of it fires. Everything downstream — pitch, length,
// p-lock lane values — hangs off the trig list this produces, so this module is
// the shape of the part.
//
// It also owns the two per-trig layers that are about feel rather than pitch:
//
//   * **groove micro-timing**, snapped to the 1/24-of-a-step grid the boxes
//     actually store (see `microByteToSteps` in js/elektron/pattern-core.js), so
//     what the roll draws is what lands on the hardware — the same bargain
//     `snapLenFine` strikes for note lengths;
//   * **per-trig PROB/FILL/COND**, from the genre's condition recipe scaled by
//     the Looseness slider. These are per *trig*, so this hands back one setting
//     per step and the parts stamp it on every note sharing that step — the
//     step-uniformity rule the encoder relies on.

import { sampleWeighted, chance, intRange, pick, range } from './rng.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The boxes store micro-timing in 1/24ths of a step. Snapping here means a
// groove offset is exactly what the hardware will hold rather than a number that
// quietly rounds on write.
export const MICRO_TICK = 1 / 24;
export const MICRO_LIMIT = 23 / 24;

export const snapMicro = m =>
  Math.round(clamp(m, -MICRO_LIMIT, MICRO_LIMIT) / MICRO_TICK) * MICRO_TICK;

// A step is *accented* when it lands on one of the four beats, and a *ghost* when
// its own weight is in the bottom of the table — the two labels everything else
// reads: accents get velocity and length, ghosts get PROB locks and a whisper.
export const GHOST_WEIGHT = 0.4;

export const isBeat = step => step % 4 === 0;

// How many trigs a density asks for. `trigsPerBar` is the genre's own range, so
// density 0 is still music (the sparsest version of that part) rather than
// silence — turning a part *off* is the checkbox's job, not the slider's.
export function trigCountFor({ trigsPerBar = [2, 8], density = 50, bars = 1 }) {
  const [lo, hi] = trigsPerBar;
  const perBar = lo + (hi - lo) * clamp(density, 0, 100) / 100;
  return Math.max(1, Math.round(perBar * bars));
}

// The trig list for a part.
//
//   weights   one bar of 16 relative likelihoods (genres.js)
//   busy      steps another part already owns. `avoid` is how much that costs:
//             the lead sets it high so it answers the bass instead of doubling
//             it, the chords leave it near zero because chords and bass landing
//             together is a band, not a collision.
//   anchors   steps that always get a trig whatever the density (the bass's 1)
//
// Returns `[{ step, weight, accent, ghost, bar }]`, ascending by step.
export function rhythmFor({
  weights, density = 50, bars = 1, rng, busy = new Set(), avoid = 0,
  anchors = [], trigsPerBar,
}) {
  const total = bars * 16;
  const want = trigCountFor({ trigsPerBar, density, bars });
  const anchored = anchors.filter(s => s >= 0 && s < total);

  const candidates = [];
  for (let step = 0; step < total; step++) {
    if (anchored.includes(step)) continue;
    const base = weights[step % 16] ?? 0;
    if (base <= 0) continue;
    candidates.push({ step, weight: busy.has(step) ? base * (1 - clamp(avoid, 0, 1)) : base });
  }

  const chosen = sampleWeighted(rng, candidates, Math.max(0, want - anchored.length));
  const steps = [
    ...anchored.map(step => ({ step, weight: Math.max(weights[step % 16] ?? 1, 1) })),
    ...chosen,
  ].sort((a, b) => a.step - b.step);

  return steps.map(s => ({
    step: s.step,
    bar: Math.floor(s.step / 16),
    weight: s.weight,
    accent: isBeat(s.step) || s.weight >= 0.8,
    ghost: !isBeat(s.step) && s.weight < GHOST_WEIGHT,
  }));
}

// A trig's velocity: the genre's three levels, plus a humanised wobble so a
// repeated hit isn't machine-identical. Humanize 0 gives exactly the profile's
// numbers, which is what makes a generated part reproducible by eye.
export function velocityFor(trig, { velocity, humanize = 0, rng }) {
  const base = trig.accent ? velocity.accent : trig.ghost ? velocity.ghost : velocity.normal;
  const wobble = humanize > 0 ? Math.round(range(rng, -1, 1) * (humanize / 100) * 14) : 0;
  return clamp(base + wobble, 1, 127);
}

// A trig's micro-timing: the genre's groove for that position, plus a humanised
// wobble, snapped to what the box stores.
export function microFor(step, { groove = [], humanize = 0, rng }) {
  const g = groove[step % 16] ?? 0;
  const wobble = humanize > 0 ? range(rng, -1, 1) * (humanize / 100) * 0.06 : 0;
  return snapMicro(g + wobble);
}

// The gap to the next trig, in steps — what a "play until the next one" length is
// measured against. `Infinity`-free: the last trig measures to the end of the
// pattern.
export function gapAfter(trigs, i, total) {
  const next = trigs[i + 1]?.step ?? total;
  return Math.max(0.125, next - trigs[i].step);
}

// --- Per-trig conditions -------------------------------------------------------
//
// The recipes live in genres.js; this applies them. Looseness scales every
// chance, so 0 writes nothing at all and the parts come out as plain trigs.
//
// Returns a Map of step → { prob, fill, cond }, only for steps that got
// something. A step can pick up at most one COND and one FILL — the box holds one
// of each — and the recipe order decides who wins, which is why the genre lists
// the alternation rules before the decorations.

const condForBar = (bar, keys = ['1:2', '2:2']) => keys[bar % keys.length];

export function trigFeelFor(trigs, { recipe = [], looseness = 0, bars = 1, rng }) {
  const out = new Map();
  const loose = clamp(looseness, 0, 100) / 100;
  if (loose <= 0 || !recipe.length) return out;

  const at = step => {
    let s = out.get(step);
    if (!s) {
      s = { prob: null, fill: null, cond: null };
      out.set(step, s);
    }
    return s;
  };

  for (const trig of trigs) {
    for (const rule of recipe) {
      const p = (rule.chance ?? 0) * loose;
      if (p <= 0 || !chance(rng, p)) continue;
      switch (rule.kind) {
        case 'altBar':
          // Alternate bars, so a two-bar loop isn't two identical bars. Pointless
          // in a one-bar pattern, where `1:2` would just silence half the loops.
          if (bars >= 2 && !at(trig.step).cond) {
            at(trig.step).cond = condForBar(trig.bar, rule.keys ?? ['1:2', '2:2']);
          }
          break;
        case 'everyFourth':
          // Details that arrive every fourth time round.
          if (!at(trig.step).cond && !trig.accent) {
            at(trig.step).cond = pick(rng, rule.keys ?? ['3:4', '4:4']);
          }
          break;
        case 'logic':
          // A run that answers the trig before it. Never on a downbeat: the part
          // has to be recognisable on the first pass.
          if (!at(trig.step).cond && !trig.accent && trig.step > 0) {
            at(trig.step).cond = pick(rng, rule.keys ?? ['PRE']);
          }
          break;
        case 'probGhost':
          if (trig.ghost && at(trig.step).prob == null) {
            at(trig.step).prob = intRange(rng, rule.range?.[0] ?? 60, rule.range?.[1] ?? 85);
          }
          break;
        case 'probWeak':
          if (!trig.accent && at(trig.step).prob == null) {
            at(trig.step).prob = intRange(rng, rule.range?.[0] ?? 70, rule.range?.[1] ?? 90);
          }
          break;
        case 'fill':
          // ON = only exists while you hold FILL; OFF = steps aside during one.
          // Never on an accent, so holding FILL can't gut the groove.
          if (!trig.accent && at(trig.step).fill == null) {
            at(trig.step).fill = rule.mode === 'off' ? false
              : rule.mode === 'either' ? chance(rng, 0.5) : true;
          }
          break;
        default:
          break;
      }
    }
  }

  // Steps that ended up with nothing are not conditions — drop them so callers
  // can treat "in the map" as "has a lock".
  for (const [step, s] of out) {
    if (s.prob == null && s.fill == null && s.cond == null) out.delete(step);
  }
  return out;
}
