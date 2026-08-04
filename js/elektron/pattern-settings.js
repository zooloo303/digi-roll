// Pattern-level settings that live outside the note data. Swing is the first
// one; anything else found in the settings tail belongs here too.
//
// These compose onto a payload instead of going through decodePatternKit or
// encodeTrackNotes — those are hardware-verified and stay untouched — which is
// the same shape readTrackProb/applyTrackProb take for the track PROB byte.

// Swing sits 24 bytes past the pattern name on both boxes, in the settings
// tail (DT2 88764, DN2 88812). Derived from each spec's own nameOffset rather
// than added to the specs, so the device modules need no edit.
//
// It is stored as the *offset from straight*, not the percentage the box shows:
// 0 = 50% (straight), 30 = 80% (as far as the boxes go).
//
// Hardware-verified 2026-08-04 on a DN2 (OS 1.10D, build 0049). In a fresh
// project two untouched patterns are byte-identical, A01 with swing 78% held 28
// where the blanks held 0, and moving it to 65% changed that one byte to 15 and
// nothing else — one edit, one predicted byte. The DT2 fixtures corroborate the
// position: exactly one edited pattern out of 128 holds 5 at the sibling
// offset, every other holds 0. Both docs had already flagged the byte as an
// unknown pattern setting.
const SWING_FROM_NAME = 24;

export const SWING_MIN = 50; // straight
export const SWING_MAX = 80;

const swingOffset = spec => spec.pattern.nameOffset + SWING_FROM_NAME;

// A pattern's swing as the box displays it, 50–80.
//
// A byte past the top of the range reads as straight with a warning rather than
// throwing: it would mean the field has moved, and a pattern we can't fully
// read must still open — the rule readTrackProb and condFromByte both follow.
export function readSwing(spec, payload) {
  const byte = payload[swingOffset(spec)];
  if (byte > SWING_MAX - SWING_MIN) {
    console.warn(`digi-roll: out-of-range swing byte ${byte} — treating as straight`);
    return SWING_MIN;
  }
  return SWING_MIN + byte;
}

// Write a pattern's swing into a payload, in place, and return it. Exactly one
// byte moves. `null`/undefined means straight, because there is no way to store
// "unset" — same bargain applyTrackProb makes with 100%.
//
// This is per *pattern*, unlike everything else digi-roll writes: it changes
// the feel of all sixteen tracks in the slot, not just the one being written.
// Callers that write a single track should say that out loud rather than let it
// be discovered on playback.
export function applySwing(spec, payload, swing) {
  const v = swing == null ? SWING_MIN : Math.max(SWING_MIN, Math.min(SWING_MAX, Math.round(swing)));
  payload[swingOffset(spec)] = v - SWING_MIN;
  return payload;
}
