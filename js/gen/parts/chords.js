// The chord part.
//
// One voicing per progression slot, stamped through the app's own chord code:
// `chordTones` (js/gen/theory.js → `chordPitches`) for the notes and `voiceChord`
// (js/chords.js) for the strum stagger and the velocity taper. So a generated
// chord is byte-for-byte the same kind of thing chord draw makes, including the
// 4-note hardware ceiling.
//
// The session-musician touch is **voice leading**: each chord is built in all four
// inversions (and a drop-2 spread), and the one that moves least from the chord
// before it wins. That single rule is the difference between a part that walks and
// a part that jumps an octave every bar.

import { chance } from '../rng.js';
import { rhythmFor, velocityFor, microFor, gapAfter, trigFeelFor, snapMicro } from '../rhythm.js';
import { voicingCandidates, bestVoicing, windowFor } from '../theory.js';
import { voiceChord } from '../../chords.js';
import { snapLenFine } from '../../roll-bridge.js';

export function generateChords(ctx, rng, band = {}) {
  const role = ctx.roles.chords;
  const part = ctx.parts.chords;
  const [min, max] = windowFor(role, part.octave);
  const total = ctx.lengthSteps;

  const trigs = rhythmFor({
    weights: role.weights,
    trigsPerBar: role.trigsPerBar,
    density: part.density,
    bars: ctx.bars,
    rng,
    // Chords landing with the bass is a band, not a collision, so the busy map
    // costs them almost nothing — unlike the lead.
    busy: band.busy ?? new Set(),
    avoid: 0.15,
    anchors: [],
  });

  const feel = trigFeelFor(trigs, {
    recipe: role.conditions,
    looseness: ctx.feel.looseness,
    bars: ctx.bars,
    rng,
  });

  const notes = [];
  let previous = [];
  for (let i = 0; i < trigs.length; i++) {
    const trig = trigs[i];
    const slot = ctx.barSlots[trig.bar];
    // Whether this genre opens its voicings up is a per-chord coin toss weighted
    // by the profile, so a part isn't uniformly blocky or uniformly wide.
    const spread = chance(rng, role.spread ?? 0);
    const candidates = voicingCandidates(slot, ctx.key, {
      octave: part.octave, min, max, spreads: [spread],
    });
    const pitches = bestVoicing(previous, candidates, { centre: (min + max) / 2 });
    if (!pitches.length) continue;
    previous = pitches;

    // Sustain holds to the next chord (a pad); stab is the genre's own short
    // length whatever the gap (house, breaks). Either way it is snapped to the
    // box's LEN scale and can't run past the end of the pattern.
    const gap = gapAfter(trigs, i, total);
    const want = role.len.mode === 'sustain'
      ? Math.min(role.len.max, gap)
      : Math.min(role.len.normal, gap, role.len.max);
    const len = snapLenFine(want, total - trig.step);

    const velocity = velocityFor(trig, {
      velocity: role.velocity, humanize: ctx.feel.humanize, rng,
    });
    const micro = microFor(trig.step, {
      groove: ctx.groove, humanize: ctx.feel.humanize, rng,
    });
    const t = feel.get(trig.step) ?? {};

    // Strum is real per-note micro-timing, so it survives write-back. It rides on
    // top of the groove offset and the sum is re-snapped to the box's 1/24-step
    // grid — otherwise a strum of 0.06 per note would be three values the
    // hardware rounds on the way in.
    for (const v of voiceChord(pitches, { velocity, strum: role.strum ?? 0 })) {
      notes.push({
        step: trig.step,
        pitch: v.pitch,
        len,
        velocity: v.velocity,
        micro: snapMicro(micro + v.micro),
        // Every note on a step shares the trig's conditions — the step-uniformity
        // rule the encoder relies on, and the reason `feel` is keyed by step.
        prob: t.prob ?? null,
        fill: t.fill ?? null,
        cond: t.cond ?? null,
      });
    }
  }

  return { notes, trigs };
}
