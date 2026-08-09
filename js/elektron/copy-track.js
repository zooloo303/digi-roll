// Cross-device copy: one track's notes from any decoded pattern into any
// other pattern, on the same box or a different one.
//
// The piano-roll note model is the interchange format. Decode the source with
// its own device spec, take trackNotes(), hand those notes to the target
// device's encodeTrackNotes() — there is deliberately no bytes-level DT2↔DN2
// converter, because the two pattern structs only look alike; the note model
// is the thing both boxes genuinely agree on.
//
// What crosses: trig bits, note, velocity, length, micro-timing, the three
// per-trig conditions (PROB/FILL/COND), the track's own PROB default (what
// unlocked trigs run at) and the track's p-lock lanes. Sounds, kit and the
// pattern's own settings belong to the target and are left exactly as they were
// — this is the same read-modify-write of one track as Phase 2/3, just with the
// notes coming from somewhere else.
//
// p-lock lanes are the one thing here that can fail to cross: see
// plockLanesForTarget below. Between two slots on one box they carry unchanged;
// between boxes they are translated by parameter name, and anything with no
// equivalent is dropped into `warnings` rather than aimed at a guess.
//
// Conditions need no cross-device policy: the DT2 and DN2 store them
// identically and share one 76-value COND list (hardware-verified 2026-08-02),
// so nothing can be dropped for want of a target-side equivalent. If that ever
// stops being true, the place to say so is `warnings`, alongside chord drops —
// loudly, never silently.

import {
  readTrackTrigSettings, applyTrackTrigSettings, attachTrigSettings, trigSettingsFromNotes,
  readTrackProb, applyTrackProb,
} from './trig-cond.js';
import { readTrackPLocks, applyTrackPLocks } from './plocks.js';
import { paramTableFor } from './param-tables.js';
import { paramByPlockId, paramByName, displayFromStored, storedFromDisplay } from './params.js';

// Decoded notes (trackNotes: lenSteps) → the encoder's shape (len), with none
// of the piano roll's clamping: clamping a pitch into the roll's drawable rows
// would silently transpose a note the target box can hold perfectly well.
// js/roll-bridge.js re-exports this for the app layer.
export function deviceNotesToEncoder(notes) {
  return notes.map(n => ({
    step: n.step,
    pitch: n.pitch,
    velocity: n.velocity,
    len: n.lenSteps,
    micro: n.micro,
    prob: n.prob ?? null,
    fill: n.fill ?? null,
    cond: n.cond ?? null,
  }));
}

// A DT2 trig holds at most four note slots; a DN2 trig has no such limit, so a
// fat DN2 chord doesn't always fit. When it doesn't, keep the four
// highest-velocity notes — they're the ones carrying the chord — and on a tie
// keep the lower pitches, which keeps the root and body of the voicing rather
// than the top extensions. The dropped notes are always reported; a chord must
// never quietly lose a note.
export function truncateChords(notes, maxNotes) {
  const byStep = new Map();
  for (const n of notes) {
    const at = byStep.get(n.step) ?? [];
    at.push(n);
    byStep.set(n.step, at);
  }

  const kept = [];
  const drops = [];
  for (const step of [...byStep.keys()].sort((a, b) => a - b)) {
    const group = byStep.get(step);
    if (group.length <= maxNotes) { kept.push(...group); continue; }
    const ranked = [...group].sort((a, b) => b.velocity - a.velocity || a.pitch - b.pitch);
    kept.push(...ranked.slice(0, maxNotes));
    drops.push({ step, dropped: ranked.slice(maxNotes), kept: ranked.slice(0, maxNotes) });
  }
  // Back into the encoder's preferred order: by step, then by pitch.
  kept.sort((a, b) => a.step - b.step || a.pitch - b.pitch);
  return { notes: kept, drops };
}

// Human-readable warning lines for whatever truncateChords had to drop.
export function describeChordDrops(drops, targetName = 'the target') {
  return drops.map(d =>
    `step ${d.step + 1}: ${targetName} holds ${d.kept.length} notes per trig, so ` +
    `${d.dropped.map(n => `note ${n.pitch} (vel ${n.velocity})`).join(', ')} ` +
    `${d.dropped.length === 1 ? 'was' : 'were'} dropped`);
}

// --- p-lock lanes across devices ------------------------------------------------
//
// A paramId is a number in one box's own numbering, so lanes cannot be copied
// byte-for-byte between boxes the way notes and conditions can. They are
// translated by *canonical parameter name*: find what the source paramId means
// in the source's curated table, look that name up in the target's, and rescale
// the values through both descriptors — the two boxes may store the same knob
// differently.
//
// A lane that can't be translated is **dropped and reported**, never guessed at.
// Since Phase 0 filled both curated tables (2026-08-04) that means: a lane whose
// paramId isn't among the eleven measured entries, or a parameter one box has
// and the other doesn't — the same policy as chord truncation, and for the same
// reason: silently moving a lock onto the wrong knob is worse than not moving
// it.
//
// Copying between two slots on the *same* box needs no translation at all, and
// `sourceKind === targetKind` short-circuits to a straight carry.
//
// Returns { lanes, warnings }, lanes in applyTrackPLocks's shape.
export function plockLanesForTarget(lanes, sourceKind, targetKind) {
  if (!lanes?.length) return { lanes: [], warnings: [] };
  if (sourceKind === targetKind) {
    return { lanes: lanes.map(l => ({ paramId: l.paramId, values: l.values })), warnings: [] };
  }

  const fromTable = paramTableFor(sourceKind);
  const toTable = paramTableFor(targetKind);
  const out = [];
  const warnings = [];
  for (const lane of lanes) {
    const hex = `0x${lane.paramId.toString(16).padStart(2, '0')}`;
    // The source paramId has to resolve to a parameter we know, or there is
    // nothing to translate *by*. That is the ordinary case today: no paramId has
    // been measured on either box, so every cross-device lane copy says so.
    const from = paramByPlockId(fromTable, lane.paramId);
    if (!from) {
      warnings.push(`p-lock lane on ${sourceKind} parameter ${hex} wasn't copied — `
        + `digi-roll doesn't know which parameter that is yet, so it can't say what it would be on a ${targetKind}`);
      continue;
    }
    const to = paramByName(toTable, from.name);
    if (!to?.writable) {
      warnings.push(`p-lock lane “${from.label}” wasn't copied — `
        + (to ? `digi-roll hasn't measured where a ${targetKind} stores it` : `the ${targetKind} has no equivalent parameter`));
      continue;
    }
    out.push({
      paramId: to.plock.id,
      // Out of the source's stored words, onto the shared display axis, then into
      // the target's stored words — so a difference in either box's scaling is
      // handled rather than assumed away.
      values: lane.values.map(v => (v == null ? null : storedFromDisplay(to, displayFromStored(from, v)))),
    });
  }
  return { lanes: out, warnings };
}

// Read one track's notes out of an already-decoded source pattern, in the
// shape encodeTrackNotes wants, truncated to what the target device can hold.
// `sourceMod` / `targetMod` are the per-device modules (dt2/pattern.js etc.).
//
// `sourcePayload` is optional and only needed to carry trig conditions: they
// live in per-step lanes that decodePatternKit doesn't surface, so they are
// read from the raw bytes and stamped onto the notes. Every note on a step
// gets the same values, which is what makes chord truncation safe — whichever
// notes survive, the step's settings survive with them.
export function trackNotesForTarget(sourceMod, sourcePatternKit, sourceTrack, targetMod, sourcePayload = null) {
  const decoded = sourceMod.trackNotes(sourcePatternKit, sourceTrack);
  const notes = deviceNotesToEncoder(decoded);
  if (sourcePayload) {
    attachTrigSettings(notes, readTrackTrigSettings(sourceMod.SPEC, sourcePayload, sourceTrack));
  }
  return truncateChords(notes, targetMod.SPEC.trig.maxNotes);
}

// The whole copy: source pattern + track → a new target payload.
//
//   sourceMod/targetMod   per-device modules; pass the same one twice to copy
//                         between two patterns on one box
//   sourcePatternKit      already decoded (it may have come from a .syx file)
//   targetPayload         freshly fetched bytes of the pattern being written
//
// Returns { payload, notes, dropped, drops, warnings }. `dropped` counts notes
// encodeTrackNotes itself couldn't place (it should be 0 — chord truncation
// happens here first, where the policy is explicit).
export function copyTrack({
  sourceMod, sourcePatternKit, sourcePayload = null, sourceTrack,
  targetMod, targetPayload, targetTrack,
  targetName = targetMod?.SPEC?.device ?? 'the target',
}) {
  const { notes, drops } = trackNotesForTarget(sourceMod, sourcePatternKit, sourceTrack, targetMod, sourcePayload);
  const { payload, dropped } = targetMod.encodeTrackNotes(targetPayload, targetTrack, notes);
  // Conditions ride on the payload encodeTrackNotes just returned — a fresh
  // copy, so this is the only mutation of an already-cloned buffer.
  applyTrackTrigSettings(targetMod.SPEC, payload, targetTrack, trigSettingsFromNotes(notes));
  const laneWarnings = [];
  // The track's PROB default is part of how the copied trigs sound, so it
  // travels with them — but only when we have the source bytes to read it from.
  if (sourcePayload) {
    applyTrackProb(targetMod.SPEC, payload, targetTrack,
      readTrackProb(sourceMod.SPEC, sourcePayload, sourceTrack));
    // p-lock lanes likewise: they're part of how the track sounds, and they live
    // in bytes decodePatternKit doesn't surface. Translation happens before the
    // write so an untranslatable lane is reported instead of aimed at a guess,
    // and applyTrackPLocks adds its own warning if the target's 80 lanes are
    // already full.
    const source = readTrackPLocks(sourceMod.SPEC, sourcePayload, sourceTrack);
    const { lanes, warnings } = plockLanesForTarget(source, sourceMod.SPEC.device, targetMod.SPEC.device);
    laneWarnings.push(...warnings);
    const applied = applyTrackPLocks(targetMod.SPEC, payload, targetTrack, lanes);
    laneWarnings.push(...applied.warnings);
  }
  // Swing deliberately does NOT travel. It belongs to the whole pattern, so
  // carrying it would let a one-track copy silently re-time the fifteen tracks
  // already in the target slot — the opposite of what this function promises.
  // The main "Send to box" path does write it, because there the roll's pattern
  // is the pattern; here the target is somebody else's.
  return {
    payload, notes, dropped, drops,
    warnings: [...describeChordDrops(drops, targetName), ...laneWarnings],
  };
}
