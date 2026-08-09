// The lead's memory: a motif, and the ways a player develops one.
//
// This is the actual difference between the generator and a randomiser. A
// randomiser picks a note per step and forgets it; a player states a short idea
// and then answers it — the same shape a tone higher, upside down, backwards,
// shoved half a beat late. So the lead generates **one** motif and develops it
// across the progression, and the development list below is the whole vocabulary.
//
// A motif is scale-degree *offsets*, not pitches: `[{ step, deg, len }]` where
// `step` is relative to the start of its phrase and `deg` is a number of scale
// steps from wherever the phrase's tonal centre turns out to be. Keeping it
// abstract is what lets the same idea land on a different chord each phrase
// without a transposition table — parts/lead.js resolves degrees to pitches
// against the bar's own chord.

import { sampleWeighted, intRange, pick, chance } from './rng.js';

export const MOTIF_VARIANTS = ['repeat', 'transpose', 'invert', 'retrograde', 'displace', 'sparse'];

// A fresh idea. Steps are drawn from the genre's own weight table so the motif
// sits where that genre's notes sit; the degree contour is a small random walk,
// because a melody that leaps every note isn't a melody.
export function makeMotif(rng, { notes = [3, 5], window = 8, weights = [], spread = 2 } = {}) {
  const count = Math.max(1, Math.min(window, intRange(rng, notes[0], notes[1])));
  const slots = [];
  for (let step = 0; step < window; step++) {
    const w = weights[step % 16] ?? 1;
    if (w > 0) slots.push({ step, weight: step === 0 ? Math.max(w, 1) : w });
  }
  const chosen = sampleWeighted(rng, slots, count).sort((a, b) => a.step - b.step);
  if (!chosen.length) chosen.push({ step: 0, weight: 1 });

  let deg = 0;
  return chosen.map((s, i) => {
    if (i > 0) {
      // Mostly steps, occasionally a leap — and pulled back toward the centre
      // when the walk has wandered, so a motif keeps a shape instead of drifting.
      const dir = deg > spread ? -1 : deg < -spread ? 1 : (chance(rng, 0.5) ? 1 : -1);
      deg += dir * (chance(rng, 0.25) ? 2 : 1);
    }
    const next = chosen[i + 1]?.step ?? window;
    return { step: s.step, deg, len: Math.max(0.5, Math.min(next - s.step, 4)) };
  });
}

// One development of a motif. Every variant returns a *new* motif and can return
// the empty list for none of them: `sparse` thins, `displace` can push notes off
// the end of the phrase, and a caller that gets nothing back simply has a bar of
// space — which is a musical answer too.
export function developMotif(motif, variant, { window = 8, rng } = {}) {
  const m = motif.map(n => ({ ...n }));
  switch (variant) {
    case 'transpose': {
      const by = pick(rng, [-2, -1, 1, 2, 3]);
      return m.map(n => ({ ...n, deg: n.deg + by }));
    }
    case 'invert': {
      // Mirrored around the motif's first note, so the opening pitch is shared
      // and the answer is audibly the same idea upside down.
      const pivot = m[0]?.deg ?? 0;
      return m.map(n => ({ ...n, deg: 2 * pivot - n.deg }));
    }
    case 'retrograde': {
      // The degree sequence reversed over the motif's own rhythm. A true
      // time-reversal would also mirror the rhythm, which reliably pushes notes
      // off the phrase; this keeps the groove and reverses the tune.
      const degs = m.map(n => n.deg).reverse();
      return m.map((n, i) => ({ ...n, deg: degs[i] }));
    }
    case 'displace': {
      const by = chance(rng, 0.5) ? 1 : 2;
      return m
        .map(n => ({ ...n, step: n.step + by }))
        .filter(n => n.step < window);
    }
    case 'sparse': {
      const drop = Math.min(m.length - 1, intRange(rng, 1, 2));
      const keep = new Set(sampleWeighted(rng, m.slice(1), Math.max(0, m.length - 1 - drop),
        () => 1).map(n => n.step));
      return m.filter((n, i) => i === 0 || keep.has(n.step));
    }
    case 'repeat':
    default:
      return m;
  }
}

// Which development each phrase gets. Phrase 1 always states the motif plainly —
// you can't develop an idea nobody has heard yet — and Looseness decides how far
// the rest travel: low keeps repeating and transposing, high reaches for
// inversions, retrogrades and displacement.
export function motifPlan(rng, phrases, looseness = 40) {
  const loose = Math.max(0, Math.min(100, looseness)) / 100;
  const near = [
    { v: 'repeat', weight: 3 },
    { v: 'transpose', weight: 3 },
    { v: 'sparse', weight: 1 },
  ];
  const far = [
    { v: 'invert', weight: 2 },
    { v: 'retrograde', weight: 1.5 },
    { v: 'displace', weight: 1.5 },
  ];
  const pool = [
    ...near.map(e => ({ ...e, weight: e.weight * (1.2 - 0.6 * loose) })),
    ...far.map(e => ({ ...e, weight: e.weight * (0.15 + 1.1 * loose) })),
  ];
  const out = ['repeat'];
  for (let i = 1; i < phrases; i++) {
    // A phrase after a plain repeat leans away from repeating again, so a part
    // never sits on the same bar four times in a row.
    const bias = out[i - 1] === 'repeat' ? pool.filter(e => e.v !== 'repeat') : pool;
    out.push(sampleWeighted(rng, bias, 1, e => e.weight)[0]?.v ?? 'transpose');
  }
  return out;
}

// How much of a developed motif survives at a given density. A lead at density 20
// plays the bones of the idea; at 100 it plays all of it plus passing notes, which
// parts/lead.js adds. Ordered by step so what survives still reads as the motif.
export function thinMotif(motif, density, rng) {
  const keepAll = Math.max(0, Math.min(100, density)) / 100;
  if (motif.length <= 1) return motif;
  const keep = Math.max(1, Math.round(motif.length * (0.45 + 0.55 * keepAll)));
  if (keep >= motif.length) return motif;
  // The first note always survives — it is what makes the phrase recognisable —
  // and the rest are drawn favouring the longer notes, which are the ones an ear
  // hears as the tune rather than as ornament.
  const rest = sampleWeighted(rng, motif.slice(1), keep - 1, n => 1 + (n.len ?? 1));
  return [motif[0], ...rest].sort((a, b) => a.step - b.step);
}
