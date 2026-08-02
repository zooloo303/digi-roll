// Chord generation: pure pitch math, no DOM.
//
// Two modes, mirroring the toolbar's scale setting:
//   - diatonic (a scale is passed): walk up the scale in thirds from the
//     clicked row, so every degree gets its natural quality — ii comes out
//     minor, V with a 7th comes out dominant, vii° diminished — with no
//     chord tables. A click on an out-of-scale row snaps to the nearest
//     scale tone (preferring the one below).
//   - fixed quality (no scale): intervals from QUALITIES.
//
// Results are ascending, deduped, kept inside [min, max] and capped at
// MAX_CHORD_NOTES — the hardware-verified per-trig ceiling on the boxes.

export const MAX_CHORD_NOTES = 4;

// Each quality is a triad plus the interval its 7th adds. Major takes the
// major 7th (the lush pad voicing) — for a dominant 7th, use diatonic mode
// on degree V, which produces it naturally.
export const QUALITIES = {
  'Major': { triad: [0, 4, 7], seventh: 11 },
  'Minor': { triad: [0, 3, 7], seventh: 10 },
  'Sus2':  { triad: [0, 2, 7], seventh: 10 },
  'Sus4':  { triad: [0, 5, 7], seventh: 10 },
  'Dim':   { triad: [0, 3, 6], seventh: 9 },
  'Aug':   { triad: [0, 4, 8], seventh: 10 },
};

// Nearest scale tone to an interval-from-root (0-11), searching the octave
// below and above so the wrap (e.g. 11 → the 10 of a pentatonic) works.
// Ties prefer the tone below. Returns the scale index and the semitone
// offset to apply to the clicked pitch.
function snapToScale(iv, intervals) {
  let best = null;
  intervals.forEach((v, k) => {
    for (const oct of [-12, 0, 12]) {
      const off = v + oct - iv;
      const d = Math.abs(off);
      const below = off <= 0;
      if (!best || d < best.d || (d === best.d && below && !best.below)) {
        best = { d, k, off, below };
      }
    }
  });
  return best;
}

function invert(pitches, times) {
  const out = [...pitches].sort((a, b) => a - b);
  const n = ((times % out.length) + out.length) % out.length;
  for (let i = 0; i < n; i++) out.push(out.shift() + 12);
  return out.sort((a, b) => a - b);
}

// scale: { root: 0-11, intervals: ascending semitones from root } or null.
// spread is a drop-2: second-from-top note down an octave, for open voicings.
export function chordPitches(rootPitch, {
  scale = null, quality = 'Major', seventh = false,
  inversion = 0, spread = false, min = 0, max = 127,
} = {}) {
  const size = seventh ? 4 : 3;
  let pitches;
  if (scale) {
    const L = scale.intervals.length;
    const iv = ((rootPitch - scale.root) % 12 + 12) % 12;
    const { k, off } = snapToScale(iv, scale.intervals);
    const base = rootPitch + off;
    pitches = [];
    for (let j = 0; j < size; j++) {
      const deg = k + 2 * j;
      pitches.push(base - scale.intervals[k] + scale.intervals[deg % L] + 12 * Math.floor(deg / L));
    }
  } else {
    const q = QUALITIES[quality] ?? QUALITIES.Major;
    pitches = q.triad.map(i => rootPitch + i);
    if (seventh) pitches.push(rootPitch + q.seventh);
  }
  pitches = invert(pitches, inversion);
  if (spread && pitches.length >= 3) {
    pitches[pitches.length - 2] -= 12;
  }
  return [...new Set(pitches)]
    .filter(p => p >= min && p <= max)
    .sort((a, b) => a - b)
    .slice(0, MAX_CHORD_NOTES);
}

// Pitches → note specs for stamping. Strum staggers micro-timing bottom-up
// (the same per-note field the boxes store, so it survives write-back);
// taper eases the lower notes back a touch so the top of the chord sings.
// strum is the per-note stagger in fractions of a step.
export function voiceChord(pitches, { velocity = 100, strum = 0, taper = true } = {}) {
  const top = pitches.length - 1;
  return pitches.map((pitch, i) => ({
    pitch,
    micro: Math.min(0.49, i * strum),
    velocity: taper
      ? Math.max(1, Math.round(velocity * (1 - 0.07 * (top - i))))
      : velocity,
  }));
}
