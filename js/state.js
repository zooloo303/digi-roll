// Pattern model + localStorage persistence.

const STORAGE_KEY = 'digiroll-v1';
export const NUM_SLOTS = 8;

let nextNoteId = 1;

export function makeNote(step, pitch, len = 1, velocity = 100) {
  return { id: nextNoteId++, step, pitch, len, velocity };
}

export function defaultPattern(index) {
  return {
    name: `Pattern ${index + 1}`,
    lengthSteps: 16,   // 16th notes
    channel: index,    // 0-based MIDI channel; defaults line up with Elektron track channels 1-8
    notes: [],
  };
}

export function defaultState() {
  return {
    patterns: Array.from({ length: NUM_SLOTS }, (_, i) => defaultPattern(i)),
    current: 0,
    bpm: 138,
    sendClock: true,
    countIn: 0, // bars of clock before the notes start
    outputId: null,
    defaultVelocity: 100,
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const state = { ...defaultState(), ...JSON.parse(raw) };
    // Re-seed note ids above anything stored so new notes never collide.
    for (const p of state.patterns) {
      for (const n of p.notes) nextNoteId = Math.max(nextNoteId, n.id + 1);
    }
    return state;
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full/unavailable: editing still works, persistence silently off.
  }
}
