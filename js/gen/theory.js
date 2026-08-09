// Key, scale and chord maths for the generator. Pure, canvas-free, device-free.
//
// Two deliberate reuses, so the generator can never disagree with what the app
// already does:
//
//   * scales are `SCALES` from js/pianoroll.js — the same eight the Harmony
//     panel tints rows with;
//   * chord tones come from `chordPitches` in js/chords.js — the existing
//     diatonic thirds-walker. A degree gets its natural quality (ii minor, V7
//     dominant, vii° diminished) with no chord tables anywhere, exactly as
//     chord draw does. Which also means the 4-note hardware ceiling and the
//     window clamping are already handled.
//
// Roman numerals are the progression language: `i VI III VII`. Case is
// cosmetic — the quality comes from the scale unless a token names one — which
// is why `i VI III VII` and `I VI III VII` in a minor key produce the same
// chords. Writing it in the conventional case is just how progressions are read.

import { SCALES, PITCH_MIN, PITCH_MAX } from '../pianoroll.js';
import { chordPitches, QUALITIES } from '../chords.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const DEFAULT_SCALE = 'Minor';

// The intervals of a named scale, falling back to minor rather than throwing:
// a bad scale name in a saved context must not stop the panel opening.
export const scaleIntervals = name => SCALES[name] ?? SCALES[DEFAULT_SCALE];

export const isScaleName = name => Object.prototype.hasOwnProperty.call(SCALES, name);

// --- Roman numerals ------------------------------------------------------------

const ROMAN_LOWER = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];
const ROMAN_UPPER = ROMAN_LOWER.map(r => r.toUpperCase());

// Longest-first, so `iv` isn't read as `i` and `vii` isn't read as `vi`.
const NUMERAL_RE = /^(vii|vi|iv|v|iii|ii|i)/i;

// Suffixes that force a quality, overriding the scale's own. Matched whole (the
// suffix is whatever is left after the numeral and a trailing 7), so there is no
// prefix ambiguity between `m` and `maj`.
const QUALITY_SUFFIXES = new Map([
  ['', 'auto'],
  // No `-` for minor, common though that shorthand is: `-` is one of the
  // separators between chords, so `i-VI` has to mean two chords.
  ['m', 'Minor'], ['min', 'Minor'],
  ['maj', 'Major'], ['ma', 'Major'], ['+', 'Aug'], ['aug', 'Aug'],
  ['dim', 'Dim'], ['o', 'Dim'], ['°', 'Dim'],
  ['sus2', 'Sus2'], ['sus4', 'Sus4'],
]);

export const MAX_PROGRESSION_CHORDS = 16;
export const MAX_CHORD_BARS = 8;

// One token → one progression slot.
//
//   i        the tonic, quality from the scale
//   VI       the sixth degree, quality from the scale (the case is cosmetic)
//   i7       …with the scale's own 7th on top
//   ivm      quality forced minor
//   Vmaj7    forced major, with a major 7th
//   i:2      two bars long
//
// Throws with a sentence a user can act on: the panel puts it on the status line
// and keeps the previous progression.
export function parseChordToken(token) {
  const raw = String(token).trim();
  if (!raw) throw new Error('empty chord in the progression');

  let rest = raw;
  let bars = 1;
  const colon = rest.indexOf(':');
  if (colon >= 0) {
    const n = Number(rest.slice(colon + 1));
    if (!Number.isInteger(n) || n < 1 || n > MAX_CHORD_BARS) {
      throw new Error(`“${raw}”: the bars after “:” must be a whole number 1–${MAX_CHORD_BARS}`);
    }
    bars = n;
    rest = rest.slice(0, colon);
  }

  const m = NUMERAL_RE.exec(rest);
  if (!m) throw new Error(`“${raw}”: chords are roman numerals i–vii (try “i VI III VII”)`);
  const numeral = m[1];
  const degree = ROMAN_LOWER.indexOf(numeral.toLowerCase()) + 1;
  rest = rest.slice(numeral.length);

  let seventh = false;
  if (rest.endsWith('7')) {
    seventh = true;
    rest = rest.slice(0, -1);
  }

  const quality = QUALITY_SUFFIXES.get(rest) ?? QUALITY_SUFFIXES.get(rest.toLowerCase());
  if (!quality) {
    throw new Error(`“${raw}”: “${rest}” isn't a chord quality — use m, maj, dim, aug, sus2 or sus4, `
      + 'or leave it off and the scale decides');
  }
  return { degree, quality, seventh, bars, upper: numeral === numeral.toUpperCase() };
}

// Free text → progression. Separators are generous on purpose: spaces, commas,
// bars and the middle dot the library prints with all work.
export function parseProgression(text) {
  const tokens = String(text ?? '').split(/[\s,·|-]+/).filter(Boolean);
  if (!tokens.length) throw new Error('type a progression like “i VI III VII”');
  if (tokens.length > MAX_PROGRESSION_CHORDS) {
    throw new Error(`${tokens.length} chords is more than a loop can hold — keep it to ${MAX_PROGRESSION_CHORDS}`);
  }
  return tokens.map(parseChordToken);
}

const QUALITY_TO_SUFFIX = new Map([
  ['auto', ''], ['Minor', 'm'], ['Major', 'maj'], ['Dim', 'dim'],
  ['Aug', 'aug'], ['Sus2', 'sus2'], ['Sus4', 'sus4'],
]);

// Progression → the text that parses back to it, so the library and the editable
// field speak the same language.
export function formatProgression(prog) {
  return prog.map(s => {
    const numeral = (s.upper ? ROMAN_UPPER : ROMAN_LOWER)[s.degree - 1];
    return numeral
      + (QUALITY_TO_SUFFIX.get(s.quality) ?? '')
      + (s.seventh ? '7' : '')
      + (s.bars > 1 ? `:${s.bars}` : '');
  }).join(' ');
}

export const progressionBars = prog => prog.reduce((n, s) => n + s.bars, 0);

// Which chord each bar of the pattern is on. The progression loops to fill the
// pattern, and a progression longer than the pattern is simply truncated — a
// 4-bar loop in a 2-bar pattern gives you its first two chords, which is what
// shortening the pattern visibly does.
export function barSlots(prog, bars) {
  const total = progressionBars(prog);
  const out = [];
  for (let b = 0; b < bars; b++) {
    let x = b % total;
    let i = 0;
    while (i < prog.length - 1 && x >= prog[i].bars) {
      x -= prog[i].bars;
      i++;
    }
    out.push(prog[i]);
  }
  return out;
}

// --- Pitches -------------------------------------------------------------------

// The pitch of a scale degree. Degrees past the end of the scale keep walking
// upward into the next octave, which is what makes `vii` mean something in a
// five-note pentatonic instead of throwing.
//
// `octave` follows the boxes' own labelling, not middle-C = C4: MIDI 60 is C5 on
// an Elektron and in the roll's key column, so octave 5 root 0 is 60.
export function degreePitch(degree, { root = 0, intervals, octave = 4 }) {
  const L = intervals.length;
  const idx = degree - 1;
  const wrapped = ((idx % L) + L) % L;
  return 12 * octave + root + intervals[wrapped] + 12 * Math.floor(idx / L);
}

// Move a pitch by whole octaves until it sits inside a register window. Octave
// equivalence is the one transposition that never changes what a note *means*,
// which is why the parts fold rather than clamp — a bass root stays a root.
// A window narrower than an octave has no octave to choose, so it clamps.
export function foldIntoWindow(pitch, min, max) {
  if (max - min < 12) return clamp(pitch, min, max);
  let p = pitch;
  if (p < min) p += 12 * Math.ceil((min - p) / 12);
  if (p > max) p -= 12 * Math.ceil((p - max) / 12);
  return p;
}

// The register window for a role: `span` semitones up from its octave, clamped to
// the rows the roll can actually draw, so a part can never generate a note the
// editor can't show. An octave high enough to leave no room is pulled back down
// rather than producing an inverted window — every window is at least an octave
// tall, which is what `foldIntoWindow` needs to be able to choose an octave at all.
export function windowFor(profile, octave) {
  const span = Math.max(12, profile?.span ?? 24);
  const lo = Math.min(Math.max(PITCH_MIN, 12 * octave), PITCH_MAX - 12);
  return [lo, Math.min(PITCH_MAX, lo + span)];
}

// Every pitch of the scale inside a window, ascending — the palette a bassline
// or a lead picks from.
export function scalePitchesInWindow({ root = 0, intervals }, min, max) {
  const out = [];
  const classes = new Set(intervals.map(i => ((i + root) % 12 + 12) % 12));
  for (let p = min; p <= max; p++) if (classes.has(((p % 12) + 12) % 12)) out.push(p);
  return out;
}

// Nearest pitch in the scale, ties going down — the same tie-break chord draw's
// own snap uses, so an out-of-scale approach tone lands where a click would.
export function snapToScalePitch(pitch, { root = 0, intervals }) {
  const classes = new Set(intervals.map(i => ((i + root) % 12 + 12) % 12));
  for (let d = 0; d <= 6; d++) {
    if (classes.has((((pitch - d) % 12) + 12) % 12)) return pitch - d;
    if (classes.has((((pitch + d) % 12) + 12) % 12)) return pitch + d;
  }
  return pitch;
}

// The chord tones of one progression slot, in a register window.
//
// `quality: 'auto'` walks the scale in thirds (the diatonic case, and the
// default); anything else forces that quality from QUALITIES. Either way this is
// js/chords.js doing the work, capped at the hardware's four notes per trig.
export function chordTones(slot, { root = 0, intervals }, {
  octave = 4, min = 0, max = 127, inversion = 0, spread = false,
} = {}) {
  const rootPitch = foldIntoWindow(degreePitch(slot.degree, { root, intervals, octave }), min, max);
  const diatonic = slot.quality === 'auto';
  return chordPitches(rootPitch, {
    scale: diatonic ? { root, intervals } : null,
    quality: diatonic ? 'Major' : (QUALITIES[slot.quality] ? slot.quality : 'Major'),
    seventh: slot.seventh,
    inversion,
    spread,
    min,
    max,
  });
}

// The root of a slot's chord, folded into a window — what a bassline actually
// wants, without building the chord.
export function slotRootPitch(slot, { root = 0, intervals }, { octave = 2, min = 0, max = 127 } = {}) {
  return foldIntoWindow(degreePitch(slot.degree, { root, intervals, octave }), min, max);
}

// Every voicing of a slot's chord that fits the window: the four inversions, with
// and without the drop-2 spread, each also tried an octave up and down.
//
// Two subtleties, both learned the hard way:
//
//   * **octave transpositions matter more than inversions.** Inversions alone all
//     sit wherever the folded root put them, which on a low window means the next
//     chord can only travel upward — the exact opposite of voice leading.
//   * **only the fullest voicings compete.** `chordPitches` drops notes that fall
//     outside the window, so a chord clipped to two notes would win any
//     "moves least" contest by simply having fewer notes to move. Truncated
//     candidates are dropped rather than allowed to flatten the harmony.
export function voicingCandidates(slot, key, {
  octave = 4, min = 0, max = 127, spreads = [false, true],
} = {}) {
  const seen = new Set();
  const all = [];
  for (const spread of spreads) {
    for (const inversion of [0, 1, 2, 3]) {
      const base = chordTones(slot, key, { octave, min, max, inversion, spread });
      if (!base.length) continue;
      for (const shift of [-12, 0, 12]) {
        const moved = base.map(p => p + shift);
        if (!moved.every(p => p >= min && p <= max)) continue;
        const key2 = moved.join(',');
        if (seen.has(key2)) continue;
        seen.add(key2);
        all.push(moved);
      }
    }
  }
  if (!all.length) return [];
  const fullest = Math.max(...all.map(c => c.length));
  return all.filter(c => c.length === fullest);
}

// --- Voice leading -------------------------------------------------------------

// How far a voicing is from the one before it: for each note, the distance to
// the nearest note of the previous chord, summed. Not a true voice-to-voice
// pairing — chords here change size (a 7th arrives, a note falls outside the
// window) and a nearest-note sum degrades gracefully where a pairing would have
// to invent a rule for the odd voice out.
export function voicingDistance(prev, next) {
  if (!prev?.length || !next?.length) return 0;
  return next.reduce((sum, p) => sum + Math.min(...prev.map(q => Math.abs(p - q))), 0);
}

// The candidate voicing that moves least from the previous chord — the whole of
// what makes a chord part walk instead of jump. Ties go to the lower voicing, so
// a part doesn't drift upward across a long progression.
//
// With no previous chord there is nothing to lead from, so the *first* chord is
// placed near `centre` instead: a part that starts in the middle of its register
// has somewhere to go in both directions, which is what every chord after it
// depends on.
export function bestVoicing(prev, candidates, { centre = null } = {}) {
  const usable = candidates.filter(c => c?.length);
  if (!usable.length) return [];
  const mean = c => c.reduce((a, b) => a + b, 0) / c.length;
  if (!prev?.length) {
    if (centre == null) return usable[0];
    return usable.reduce((a, b) =>
      (Math.abs(mean(b) - centre) < Math.abs(mean(a) - centre) ? b : a));
  }
  let best = null;
  for (const c of usable) {
    const cost = voicingDistance(prev, c);
    const height = mean(c);
    if (!best || cost < best.cost || (cost === best.cost && height < best.height)) {
      best = { c, cost, height };
    }
  }
  return best.c;
}
