// The bassline.
//
// Generated first, which makes it the part the other two react to: what it
// returns goes into the shared rhythm map, and the lead's density is penalised on
// the steps it owns.
//
// Pitch vocabulary is deliberately small — roots, fifths, octaves, the chord's
// own seventh, and an approach tone into a chord change. A bassline is a rhythm
// part that happens to have notes in it, so the interest lives in the trig list,
// the velocities and the ghosts rather than in the melody.
//
// Notes come back as plain specs (no ids): `{ step, pitch, len, velocity, micro,
// prob, fill, cond }`. js/gen/arrange.js turns them into roll notes.

import { chance, weighted } from '../rng.js';
import { rhythmFor, velocityFor, microFor, gapAfter, trigFeelFor } from '../rhythm.js';
import { chordTones, slotRootPitch, snapToScalePitch, foldIntoWindow, windowFor } from '../theory.js';
import { snapLenFine } from '../../roll-bridge.js';

// The intervals a bassline reaches for beyond the root, as offsets in *chord
// tones* rather than semitones, so a minor chord gives a minor third and a
// seventh chord gives its own seventh with no interval table here.
const pickChordTone = (rng, tones, root) => {
  const above = tones.filter(p => p !== root);
  if (!above.length) return root;
  return weighted(rng, above.map((pitch, i) => ({ pitch, weight: i === 0 ? 0.5 : 1 })), e => e.weight).pitch;
};

export function generateBass(ctx, rng, band = {}) {
  const role = ctx.roles.bass;
  const part = ctx.parts.bass;
  const [min, max] = windowFor(role, part.octave);
  const total = ctx.lengthSteps;

  const trigs = rhythmFor({
    weights: role.weights,
    trigsPerBar: role.trigsPerBar,
    density: part.density,
    bars: ctx.bars,
    rng,
    busy: band.busy ?? new Set(),
    avoid: 0,
    // The 1 always plays. A bassline that can be missing its downbeat is a
    // different feature (and one the density slider shouldn't be able to reach).
    anchors: role.anchor ? [0] : [],
  });

  const feel = trigFeelFor(trigs, {
    recipe: role.conditions,
    looseness: ctx.feel.looseness,
    bars: ctx.bars,
    rng,
  });

  const notes = [];
  for (let i = 0; i < trigs.length; i++) {
    const trig = trigs[i];
    const slot = ctx.barSlots[trig.bar];
    const root = slotRootPitch(slot, ctx.key, { octave: part.octave, min, max });
    const tones = chordTones(slot, ctx.key, { octave: part.octave, min, max });

    // The pitch decisions read only the genre profile and the seed, never the
    // feel sliders: Motion is about p-lock automation and Looseness about trig
    // conditions, so moving either must not rewrite the notes.
    let pitch = root;
    const nextSlot = ctx.barSlots[trig.bar + 1] ?? ctx.barSlots[0];
    const lastOfBar = (trigs[i + 1]?.bar ?? -1) !== trig.bar;
    if (lastOfBar && nextSlot !== slot && chance(rng, role.approach)) {
      // An approach tone into the next chord: a scale tone a step away from where
      // the next bar starts, which is what makes a loop turn over instead of
      // restarting.
      const target = slotRootPitch(nextSlot, ctx.key, { octave: part.octave, min, max });
      pitch = snapToScalePitch(target + (chance(rng, 0.5) ? -2 : -1), ctx.key);
    } else if (trig.accent) {
      pitch = root;
    } else if (chance(rng, role.octaveLeap)) {
      pitch = root + (chance(rng, 0.75) ? 12 : -12);
    } else if (!trig.ghost && chance(rng, 0.45)) {
      pitch = pickChordTone(rng, tones, root);
    }
    pitch = foldIntoWindow(pitch, min, max);

    // Length: the anchor holds, everything else plays to the next trig at most,
    // and every value is snapped to the boxes' own LEN scale so what the roll
    // draws is what the hardware stores.
    const gap = gapAfter(trigs, i, total);
    const want = trig.step === 0 && role.anchor
      ? Math.min(role.anchor.len, gap)
      : Math.min(trig.ghost ? role.len.ghost : role.len.normal, gap, role.len.max);
    const len = snapLenFine(want, total - trig.step);

    const t = feel.get(trig.step) ?? {};
    notes.push({
      step: trig.step,
      pitch,
      len,
      velocity: velocityFor(trig, { velocity: role.velocity, humanize: ctx.feel.humanize, rng }),
      micro: microFor(trig.step, { groove: ctx.groove, humanize: ctx.feel.humanize, rng }),
      prob: t.prob ?? null,
      fill: t.fill ?? null,
      cond: t.cond ?? null,
    });
  }

  return { notes, trigs };
}
