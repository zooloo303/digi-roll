// The seam between the piano-roll note model (js/state.js) and Elektron
// pattern notes (js/elektron/pattern-core.js), plus the provenance record that
// lets an imported slot find its way home.
//
// Two note shapes meet here and they are deliberately close but not identical:
//
//   roll note    { id, step, pitch, len, velocity, micro, prob, fill, cond }
//   device note  { step, pitch, velocity, len, micro, prob, fill, cond }
//   decoded note { step, pitch, velocity, lenSteps, micro }  — trackNotes output
//
// `micro` is a fraction of a step in all three. The conversions below are the
// only place that knows about the lenSteps/len rename and the roll's clamps,
// so the import path, the write-back path and cross-device copy can't drift.
//
// prob/fill/cond are per *trig*, so `trackNotes` (which is per note) doesn't
// produce them — attachTrigSettings stamps them on afterwards, from the pattern
// payload's per-step lanes.

import { makeNote, makePLockLane } from './state.js';
import { PITCH_MIN, PITCH_MAX } from './pianoroll.js';
import { bankName, lengthByteToSteps, stepsToLengthByte } from './elektron/pattern-core.js';
import { laneHasTriglessValues } from './elektron/plocks.js';
import { paramTableFor } from './elektron/param-tables.js';
import { describeParam, displayFromStored, storedFromDisplay } from './elektron/params.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The shortest note the boxes can store: length byte 0. Everything below two
// steps is stored in 1/16-step increments, so this is a real musical value
// rather than a rounding artefact.
export const LEN_MIN = 0.125;

// Snap a length in steps to the nearest value a box can actually hold, so a
// fine resize in the roll shows exactly what will land on the hardware rather
// than a number that quietly rounds on write. This is the whole of what the
// piano roll knows about devices, and it arrives injected (`snapLen`) rather
// than imported — the roll itself stays device-agnostic.
//
// `maxSteps` is the room left in the pattern. Snapping picks the *nearest*
// representable length, which can round up past that room, so the result is
// walked back down the length scale until it fits.
export function snapLenFine(steps, maxSteps = Infinity) {
  const want = clamp(steps, LEN_MIN, Math.max(LEN_MIN, maxSteps));
  let byte = stepsToLengthByte(want);
  while (byte > 0 && lengthByteToSteps(byte) > maxSteps) byte--;
  return lengthByteToSteps(byte);
}

// The LEN scale as a slider axis, for a UI that wants to offer exactly the
// lengths the hardware holds. Byte 0-126 is the boxes' own spacing — fine at
// the bottom, coarse at the top — so a slider over it spends its travel where
// the musical resolution actually is, unlike a linear ramp in steps.
export { lengthByteToSteps as lenByteToSteps, stepsToLengthByte as lenStepsToByte } from './elektron/pattern-core.js';

// Roll slot length for a device track: whole bars, at least one, at most eight.
export function rollLengthForTrack(track) {
  return Math.min(128, Math.max(16, Math.ceil(track.lengthSteps / 16) * 16));
}

// Decoded device notes → piano-roll notes. Pitches are clamped to the rows the
// roll can draw and lengths to the room left in the slot; everything else
// survives untouched. Lengths are *not* rounded to whole steps — the roll draws
// and edits fractions now, and a value off the wire is representable by
// construction, so a 4.75-step trig comes home as 4.75.
export function deviceNotesToRoll(notes, lengthSteps) {
  return notes.map(n => makeNote(
    n.step,
    clamp(n.pitch, PITCH_MIN, PITCH_MAX),
    clamp(n.lenSteps, LEN_MIN, lengthSteps - n.step),
    n.velocity,
    n.micro,
    { prob: n.prob ?? null, fill: n.fill ?? null, cond: n.cond ?? null },
  ));
}

// Piano-roll notes → the encoder's note shape: drop the id the box has no
// concept of, pass the rest through unchanged.
export function rollNotesToDevice(notes) {
  return notes.map(n => ({
    step: n.step,
    pitch: n.pitch,
    velocity: n.velocity,
    len: n.len,
    micro: n.micro ?? 0,
    prob: n.prob ?? null,
    fill: n.fill ?? null,
    cond: n.cond ?? null,
  }));
}

// Stamping per-step settings onto notes lives with the settings themselves
// (device layer) and is re-exported here, like deviceNotesToEncoder below, so
// app-layer callers have one place to look. It runs between trackNotes and
// deviceNotesToRoll at each import site.
export { attachTrigSettings } from './elektron/trig-cond.js';

// Decoded device notes → the encoder's note shape, with none of the roll's
// clamping: the interchange format for cross-device copy. It lives with the
// copy code (device layer) and is re-exported here so app-layer callers have
// one place to look for note conversions.
export { deviceNotesToEncoder } from './elektron/copy-track.js';

// --- p-lock lanes -------------------------------------------------------------
//
// This seam converts between the lane's **display axis** (what the roll draws and
// the audition path sends — MIDI 0–127 for a curated parameter) and the lane
// pool's **stored uint16**. The conversion lives in the parameter descriptor, and
// for a parameter whose p-lock scaling hasn't been measured on hardware yet there
// is no conversion at all: such a lane can be drawn and heard but not written,
// and this is where that gets said out loud rather than guessed.
//
// The seam also enforces the v1 rule from PLAN.md: locks live on steps with trigs.

// The descriptor for a roll lane, curated by name where we authored it.
export const laneDescriptor = lane =>
  describeParam(paramTableFor(lane.deviceKind), lane);

// Device lanes (readTrackPLocks) → roll lanes. `liveSteps` is the set of steps
// that actually have trigs; a lane holding a value anywhere else is a trigless
// lock, which v1 doesn't model, so it comes in flagged and stays read-only.
//
// A lane whose paramId matches a curated parameter comes in *named*, and its
// words are converted to the display axis on the way. Until Phase 0 measures the
// paramIds nothing matches, so every imported lane arrives raw — which is why the
// raw descriptor's scaling is the identity, keeping it byte-exact on the way back.
export function devicePLocksToRoll(lanes, deviceKind, liveSteps = new Set()) {
  const table = paramTableFor(deviceKind);
  return lanes.map(l => {
    const p = describeParam(table, { paramId: l.paramId, deviceKind });
    return makePLockLane({
      name: p.name,
      paramId: l.paramId,
      deviceKind,
      values: l.values.map(v => (v == null ? null : displayFromStored(p, v))),
      trigless: laneHasTriglessValues(l, liveSteps),
    });
  });
}

// Roll lanes → what applyTrackPLocks writes, as { lanes, warnings }.
//
// Three reasons a lane doesn't make it, each reported rather than silent:
//
//   * it belongs to the other box's parameter numbering — crossing devices is
//     copy-track's job, and it translates by name first;
//   * its parameter's p-lock paramId hasn't been measured on hardware yet, so
//     there is no byte to write it to. This is the ordinary case today, and it is
//     the difference between "you can hear this" and "you can send this";
//   * it holds no values at all.
export function rollPLocksToDevice(plocks, deviceKind) {
  const lanes = [];
  const warnings = [];
  for (const l of plocks ?? []) {
    if (l.deviceKind && deviceKind && l.deviceKind !== deviceKind) {
      warnings.push(`the ${laneDescriptor(l).label} lane wasn't sent — it belongs to a `
        + `${l.deviceKind}'s parameter numbering, not this ${deviceKind}'s`);
      continue;
    }
    const p = describeParam(paramTableFor(deviceKind), l);
    if (!p.writable) {
      warnings.push(`the ${p.label} lane wasn't sent — digi-roll can play that parameter over MIDI `
        + 'but hasn\'t yet measured which p-lock slot the pattern format stores it in, '
        + 'so it can\'t write it into the pattern');
      continue;
    }
    const values = l.values.map(v => (v == null ? null : storedFromDisplay(p, v)));
    if (!values.some(v => v != null)) continue;
    lanes.push({ paramId: p.plock.id, values });
  }
  return { lanes, warnings };
}

const stepsWithNotes = notes => new Set(notes.map(n => n.step));

// --- The audition path --------------------------------------------------------
//
// What the realtime engine should send so a p-lock lane can be *heard* on the box
// before anything is written into a pattern. This is the half of the feature that
// needs no reverse engineering at all: the CC and NRPN numbers come from the
// boxes' own published MIDI charts.
//
// Returned messages are already resolved down to wire terms, so js/midi.js stays
// device-agnostic the way js/pianoroll.js does — main.js injects this, exactly as
// it injects `snapLen`.
//
// `value14` is the display value in the top 7 bits (`display << 7`), which puts
// the box's parameter at the same place a plain CC of that value would. The lane's
// axis is 0–127, so the low bits are unused; a future high-resolution lane can
// fill them without changing anything here.
export function plockMessagesForStep(plocks, step) {
  const out = [];
  for (const lane of plocks ?? []) {
    const v = lane.values?.[step];
    if (v == null) continue;
    const p = laneDescriptor(lane);
    if (!p.auditable) continue; // a lane off a box whose parameter we can't name
    out.push({
      label: p.label,
      nrpn: p.midi.nrpn,
      cc: p.midi.cc,
      value7: Math.max(0, Math.min(127, Math.round(v))),
      value14: Math.max(0, Math.min(0x3fff, Math.round(v) << 7)),
    });
  }
  return out;
}

// Does this pattern have anything the audition path would send? The UI asks, so
// it can warn that playing will move the box's own parameters — and only when it
// actually would.
export const hasAuditableLanes = plocks =>
  (plocks ?? []).some(l => l.values?.some(v => v != null) && laneDescriptor(l).auditable);

// Drop lane values from steps that no longer have a trig. The v1 rule, applied
// on the way out: deleting a note deletes the locks that were riding on it,
// exactly as the box scrubs a deleted trig's condition bytes. Read-only lanes
// (uncurated, or trigless from the box) are exempt — those are being passed
// through byte-exact and it is not our place to prune them.
export function pruneLanesToTrigs(plocks, notes, isEditable) {
  const live = stepsWithNotes(notes);
  for (const lane of plocks ?? []) {
    if (!isEditable(lane)) continue;
    lane.values = lane.values.map((v, step) => (live.has(step) ? v : null));
  }
  return plocks;
}

export { laneHasTriglessValues };

// Cross-device lane translation lives with the copy code, and is re-exported
// here with the note conversions for the same reason they are.
export { plockLanesForTarget } from './elektron/copy-track.js';

// --- Provenance ---------------------------------------------------------------

// Where a roll slot's notes came from. Stored on the pattern (state.js) and in
// bank saves, so "write back" knows the box, pattern slot and track to target —
// and can refuse when the box currently plugged in isn't the one it came from.
export function makeSource({
  slug, productId = null, deviceName = '', patternIndex, trackIndex,
  patternName = '', origin = 'box', importedAt = new Date().toISOString(),
}) {
  return { slug, productId, deviceName, patternIndex, trackIndex, patternName, origin, importedAt };
}

// "A01 T11" — the slot on the box, without the device name.
export function sourceSlotLabel(source) {
  return source ? `${bankName(source.patternIndex)} T${source.trackIndex + 1}` : '';
}

// "Digitakt II A01 T11" — the full "where this came from".
export function sourceLabel(source) {
  if (!source) return '';
  return `${source.deviceName || source.slug || 'box'} ${sourceSlotLabel(source)}`;
}

// Is the connected box the one this slot was imported from? Product id is the
// authority (it's what the box reports); slug is the fallback for provenance
// recorded from a .syx file, where there was no handshake to ask.
export function sourceMatchesIdentity(source, identity) {
  if (!source || !identity) return false;
  if (source.productId != null && identity.productId != null) {
    return source.productId === identity.productId;
  }
  return !!source.slug && source.slug === identity.slug;
}
