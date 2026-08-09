// The orchestrator: a song context in, one result per part out.
//
// Two properties this module exists to guarantee, both of which are what make the
// seed lock feel right:
//
//   * **Each part draws from its own stream** (`rngFor(seed, role)`), so nudging
//     the lead's density doesn't reshuffle the bass.
//   * **All three parts are always generated**, even the ones whose checkbox is
//     off. Their trigs still feed the shared rhythm map, so unchecking the bass
//     doesn't move the lead — the lead answers the bassline it would have had.
//     The caller applies only the parts marked `on`.
//
// Order is bass → chords → lead, each handed the accumulated rhythm map. That one
// piece of shared state is the whole of what buys call-and-response.
//
// Nothing here encodes a byte. A result is ordinary pattern state — roll notes and
// p-lock lanes — which leaves for the box through the existing `safeWriteTrack`
// path unchanged.

import { makeNote, makePLockLane } from '../state.js';
import { rngFor } from './rng.js';
import { resolveContext, GEN_ROLES } from './context.js';
import { generateBass } from './parts/bass.js';
import { generateChords } from './parts/chords.js';
import { generateLead } from './parts/lead.js';
import { designLanes } from './plockdesign.js';

const GENERATORS = { bass: generateBass, chords: generateChords, lead: generateLead };

// The band order, which is also the order the rhythm map is built in.
export const ROLE_ORDER = GEN_ROLES;

// One part, as pattern state.
//
// `notes` are real roll notes (ids and all), so a caller can drop them straight
// onto a pattern; `plocks` are real lanes. The trig list comes back too, which is
// what the next part reads.
// A part's stream tag. `variation` is what "Generate this slot" bumps: it gives
// that one part a different stream while every other part keeps the song seed's,
// so re-rolling the lead leaves the bass exactly as it is *and* the new lead
// still answers the bassline actually sitting in the slot. Rolling the seed
// instead would move all three, which is what "Generate arrangement" is for.
export const streamTag = (role, variation = 0) => (variation ? `${role}#${variation}` : role);

function buildPart(role, ctx, band, { deviceKind }) {
  const tag = streamTag(role, ctx.parts[role].variation);
  const rng = rngFor(ctx.seed, tag);
  const { notes: specs, trigs } = GENERATORS[role](ctx, rng, band);

  // The lane rng is its own stream: drawing lanes must not shift the notes, so
  // that turning Motion up doesn't rewrite the music.
  const laneRng = rngFor(ctx.seed, `${tag}.lanes`);
  const { lanes, warnings } = designLanes({
    role: ctx.roles[role],
    deviceKind,
    trigs,
    total: ctx.lengthSteps,
    motion: ctx.feel.motion,
    rng: laneRng,
  });

  return {
    role,
    slot: ctx.parts[role].slot,
    on: ctx.parts[role].on,
    lengthSteps: ctx.lengthSteps,
    notes: specs.map(n => makeNote(n.step, n.pitch, n.len, n.velocity, n.micro, n)),
    plocks: lanes.map(l => makePLockLane(l)),
    trigs,
    trigCount: new Set(specs.map(n => n.step)).size,
    warnings,
  };
}

// Generate the whole arrangement.
//
//   ctx         the song context (js/gen/context.js), unresolved is fine
//   deviceKind  'DT2' / 'DN2' / null — which box's parameter numbering the p-lock
//               lanes belong to. null means no lanes, and a warning saying why.
//
// Returns `{ context, parts, warnings }` where `parts` is keyed by role. Throws
// only on a malformed progression, with the parser's message.
export function generateArrangement(rawContext, { deviceKind = null } = {}) {
  const ctx = resolveContext(rawContext);
  const band = { busy: new Set() };
  const parts = {};
  const warnings = [];

  for (const role of ROLE_ORDER) {
    const part = buildPart(role, ctx, band, { deviceKind });
    parts[role] = part;
    // Only a part that is actually being used should claim steps in the busy map…
    // except that it must claim them whether or not it is applied, or the lead
    // would move when the bass checkbox changed. So every part registers, and
    // `on` decides what the caller writes.
    for (const t of part.trigs) band.busy.add(t.step);
    for (const w of part.warnings) if (part.on && !warnings.includes(w)) warnings.push(w);
  }

  return { context: ctx, parts, warnings };
}

// One part, against the same context — "Generate this slot".
//
// It runs the *whole* arrangement and returns one part of it, which is the point:
// the lead you re-roll on its own is exactly the lead the full arrangement would
// have produced, because the rhythm map it answered is the same one.
export function generatePart(rawContext, role, { deviceKind = null } = {}) {
  const result = generateArrangement(rawContext, { deviceKind });
  const part = result.parts[role];
  if (!part) throw new Error(`unknown part ${JSON.stringify(role)}`);
  return { context: result.context, part, warnings: part.warnings };
}

// Apply a generated part to a pattern slot, in place.
//
// **The list of fields this touches is the feature's safety story**, so it lives
// in one function rather than at each call site:
//
//   * `notes`, `plocks` and `lengthSteps` are replaced — that is the generation;
//   * `name` is set, so the slot dropdown says what's in it;
//   * `swing` is *not* touched. It re-times all sixteen tracks in the destination
//     pattern, so genre groove is per-note micro-timing instead (see genres.js);
//   * `trackProb`, `channel`, `source` and `dest` are *not* touched either. Track
//     PROB is a default you set; the generator expresses chance through per-trig
//     PROB locks, which is the hardware's own model.
export function applyPartToPattern(pattern, part, { label = '' } = {}) {
  pattern.lengthSteps = part.lengthSteps;
  pattern.notes = part.notes;
  pattern.plocks = part.plocks;
  if (label) pattern.name = label;
  return pattern;
}
