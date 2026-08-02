// The seam between the piano-roll note model (js/state.js) and Elektron
// pattern notes (js/elektron/pattern-core.js), plus the provenance record that
// lets an imported slot find its way home.
//
// Two note shapes meet here and they are deliberately close but not identical:
//
//   roll note    { id, step, pitch, len, velocity, micro }   — what you draw
//   device note  { step, pitch, velocity, len, micro }       — encodeTrackNotes input
//   decoded note { step, pitch, velocity, lenSteps, micro }  — trackNotes output
//
// `micro` is a fraction of a step in all three. The conversions below are the
// only place that knows about the lenSteps/len rename and the roll's clamps,
// so the import path, the write-back path and cross-device copy can't drift.

import { makeNote } from './state.js';
import { PITCH_MIN, PITCH_MAX } from './pianoroll.js';
import { bankName } from './elektron/pattern-core.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Roll slot length for a device track: whole bars, at least one, at most eight.
export function rollLengthForTrack(track) {
  return Math.min(128, Math.max(16, Math.ceil(track.lengthSteps / 16) * 16));
}

// Decoded device notes → piano-roll notes. Pitches are clamped to the rows the
// roll can draw and lengths rounded to whole steps, because that is what the
// editor can represent; everything else survives untouched.
export function deviceNotesToRoll(notes, lengthSteps) {
  return notes.map(n => makeNote(
    n.step,
    clamp(n.pitch, PITCH_MIN, PITCH_MAX),
    clamp(Math.round(n.lenSteps), 1, lengthSteps - n.step),
    n.velocity,
    n.micro,
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
  }));
}

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
