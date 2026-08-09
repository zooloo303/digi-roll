// P-lock lanes for a generated part.
//
// The one module here that knows a device exists — and it only ever **reads**
// `writableParamsFor` from js/elektron/param-tables.js, which is the list of
// parameters whose paramId has been measured on real hardware. Nothing is
// encoded, no byte is chosen, and the lanes leave for the box through the same
// `rollPLocksToDevice` seam a hand-drawn lane does.
//
// Two rules the design leans on:
//
//   * **No resolvable box, no lanes.** A lane belongs to one box's parameter
//     numbering (74 is overdrive on a DT2 and filter frequency on a DN2), so
//     guessing a device kind would mean writing the wrong knob. The generator
//     returns nothing and says so on the status line instead.
//   * **Values only on steps that have trigs**, which is the v1 rule
//     `pruneLanesToTrigs` enforces anyway — so a lane leaves here already obeying
//     it rather than being scrubbed afterwards.
//
// Values sit on the parameter's **display axis** (MIDI 0–127), the axis the lane
// strip draws and the audition path sends; the uint16 only happens at the
// roll↔device seam. So nothing in the generator knows about scaling either.

import { writableParamsFor } from '../elektron/param-tables.js';
import { MIDI_MIN, MIDI_MAX } from '../elektron/params.js';
import { range } from './rng.js';

const clampMidi = v => Math.max(MIDI_MIN, Math.min(MIDI_MAX, Math.round(v)));

// The shapes a recipe can ask for. Each is `(t, ctx) → 0..1`, where `t` is the
// position of the step through the pattern — so a shape is written once and works
// at any length.
//
//   rise    opens across the phrase; the classic filter contour
//   fall    the reverse — closes as the loop goes on
//   arc     opens to the middle and closes again
//   swell   flat, then lifts over the last quarter: a send building into the turnaround
//   accent  high on the accented trigs, low on the rest — not a contour at all
//   pulse   alternates high/low per beat, for LFO depth and pan movement
//   wander  a random walk, the shape a hand on a knob actually makes
export const LANE_SHAPES = {
  rise: t => t,
  fall: t => 1 - t,
  arc: t => 1 - Math.abs(2 * t - 1),
  swell: t => (t < 0.75 ? 0.15 * (t / 0.75) : 0.15 + 0.85 * ((t - 0.75) / 0.25)),
  accent: (t, { accent }) => (accent ? 1 : 0.15),
  pulse: (t, { step }) => (Math.floor(step / 4) % 2 === 0 ? 1 : 0.25),
  wander: (t, { walk }) => walk,
};

// Motion decides two things at once: how many of a role's recipes are used, and
// how far each one travels. At 0 there are no lanes at all; at 100 every recipe
// in the profile is drawn over its full range.
export const lanesWanted = (recipes, motion) => {
  const m = Math.max(0, Math.min(100, motion));
  if (m <= 0) return 0;
  return Math.max(1, Math.round(recipes.length * (0.34 + 0.66 * m / 100)));
};

// Lane values for one recipe over one part's trigs.
function laneValues({ recipe, trigs, total, motion, rng }) {
  const shape = LANE_SHAPES[recipe.shape] ?? LANE_SHAPES.rise;
  const from = clampMidi(recipe.from ?? 0);
  const to = clampMidi(recipe.to ?? MIDI_MAX);
  const centre = (from + to) / 2;
  const depth = Math.max(0, Math.min(100, motion)) / 100;

  // The random walk is one shared series across the lane, so `wander` reads as one
  // hand moving rather than as noise per step.
  let walk = 0.5;
  const values = [];
  for (const trig of trigs) {
    walk = Math.max(0, Math.min(1, walk + range(rng, -0.28, 0.28)));
    const f = shape(total > 1 ? trig.step / (total - 1) : 0, { ...trig, walk });
    const full = from + (to - from) * Math.max(0, Math.min(1, f));
    // Motion scales the movement about the middle of the recipe's range, so a low
    // Motion is a gentle version of the same gesture rather than a different one.
    values.push({ step: trig.step, value: clampMidi(centre + (full - centre) * depth) });
  }
  return values;
}

// Lanes for one role.
//
//   role      the role profile from js/gen/genres.js (its `lanes` array is the recipe)
//   trigs     the part's trig list — lanes only get values where there are trigs
//   deviceKind 'DT2' / 'DN2', or null when no box could be resolved
//
// Returns `{ lanes, warnings }`. A lane is `{ name, deviceKind, values }` with
// `values` sparse over the 128 steps a pattern holds — the shape
// `makePLockLane` wants.
export function designLanes({
  role, deviceKind = null, trigs = [], total = 16, motion = 0, rng, steps = 128,
}) {
  const warnings = [];
  const recipes = role?.lanes ?? [];
  if (!recipes.length || !trigs.length) return { lanes: [], warnings };
  if (motion <= 0) return { lanes: [], warnings };
  if (!deviceKind) {
    warnings.push('no p-lock lanes — digi-roll can\'t tell which box this is for, and a lane '
      + 'belongs to one box\'s parameter numbering. Pick your box in the MIDI output menu '
      + '(or import a track from it) and generate again.');
    return { lanes: [], warnings };
  }

  const writable = new Map(writableParamsFor(deviceKind).map(p => [p.name, p]));
  const usable = recipes.filter(r => writable.has(r.name));
  if (!usable.length) {
    warnings.push(`no p-lock lanes — none of the ${deviceKind}'s measured parameters match this `
      + 'genre\'s recipe');
    return { lanes: [], warnings };
  }

  const want = Math.min(usable.length, lanesWanted(usable, motion));
  const lanes = [];
  for (const recipe of usable.slice(0, want)) {
    const values = new Array(steps).fill(null);
    for (const v of laneValues({ recipe, trigs, total, motion, rng })) {
      if (v.step < steps) values[v.step] = v.value;
    }
    if (!values.some(v => v != null)) continue;
    lanes.push({ name: recipe.name, deviceKind, values });
  }
  return { lanes, warnings };
}

// Exported for the tests, which check a lane's values against the shape it asked
// for without having to go through a whole arrangement.
export { laneValues as laneValuesFor };
