// Pattern model + localStorage persistence.

const STORAGE_KEY = 'digiroll-v1';
export const NUM_SLOTS = 8;

let nextNoteId = 1;

export function makeNote(step, pitch, len = 1, velocity = 100, micro = 0) {
  return { id: nextNoteId++, step, pitch, len, velocity, micro };
}

export function defaultPattern(index) {
  return {
    name: `Pattern ${index + 1}`,
    lengthSteps: 16,   // 16th notes
    channel: index,    // 0-based MIDI channel; defaults line up with Elektron track channels 1-8
    swing: 50,         // 50 = straight, up to 80 like the Elektron range
    notes: [],
    // Provenance: the box/pattern/track this slot was imported from, so the
    // roll can write it straight back. null on locally drawn patterns —
    // see makeSource() in js/roll-bridge.js for the shape.
    source: null,
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
    scaleRoot: 0,      // 0 = C
    scale: 'off',      // key into SCALES, or 'off'
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const state = { ...defaultState(), ...JSON.parse(raw) };
    // Re-seed note ids above anything stored so new notes never collide, and
    // backfill fields added after a pattern was saved.
    for (const p of state.patterns) {
      if (typeof p.swing !== 'number') p.swing = 50;
      if (p.source === undefined) p.source = null;
      for (const n of p.notes) {
        if (typeof n.micro !== 'number') n.micro = 0;
        nextNoteId = Math.max(nextNoteId, n.id + 1);
      }
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
