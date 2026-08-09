// The song context: everything above the eight pattern slots.
//
// Lives at `state.gen` (js/state.js), which declares the field and nothing more:
// the backfill is `normalizeGenContext` and it runs when the Generate panel is
// constructed at start-up, so an older save simply gets the defaults and no
// schema bump was needed. Deliberately *not* done inside `loadState` — that would
// make js/state.js import this file, which reaches js/gen/theory.js and so
// js/pianoroll.js, which imports js/state.js. A cycle through the one module
// everything else depends on is worth one line of wiring to avoid.
//
// **Root and scale are the Harmony panel's own values.** `state.scaleRoot` and
// `state.scale` are the editable truth; the copies here exist because
// `state.scale` can be `off` (row tinting off) and the generator always needs a
// scale to work in. So the fields below are a *fallback*, kept in step by the
// panel: choosing a scale in the generate panel sets both, and the tinted rows on
// the grid always agree with what was generated.
//
// The progression is stored as **text**, not as a parsed array. One source of
// truth for the field you type in, a malformed entry keeps the last good text,
// and `resolveContext` is the only place that parses — which is also where the
// error message a user sees comes from.

import { GENRE_IDS, genreProfile } from './genres.js';
import { defaultProgressionFor } from './progressions.js';
import {
  parseProgression, progressionBars, barSlots, scaleIntervals, isScaleName, DEFAULT_SCALE,
} from './theory.js';

export const GEN_ROLES = ['bass', 'chords', 'lead'];
export const GEN_BARS = [1, 2, 4, 8];

export const ROLE_LABELS = { bass: 'Bass', chords: 'Chords', lead: 'Lead' };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampInt = (v, lo, hi, fallback) =>
  Number.isFinite(+v) ? clamp(Math.round(+v), lo, hi) : fallback;

export function defaultGenContext() {
  return {
    genre: 'dnb',
    // Mirrors of state.scaleRoot / state.scale — see the header.
    root: 0,
    scale: DEFAULT_SCALE,
    bars: 2,
    progression: defaultProgressionFor('dnb'),
    seed: 1834721,
    seedLocked: false,
    feel: { motion: 35, looseness: 35, humanize: 20 },
    parts: {
      // Slots 1–3 by default, which lines up with tracks 1–3 on the box if you
      // send them in order. Octaves are the register windows from the design:
      // bass C2–C4, chords C4–C6, lead C5–up.
      bass: { on: true, slot: 0, density: 55, octave: 2, variation: 0 },
      chords: { on: true, slot: 1, density: 40, octave: 4, variation: 0 },
      lead: { on: true, slot: 2, density: 40, octave: 5, variation: 0 },
    },
  };
}

// Anything from storage, a bank file or a hand edit → a context the generator can
// use. Never throws: a broken field takes the default, because the panel has to
// open.
export function normalizeGenContext(raw, slots = 8) {
  const d = defaultGenContext();
  const g = raw && typeof raw === 'object' ? raw : {};
  const genre = GENRE_IDS.includes(g.genre) ? g.genre : d.genre;
  const out = {
    genre,
    root: clampInt(g.root, 0, 11, d.root),
    scale: isScaleName(g.scale) ? g.scale : d.scale,
    bars: GEN_BARS.includes(+g.bars) ? +g.bars : d.bars,
    progression: typeof g.progression === 'string' && g.progression.trim()
      ? g.progression.trim()
      : defaultProgressionFor(genre),
    seed: Number.isFinite(+g.seed) ? (Math.floor(+g.seed) >>> 0) : d.seed,
    seedLocked: !!g.seedLocked,
    feel: {
      motion: clampInt(g.feel?.motion, 0, 100, d.feel.motion),
      looseness: clampInt(g.feel?.looseness, 0, 100, d.feel.looseness),
      humanize: clampInt(g.feel?.humanize, 0, 100, d.feel.humanize),
    },
    parts: {},
  };
  for (const role of GEN_ROLES) {
    const p = g.parts?.[role] ?? {};
    out.parts[role] = {
      on: p.on === undefined ? d.parts[role].on : !!p.on,
      slot: clampInt(p.slot, 0, slots - 1, d.parts[role].slot),
      density: clampInt(p.density, 0, 100, d.parts[role].density),
      octave: clampInt(p.octave, 1, 7, d.parts[role].octave),
      // Which re-roll of this part we're on. "Generate this slot" bumps it, so
      // that part gets a new stream while the song seed — and therefore every
      // other part — stays put. See `streamTag` in js/gen/arrange.js.
      variation: clampInt(p.variation, 0, 1e6, d.parts[role].variation),
    };
  }
  return out;
}

// Switching genre re-defaults the things that are *about* the genre — its bar
// count and its progression — and leaves the things that are about you: the seed,
// the feel sliders, the part densities, the slots. Changing genre with a
// hand-typed progression keeps it: you typed it, it isn't ours to throw away.
export function contextForGenre(ctx, genre, { keepProgression = false } = {}) {
  const profile = genreProfile(genre);
  return {
    ...normalizeGenContext(ctx),
    genre: profile.id,
    bars: GEN_BARS.includes(profile.bars) ? profile.bars : ctx.bars,
    progression: keepProgression ? ctx.progression : defaultProgressionFor(profile.id),
  };
}

// The context every generator function actually takes: normalized, with the
// progression parsed and the derived values worked out once.
//
// Throws with the parser's own message when the progression is malformed — the
// one error the panel expects and reports on the status line.
export function resolveContext(raw) {
  const ctx = normalizeGenContext(raw);
  const profile = genreProfile(ctx.genre);
  const prog = parseProgression(ctx.progression);
  const intervals = scaleIntervals(ctx.scale);
  return {
    ...ctx,
    profile,
    roles: profile.roles,
    groove: profile.groove,
    key: { root: ctx.root, intervals },
    prog,
    barSlots: barSlots(prog, ctx.bars),
    lengthSteps: ctx.bars * 16,
  };
}

// Is a progression text usable? The panel asks before committing an edit, so a
// half-typed chord doesn't wipe the last good one. `bars` comes back with it,
// because the hint under the field wants to say how long the loop is and this is
// the only place that parses.
export function checkProgression(text) {
  try {
    const prog = parseProgression(text);
    return { ok: true, error: null, bars: progressionBars(prog) };
  } catch (err) {
    return { ok: false, error: err.message, bars: 0 };
  }
}

// The bpm the genre suggests, and whether the transport is already there. The
// panel offers it; nothing changes the tempo behind your back.
export function bpmSuggestion(ctx, bpm) {
  const profile = genreProfile(ctx.genre);
  const [lo, hi] = profile.bpmRange;
  return { bpm: profile.bpm, inRange: bpm >= lo && bpm <= hi, range: profile.bpmRange };
}

// Which slots a generate would overwrite, so the confirm can name them.
export const targetSlots = ctx =>
  GEN_ROLES.filter(r => ctx.parts[r].on).map(r => ctx.parts[r].slot);

// Which part a slot belongs to, or null — "Generate this slot" needs to know
// which role the slot you're editing is holding.
export const roleForSlot = (ctx, slot) =>
  GEN_ROLES.find(r => ctx.parts[r].slot === slot) ?? null;

// A fresh arrangement is the canonical one for its seed, so every part's re-roll
// counter goes back to zero.
export const withVariationsReset = ctx => ({
  ...ctx,
  parts: Object.fromEntries(GEN_ROLES.map(r => [r, { ...ctx.parts[r], variation: 0 }])),
});

// One part re-rolled: only that part's stream moves.
export const withVariationBumped = (ctx, role) => ({
  ...ctx,
  parts: { ...ctx.parts, [role]: { ...ctx.parts[role], variation: (ctx.parts[role].variation ?? 0) + 1 } },
});

// What a generated slot gets called, so the slot dropdown says what's in it.
export const partLabel = (ctx, role) =>
  `${genreProfile(ctx.genre).label} ${ROLE_LABELS[role].toLowerCase()}`;
