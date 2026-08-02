import { describe, it, expect } from 'vitest';
import { noteName, PITCH_MIN, PITCH_MAX } from '../js/pianoroll.js';

// The roll's key labels have to read the same as the DT2/DN2 display, otherwise
// you draw a C5 and the box tells you it is a C6. Elektron numbers octaves one
// higher than the middle-C = C4 convention (verified on hardware — see the NOTE
// "E5" = MIDI 64 observation in docs/dn2-pattern-format.md).
describe('noteName', () => {
  it('labels MIDI 60 as C5, matching the box', () => {
    expect(noteName(60)).toBe('C5');
    expect(noteName(64)).toBe('E5');
  });

  it('names the accidentals sharp', () => {
    expect(noteName(61)).toBe('C#5');
    expect(noteName(70)).toBe('A#5');
  });

  it('spans C2..C8 across the drawable range', () => {
    expect(noteName(PITCH_MIN)).toBe('C2');
    expect(noteName(PITCH_MAX)).toBe('C8');
  });
});
