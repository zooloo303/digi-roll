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

import { makeNote } from './state.js';
import { PITCH_MIN, PITCH_MAX } from './pianoroll.js';
import { bankName, lengthByteToSteps, stepsToLengthByte } from './elektron/pattern-core.js';

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
