// Editing maths that wants testing without a canvas.
//
// The piano roll (js/pianoroll.js) owns gestures and drawing; main.js owns the
// clipboard and the undo stack. Deciding *where* pasted notes land is neither,
// and it carries more edge cases than either module wants to hide inside a
// mouse handler — off the end of the pattern, off the top or bottom of the
// drawable rows, and the "you haven't clicked anywhere yet" case. So it lives
// here, as plain functions over plain objects.

// Both resize helpers read `{ step, len }` off each entry and return an array of
// lengths parallel to it rather than mutating, so the gesture code assigns them
// and the maths stays testable. A drag passes entries holding the lengths it
// began with, which is what keeps one delta from compounding per mousemove.
// `snapLen(steps, maxSteps)` is the device's LEN scale (injected, like the
// roll's own) — with it, every length handed back is one the hardware can
// actually store; without it they only clamp. `minLen` is the floor a drag
// works to, which is a whole step for a coarse drag and the shortest
// representable length for a fine one.
const lengthsFor = (notes, want, { lengthSteps, snapLen, minLen }) =>
  notes.map((n, i) => {
    const room = lengthSteps - n.step;
    const len = want(n, i);
    return snapLen ? snapLen(len, room) : Math.max(minLen, Math.min(len, room));
  });

// Dragging one note's edge with a selection behind it: every note moves by the
// same delta, so a mix of long and short notes stays a mix. The delta is
// clamped **once for the whole group** — the deepest shrink any member can
// take, the smallest growth any member has room for — because clamping note by
// note would flatten exactly the differences this mode exists to preserve. The
// cost is that the grabbed note stops following the pointer once some other
// member hits its limit, which is the bargain a group move already makes.
export function resizeSelectionBy(notes, delta, { lengthSteps, snapLen = null, minLen = 1 }) {
  if (!notes.length) return [];
  const floor = Math.max(...notes.map(n => minLen - n.len));
  const ceil = Math.min(...notes.map(n => lengthSteps - n.step - n.len));
  const d = Math.max(floor, Math.min(delta, Math.max(floor, ceil)));
  return lengthsFor(notes, n => n.len + d, { lengthSteps, snapLen, minLen });
}

// The LEN control: every selected note takes the same length. Clamped **per
// note** here, unlike the drag — asking for four steps when one note has two
// steps of room means that note takes two, rather than holding the whole
// selection back to the shortest room available.
export function setSelectionLength(notes, len, { lengthSteps, snapLen = null, minLen = 1 }) {
  return lengthsFor(notes, () => len, { lengthSteps, snapLen, minLen });
}

// The note a paste hangs off: earliest step, and among ties the highest pitch.
// That is the top-left corner of the copied block as it looks on the grid,
// which is what the caret should line up with.
export function clipboardAnchor(clip) {
  return clip.reduce((best, n) =>
    !best || n.step < best.step || (n.step === best.step && n.pitch > best.pitch) ? n : best, null);
}

// Where a clipboard's notes go on paste.
//
//   clip    notes as copySelection stored them: { step, pitch, len, velocity,
//           micro, prob, fill, cond } — no ids, they are reissued by the caller
//   caret   { step, pitch } the last grid cell that was clicked, or null
//   bounds  { lengthSteps, pitchMin, pitchMax } of the pattern being pasted into
//
// With a caret, the whole block is offset so its anchor lands on the caret,
// preserving relative timing and pitch; anything whose *start* falls outside
// the pattern or the drawable rows is dropped rather than clamped, because a
// clamped note lands somewhere you didn't ask for and quietly stacks on a
// neighbour. Lengths still clamp to the pattern end — that only shortens a
// note, it never moves one.
//
// With no caret (nothing clicked since the page loaded) the old
// absolute-position behaviour stands: notes land back on their source steps.
//
// Returns { notes, dropped }.
export function placeClipboard(clip, caret, { lengthSteps, pitchMin, pitchMax }) {
  if (!clip?.length) return { notes: [], dropped: 0 };
  const anchor = caret ? clipboardAnchor(clip) : null;
  const dStep = anchor ? caret.step - anchor.step : 0;
  const dPitch = anchor ? caret.pitch - anchor.pitch : 0;

  const notes = [];
  let dropped = 0;
  for (const c of clip) {
    let step, pitch;
    if (anchor) {
      step = c.step + dStep;
      pitch = c.pitch + dPitch;
      if (step < 0 || step >= lengthSteps || pitch < pitchMin || pitch > pitchMax) { dropped++; continue; }
    } else {
      step = Math.min(c.step, lengthSteps - 1);
      pitch = c.pitch;
    }
    notes.push({ ...c, step, pitch, len: Math.min(c.len, lengthSteps - step) });
  }
  return { notes, dropped };
}
