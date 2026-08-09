import { describe, it, expect } from 'vitest';
import {
  parseChordToken, parseProgression, formatProgression, progressionBars, barSlots,
  degreePitch, foldIntoWindow, windowFor, scalePitchesInWindow, snapToScalePitch,
  chordTones, slotRootPitch, voicingDistance, bestVoicing, voicingCandidates, scaleIntervals,
} from '../js/gen/theory.js';
import { PROGRESSIONS } from '../js/gen/progressions.js';
import { SCALES, PITCH_MIN, PITCH_MAX } from '../js/pianoroll.js';

const C_MINOR = { root: 0, intervals: SCALES['Minor'] };   // C D Eb F G Ab Bb
const C_MAJOR = { root: 0, intervals: SCALES['Major'] };

describe('roman numerals', () => {
  it('reads a plain degree, case being cosmetic', () => {
    expect(parseChordToken('i')).toMatchObject({ degree: 1, quality: 'auto', seventh: false, bars: 1 });
    expect(parseChordToken('VII')).toMatchObject({ degree: 7, quality: 'auto', upper: true });
    expect(parseChordToken('iv')).toMatchObject({ degree: 4 });
    expect(parseChordToken('III')).toMatchObject({ degree: 3 });
  });

  it('does not read “iv” as “i” or “vii” as “vi”', () => {
    expect(parseChordToken('iv').degree).toBe(4);
    expect(parseChordToken('vii').degree).toBe(7);
    expect(parseChordToken('vi').degree).toBe(6);
    expect(parseChordToken('v').degree).toBe(5);
  });

  it('reads sevenths and forced qualities', () => {
    expect(parseChordToken('i7')).toMatchObject({ degree: 1, quality: 'auto', seventh: true });
    expect(parseChordToken('ivm')).toMatchObject({ degree: 4, quality: 'Minor', seventh: false });
    expect(parseChordToken('Vmaj7')).toMatchObject({ degree: 5, quality: 'Major', seventh: true });
    expect(parseChordToken('viidim')).toMatchObject({ degree: 7, quality: 'Dim' });
    expect(parseChordToken('isus4')).toMatchObject({ degree: 1, quality: 'Sus4' });
  });

  it('reads a bar count after a colon', () => {
    expect(parseChordToken('i:2')).toMatchObject({ degree: 1, bars: 2 });
    expect(parseChordToken('i7:4')).toMatchObject({ degree: 1, seventh: true, bars: 4 });
  });

  it('explains itself when a token is malformed', () => {
    expect(() => parseChordToken('viii')).toThrow(/quality/);
    expect(() => parseChordToken('C')).toThrow(/roman numerals/);
    expect(() => parseChordToken('i:0')).toThrow(/1–8/);
    expect(() => parseChordToken('i:nine')).toThrow(/1–8/);
    expect(() => parseChordToken('iwhat')).toThrow(/isn't a chord quality/);
  });
});

describe('progressions', () => {
  it('splits on spaces, commas, dots and dashes', () => {
    expect(parseProgression('i VI III VII').map(s => s.degree)).toEqual([1, 6, 3, 7]);
    expect(parseProgression('i, VI · III | VII').map(s => s.degree)).toEqual([1, 6, 3, 7]);
    expect(parseProgression('i-VI-III-VII').map(s => s.degree)).toEqual([1, 6, 3, 7]);
  });

  it('refuses nothing at all, and an unreasonably long loop', () => {
    expect(() => parseProgression('   ')).toThrow(/type a progression/);
    expect(() => parseProgression(new Array(20).fill('i').join(' '))).toThrow(/more than a loop/);
  });

  it('round-trips through formatProgression', () => {
    for (const text of ['i VI III VII', 'i7:2 iv7:2', 'ivm V isus4', 'ii7 v7']) {
      expect(formatProgression(parseProgression(text))).toBe(text);
    }
  });

  it('parses every entry in the library', () => {
    for (const p of PROGRESSIONS) {
      expect(() => parseProgression(p.text), p.text).not.toThrow();
      expect(formatProgression(parseProgression(p.text))).toBe(p.text);
    }
  });

  it('counts bars, honouring per-chord spans', () => {
    expect(progressionBars(parseProgression('i VI III VII'))).toBe(4);
    expect(progressionBars(parseProgression('i:2 VI:2'))).toBe(4);
    expect(progressionBars(parseProgression('i:4'))).toBe(4);
  });
});

describe('which chord each bar is on', () => {
  it('loops a short progression to fill the pattern', () => {
    const prog = parseProgression('i VI');
    expect(barSlots(prog, 4).map(s => s.degree)).toEqual([1, 6, 1, 6]);
  });

  it('truncates a progression longer than the pattern', () => {
    const prog = parseProgression('i VI III VII');
    expect(barSlots(prog, 2).map(s => s.degree)).toEqual([1, 6]);
  });

  it('spreads a multi-bar chord across its bars', () => {
    const prog = parseProgression('i:2 VII:2');
    expect(barSlots(prog, 4).map(s => s.degree)).toEqual([1, 1, 7, 7]);
    // …and keeps looping past its own length
    expect(barSlots(prog, 8).map(s => s.degree)).toEqual([1, 1, 7, 7, 1, 1, 7, 7]);
  });

  it('handles the one-chord drone', () => {
    expect(barSlots(parseProgression('i:4'), 2).map(s => s.degree)).toEqual([1, 1]);
  });
});

describe('pitches', () => {
  it('numbers octaves the way the boxes do (MIDI 60 = C5)', () => {
    expect(degreePitch(1, { ...C_MINOR, octave: 5 })).toBe(60);
    expect(degreePitch(1, { ...C_MINOR, octave: 2 })).toBe(24);
  });

  it('walks degrees up the scale, wrapping into the next octave', () => {
    // C minor: i C, III Eb, V G, VII Bb
    expect(degreePitch(3, { ...C_MINOR, octave: 5 })).toBe(63);
    expect(degreePitch(5, { ...C_MINOR, octave: 5 })).toBe(67);
    expect(degreePitch(7, { ...C_MINOR, octave: 5 })).toBe(70);
    // A degree past the end of a five-note scale keeps climbing
    const pent = { root: 0, intervals: SCALES['Pentatonic Minor'], octave: 5 };
    expect(degreePitch(6, pent)).toBe(72);
  });

  it('folds a pitch into a register window by whole octaves', () => {
    expect(foldIntoWindow(24, 48, 72)).toBe(48);
    expect(foldIntoWindow(96, 48, 72)).toBe(72);
    expect(foldIntoWindow(60, 48, 72)).toBe(60);
  });

  it('clamps rather than looping forever in a window too narrow for an octave', () => {
    expect(foldIntoWindow(50, 60, 64)).toBe(60);
    expect(foldIntoWindow(90, 60, 64)).toBe(64);
  });

  it('keeps every register window inside the rows the roll can draw', () => {
    for (const span of [24, 30]) {
      for (let octave = 0; octave <= 9; octave++) {
        const [lo, hi] = windowFor({ span }, octave);
        expect(lo).toBeGreaterThanOrEqual(PITCH_MIN);
        expect(hi).toBeLessThanOrEqual(PITCH_MAX);
        expect(hi - lo).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('lists the scale tones in a window', () => {
    const tones = scalePitchesInWindow(C_MINOR, 60, 72);
    expect(tones).toEqual([60, 62, 63, 65, 67, 68, 70, 72]);
  });

  it('snaps an out-of-scale pitch to the nearest scale tone, ties going down', () => {
    expect(snapToScalePitch(61, C_MINOR)).toBe(60);   // C# → C
    expect(snapToScalePitch(66, C_MINOR)).toBe(65);   // F# → F
    expect(snapToScalePitch(63, C_MINOR)).toBe(63);   // already in
  });
});

describe('chord tones for a progression slot', () => {
  const slot = (degree, extra = {}) => ({ degree, quality: 'auto', seventh: false, bars: 1, ...extra });

  it('gives a degree its natural quality from the scale', () => {
    // C minor: i = C Eb G, VI = Ab C Eb, V = G Bb D
    expect(chordTones(slot(1), C_MINOR, { octave: 5, min: 48, max: 84 })).toEqual([60, 63, 67]);
    expect(chordTones(slot(6), C_MINOR, { octave: 5, min: 48, max: 84 })).toEqual([68, 72, 75]);
    expect(chordTones(slot(5), C_MINOR, { octave: 5, min: 48, max: 84 })).toEqual([67, 70, 74]);
  });

  it('adds the scale\'s own seventh, so V7 in major is dominant', () => {
    expect(chordTones(slot(5, { seventh: true }), C_MAJOR, { octave: 5, min: 48, max: 84 }))
      .toEqual([67, 71, 74, 77]);
  });

  it('honours a forced quality', () => {
    expect(chordTones(slot(1, { quality: 'Major' }), C_MINOR, { octave: 5, min: 48, max: 84 }))
      .toEqual([60, 64, 67]);
  });

  it('never exceeds the hardware\'s four notes per trig', () => {
    for (const degree of [1, 2, 3, 4, 5, 6, 7]) {
      const tones = chordTones(slot(degree, { seventh: true }), C_MINOR,
        { octave: 5, min: 48, max: 84, inversion: 3, spread: true });
      expect(tones.length).toBeLessThanOrEqual(4);
    }
  });

  it('keeps chords inside the register window', () => {
    for (const degree of [1, 4, 6, 7]) {
      for (const tone of chordTones(slot(degree), C_MINOR, { octave: 4, min: 48, max: 72 })) {
        expect(tone).toBeGreaterThanOrEqual(48);
        expect(tone).toBeLessThanOrEqual(72);
      }
    }
  });

  it('puts a slot root in the bass window', () => {
    const root = slotRootPitch(slot(6), C_MINOR, { octave: 2, min: 24, max: 48 });
    expect(root).toBeGreaterThanOrEqual(24);
    expect(root).toBeLessThanOrEqual(48);
    expect(root % 12).toBe(8); // Ab
  });
});

describe('voice leading', () => {
  it('measures total movement from the previous chord', () => {
    expect(voicingDistance([60, 64, 67], [60, 64, 67])).toBe(0);
    expect(voicingDistance([60, 64, 67], [61, 65, 68])).toBe(3);
    expect(voicingDistance([], [60])).toBe(0);
  });

  it('picks the inversion that moves least', () => {
    const prev = [60, 63, 67];                      // C minor
    const candidates = [
      [56, 60, 63],                                  // close
      [80, 84, 87],                                  // far
    ];
    expect(bestVoicing(prev, candidates)).toEqual([56, 60, 63]);
  });

  it('takes the lower voicing when two move the same amount', () => {
    expect(bestVoicing([60], [[72], [48]])).toEqual([48]);
  });

  it('takes the first candidate when there is nothing to lead from', () => {
    expect(bestVoicing([], [[60, 64], [70, 74]])).toEqual([60, 64]);
    expect(bestVoicing([60], [])).toEqual([]);
  });

  it('walks a whole progression instead of jumping', () => {
    // The point of the feature: chord-to-chord movement stays small across a loop.
    const prog = parseProgression('i VI III VII');
    const opts = { octave: 4, min: 48, max: 72 };
    let prev = [];
    let worst = 0;
    let rootPositionWorst = 0;
    for (const s of prog) {
      const chosen = bestVoicing(prev, voicingCandidates(s, C_MINOR, opts), { centre: 60 });
      const naive = chordTones(s, C_MINOR, { ...opts, inversion: 0 });
      if (prev.length) worst = Math.max(worst, voicingDistance(prev, chosen));
      if (prev.length) rootPositionWorst = Math.max(rootPositionWorst, voicingDistance(prev, naive));
      prev = chosen;
    }
    // Three voices, so ≤ 6 is two semitones each at worst.
    expect(worst).toBeLessThanOrEqual(6);
    // …and it is doing real work: root position from the same starting chord
    // travels further.
    expect(worst).toBeLessThan(rootPositionWorst);
  });
});

describe('voicing candidates', () => {
  const slot = { degree: 1, quality: 'auto', seventh: false, bars: 1 };

  it('offers octave transpositions, not just inversions', () => {
    const cands = voicingCandidates(slot, C_MINOR, { octave: 4, min: 48, max: 84 });
    const means = cands.map(c => c.reduce((a, b) => a + b, 0) / c.length);
    expect(Math.max(...means) - Math.min(...means)).toBeGreaterThanOrEqual(12);
  });

  it('keeps every candidate inside the window', () => {
    for (const c of voicingCandidates(slot, C_MINOR, { octave: 4, min: 48, max: 72 })) {
      for (const p of c) {
        expect(p).toBeGreaterThanOrEqual(48);
        expect(p).toBeLessThanOrEqual(72);
      }
    }
  });

  it('drops voicings the window clipped, so a thinned chord can\'t win on movement', () => {
    // A narrow window makes some inversions come back short; those must not compete.
    const cands = voicingCandidates(slot, C_MINOR, { octave: 4, min: 48, max: 62 });
    expect(cands.length).toBeGreaterThan(0);
    expect(new Set(cands.map(c => c.length)).size).toBe(1);
  });

  it('returns nothing when not one note of the chord fits', () => {
    // A one-row window on a note that isn't in the chord at all.
    expect(voicingCandidates(slot, C_MINOR, { octave: 4, min: 61, max: 61 })).toEqual([]);
  });
});

describe('scales', () => {
  it('falls back to minor for a name it doesn\'t know', () => {
    expect(scaleIntervals('Nope')).toEqual(SCALES['Minor']);
    expect(scaleIntervals('Dorian')).toEqual(SCALES['Dorian']);
  });
});
