import { describe, it, expect } from 'vitest';
import { chordPitches, voiceChord, QUALITIES, MAX_CHORD_NOTES } from '../js/chords.js';
import { SCALES } from '../js/pianoroll.js';

// C major as the roll passes it: root pitch class + ascending intervals.
const C_MAJOR = { root: 0, intervals: SCALES['Major'] };
const C = 60; // middle C

describe('fixed qualities', () => {
  it('builds the basic triads', () => {
    expect(chordPitches(C, { quality: 'Major' })).toEqual([60, 64, 67]);
    expect(chordPitches(C, { quality: 'Minor' })).toEqual([60, 63, 67]);
    expect(chordPitches(C, { quality: 'Sus2' })).toEqual([60, 62, 67]);
    expect(chordPitches(C, { quality: 'Sus4' })).toEqual([60, 65, 67]);
    expect(chordPitches(C, { quality: 'Dim' })).toEqual([60, 63, 66]);
    expect(chordPitches(C, { quality: 'Aug' })).toEqual([60, 64, 68]);
  });

  it('adds each quality its own 7th', () => {
    expect(chordPitches(C, { quality: 'Major', seventh: true })).toEqual([60, 64, 67, 71]); // maj7
    expect(chordPitches(C, { quality: 'Minor', seventh: true })).toEqual([60, 63, 67, 70]); // m7
    expect(chordPitches(C, { quality: 'Dim', seventh: true })).toEqual([60, 63, 66, 69]);   // dim7
  });

  it('falls back to Major for an unknown quality', () => {
    expect(chordPitches(C, { quality: 'nope' })).toEqual([60, 64, 67]);
  });
});

describe('diatonic mode', () => {
  it('gives each degree of C major its natural quality', () => {
    expect(chordPitches(60, { scale: C_MAJOR })).toEqual([60, 64, 67]); // I  major
    expect(chordPitches(62, { scale: C_MAJOR })).toEqual([62, 65, 69]); // ii minor
    expect(chordPitches(64, { scale: C_MAJOR })).toEqual([64, 67, 71]); // iii minor
    expect(chordPitches(71, { scale: C_MAJOR })).toEqual([71, 74, 77]); // vii° diminished
  });

  it('makes the V7 dominant, not major 7', () => {
    expect(chordPitches(67, { scale: C_MAJOR, seventh: true })).toEqual([67, 71, 74, 77]); // G7
  });

  it('snaps an out-of-scale root to the nearest scale tone, preferring below', () => {
    expect(chordPitches(61, { scale: C_MAJOR })).toEqual([60, 64, 67]); // C# → C (tie goes down)
    expect(chordPitches(66, { scale: C_MAJOR })).toEqual([65, 69, 72]); // F# → F
  });

  it('wraps thirds past the octave in short scales', () => {
    const pent = { root: 0, intervals: SCALES['Pentatonic Minor'] }; // [0,3,5,7,10]
    expect(chordPitches(60, { scale: pent })).toEqual([60, 65, 70]);       // 0,5,10
    expect(chordPitches(70, { scale: pent })).toEqual([70, 75, 79]);       // from the top degree, up and over
  });

  it('snaps across the octave wrap', () => {
    const pent = { root: 0, intervals: SCALES['Pentatonic Minor'] };
    expect(chordPitches(71, { scale: pent })[0]).toBe(70); // B → Bb, not down to G
  });
});

describe('voicing', () => {
  it('cycles inversions by moving the bottom note up an octave', () => {
    expect(chordPitches(C, { inversion: 1 })).toEqual([64, 67, 72]);
    expect(chordPitches(C, { inversion: 2 })).toEqual([67, 72, 76]);
    expect(chordPitches(C, { inversion: 3 })).toEqual([60, 64, 67]); // wraps on a triad
    expect(chordPitches(C, { seventh: true, inversion: 3 })).toEqual([71, 72, 76, 79]);
  });

  it('spread drops the second-from-top note an octave', () => {
    expect(chordPitches(C, { spread: true })).toEqual([52, 60, 67]);
    expect(chordPitches(C, { seventh: true, spread: true })).toEqual([55, 60, 64, 71]);
  });

  it('keeps everything inside the pitch range', () => {
    expect(chordPitches(95, { min: 24, max: 96 })).toEqual([95]);         // top of the roll: extensions dropped
    expect(chordPitches(25, { spread: true, min: 24, max: 96 })).toEqual([25, 32]); // drop-2 below the floor is dropped
  });

  it('never returns more than a trig can hold', () => {
    for (const quality of Object.keys(QUALITIES)) {
      expect(chordPitches(C, { quality, seventh: true }).length).toBeLessThanOrEqual(MAX_CHORD_NOTES);
    }
  });

  it('dedupes pitches', () => {
    const got = chordPitches(C, { quality: 'Aug', seventh: true, spread: true });
    expect(new Set(got).size).toBe(got.length);
  });
});

describe('voiceChord', () => {
  it('staggers micro bottom-up for strum, within the micro clamp', () => {
    const specs = voiceChord([60, 64, 67, 71], { strum: 0.12 });
    expect(specs.map(s => s.micro)).toEqual([0, 0.12, 0.24, 0.36]);
    const wild = voiceChord([60, 64, 67, 71], { strum: 0.3 });
    expect(Math.max(...wild.map(s => s.micro))).toBeLessThanOrEqual(0.49);
  });

  it('tapers lower notes and keeps the top at full velocity', () => {
    const specs = voiceChord([60, 64, 67], { velocity: 100 });
    expect(specs.at(-1).velocity).toBe(100);
    expect(specs[0].velocity).toBeLessThan(specs[1].velocity);
    expect(specs[1].velocity).toBeLessThan(100);
  });

  it('can skip the taper (harmonize keeps the melody on top)', () => {
    const specs = voiceChord([60, 64, 67], { velocity: 90, taper: false });
    expect(specs.every(s => s.velocity === 90)).toBe(true);
  });

  it('never tapers below velocity 1', () => {
    const specs = voiceChord([60, 64, 67, 71], { velocity: 1 });
    expect(specs.every(s => s.velocity >= 1)).toBe(true);
  });
});
