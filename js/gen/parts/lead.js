// The lead.
//
// Generated last, so it can hear the other two. Two things make it a part rather
// than a sprinkle of notes:
//
//   * **it is motif-based.** One short idea (js/gen/motif.js) is stated, then
//     developed phrase by phrase — transposed, inverted, retrograded, displaced.
//     The density slider decides how much of each development survives.
//   * **it answers the bass.** A note landing on a step the bass already owns is
//     nudged a step later where there is room, and dropped where there isn't. That
//     one rule is why a generated lead sits in the gaps instead of doubling the
//     bassline.
//
// Pitch resolution: the motif's scale-degree offsets are walked along the scale
// (so the contour is the same shape in any key), and then a note on a beat is
// pulled onto the nearest chord tone of that bar. Strong beats agree with the
// harmony; weak beats are free to pass through.

import { chance } from '../rng.js';
import { velocityFor, microFor, trigFeelFor, isBeat, snapMicro } from '../rhythm.js';
import { chordTones, scalePitchesInWindow, foldIntoWindow, slotRootPitch, windowFor } from '../theory.js';
import { makeMotif, developMotif, motifPlan, thinMotif } from '../motif.js';
import { snapLenFine } from '../../roll-bridge.js';

// Walk a pitch list by whole degrees, carrying into the next octave at the ends —
// the same wrap `chordPitches` uses for thirds past the octave, so a degree
// offset always means something.
function walk(list, baseIndex, degrees) {
  if (!list.length) return null;
  const i = baseIndex + degrees;
  const octave = Math.floor(i / list.length);
  return list[((i % list.length) + list.length) % list.length] + 12 * octave;
}

const nearestIndex = (list, pitch) => {
  let best = 0;
  for (let i = 1; i < list.length; i++) {
    if (Math.abs(list[i] - pitch) < Math.abs(list[best] - pitch)) best = i;
  }
  return best;
};

// Pull a pitch onto the nearest chord tone, but only if one is close: dragging a
// passing note a tritone to "fix" it would destroy the motif's shape.
function toChordTone(pitch, tones, reach = 2) {
  if (!tones.length) return pitch;
  const near = tones.reduce((a, b) => (Math.abs(b - pitch) < Math.abs(a - pitch) ? b : a));
  return Math.abs(near - pitch) <= reach ? near : pitch;
}

export function generateLead(ctx, rng, band = {}) {
  const role = ctx.roles.lead;
  const part = ctx.parts.lead;
  const [min, max] = windowFor(role, part.octave);
  const total = ctx.lengthSteps;
  const busy = band.busy ?? new Set();

  const window = Math.max(2, Math.min(16, role.motif?.window ?? 8));
  const phrases = Math.max(1, Math.floor(total / window));

  const motif = makeMotif(rng, {
    notes: role.motif?.notes ?? [3, 5],
    window,
    weights: role.weights,
  });
  const plan = motifPlan(rng, phrases, ctx.feel.looseness);

  const palette = scalePitchesInWindow(ctx.key, min, max);
  const taken = new Set();
  const placed = [];

  for (let p = 0; p < phrases; p++) {
    const start = p * window;
    const bar = Math.floor(start / 16);
    const slot = ctx.barSlots[bar] ?? ctx.barSlots[0];

    // Space is a musical answer: at low density whole phrases are left out, but
    // never the first, which is where the idea gets stated.
    if (p > 0 && chance(rng, (1 - part.density / 100) * 0.35)) continue;

    const phrase = thinMotif(developMotif(motif, plan[p], { window, rng }), part.density, rng);
    const tones = chordTones(slot, ctx.key, { octave: part.octave, min, max });
    const root = slotRootPitch(slot, ctx.key, { octave: part.octave, min, max });
    const rootIndex = nearestIndex(palette, root);

    for (const n of phrase) {
      let step = start + n.step;
      if (step >= total) continue;

      // Answer, don't double: a step the bass owns is nudged one later where
      // there's room, and given up where there isn't.
      if (busy.has(step)) {
        const nudged = step + 1;
        if (nudged < total && !busy.has(nudged) && !taken.has(nudged)) step = nudged;
        else if (chance(rng, 0.7)) continue;
      }
      if (taken.has(step)) continue;
      taken.add(step);

      const walked = walk(palette, rootIndex, n.deg);
      if (walked == null) continue;
      const pitch = foldIntoWindow(isBeat(step) ? toChordTone(walked, tones) : walked, min, max);
      placed.push({ step, pitch, want: n.len, bar: Math.floor(step / 16) });
    }
  }

  placed.sort((a, b) => a.step - b.step);

  // The trig list the conditions and the dynamics read. `accent` is a beat, and a
  // lead's ghosts are the notes squeezed between two others — the ones a player
  // would throw away.
  const trigs = placed.map((n, i) => {
    const gap = (placed[i + 1]?.step ?? total) - n.step;
    return {
      step: n.step,
      bar: n.bar,
      weight: role.weights[n.step % 16] ?? 0.5,
      accent: isBeat(n.step),
      ghost: !isBeat(n.step) && gap <= 1,
    };
  });

  const feel = trigFeelFor(trigs, {
    recipe: role.conditions,
    looseness: ctx.feel.looseness,
    bars: ctx.bars,
    rng,
  });

  const notes = placed.map((n, i) => {
    const trig = trigs[i];
    const gap = Math.max(0.125, (placed[i + 1]?.step ?? total) - n.step);
    const len = snapLenFine(Math.min(n.want, gap, role.len.max), total - n.step);
    const t = feel.get(n.step) ?? {};
    return {
      step: n.step,
      pitch: n.pitch,
      len,
      velocity: velocityFor(trig, { velocity: role.velocity, humanize: ctx.feel.humanize, rng }),
      micro: snapMicro(microFor(n.step, { groove: ctx.groove, humanize: ctx.feel.humanize, rng })),
      prob: t.prob ?? null,
      fill: t.fill ?? null,
      cond: t.cond ?? null,
    };
  });

  return { notes, trigs, motif };
}

// Exported for the motif tests: how many phrases a pattern gets at a given motif
// window, which is what decides how many developments there are to hear.
export const phraseCount = (lengthSteps, window) =>
  Math.max(1, Math.floor(lengthSteps / Math.max(2, Math.min(16, window))));
