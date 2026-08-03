// Pattern model + localStorage persistence.

const STORAGE_KEY = 'digiroll-v1';
export const NUM_SLOTS = 8;

let nextNoteId = 1;

// A note. `trig` carries the three per-trig condition fields, which belong to
// the *step* rather than the note: every note on a step is kept in agreement
// (see js/elektron/conditions.js). Defaults mean "nothing locked".
//
//   prob  0-100, or null for no lock (the track default, effectively 100%)
//   fill  true = ON, false = OFF, null = no lock — a tri-state, as on the box
//   cond  a canonical condition label ('PRE', '!1ST', '2:4'), or null for none
export function makeNote(step, pitch, len = 1, velocity = 100, micro = 0, trig = null) {
  return {
    id: nextNoteId++, step, pitch, len, velocity, micro,
    prob: trig?.prob ?? null,
    fill: trig?.fill ?? null,
    cond: trig?.cond ?? null,
  };
}

export function defaultPattern(index) {
  return {
    name: `Pattern ${index + 1}`,
    lengthSteps: 16,   // 16th notes
    channel: index,    // 0-based MIDI channel; defaults line up with Elektron track channels 1-8
    swing: 50,         // 50 = straight, up to 80 like the Elektron range
    // Track-level PROB: the odds every trig on the track runs at unless it
    // carries its own PROB lock. 100 = the box default, i.e. always. This is a
    // real byte on the hardware (SPEC.track.trackProb), not a bulk stamp over
    // the per-trig lane.
    trackProb: 100,
    notes: [],
    // Provenance: the box/pattern/track this slot was imported from — or was
    // last sent to. null on patterns that have never met a box; see
    // makeSource() in js/roll-bridge.js for the shape.
    source: null,
    // Where "Send to box" is currently aimed: { patternIndex, trackIndex }.
    // Kept per slot so switching slots doesn't move another slot's target.
    // null until the Box panel first resolves one (from source, or the last
    // destination used on this browser).
    dest: null,
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
    // Last destination "Send to box" wrote to, so a freshly drawn pattern
    // starts aimed near where you were last working.
    sendTarget: { patternIndex: 0, trackIndex: 0 },
    defaultVelocity: 100,
    scaleRoot: 0,      // 0 = C
    scale: 'off',      // key into SCALES, or 'off'
    panel: 'editPanel', // side panel showing in the rail, or null for none
    chord: {           // chord-draw settings (js/chords.js)
      on: false,
      quality: 'auto', // 'auto' = diatonic when a scale is on; else a QUALITIES key
      seventh: false,
      inversion: 0,
      spread: false,
      strum: 0,        // 0-100, mapped to a per-note micro stagger
    },
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const defaults = defaultState();
    const state = { ...defaults, ...JSON.parse(raw) };
    state.chord = { ...defaults.chord, ...state.chord };
    state.sendTarget = { ...defaults.sendTarget, ...state.sendTarget };
    // Re-seed note ids above anything stored so new notes never collide, and
    // backfill fields added after a pattern was saved.
    for (const p of state.patterns) {
      if (typeof p.swing !== 'number') p.swing = 50;
      if (typeof p.trackProb !== 'number') p.trackProb = 100;
      if (p.source === undefined) p.source = null;
      if (p.dest === undefined) p.dest = null;
      for (const n of p.notes) {
        if (typeof n.micro !== 'number') n.micro = 0;
        // Trig conditions arrived after these three; older saves have no locks.
        if (n.prob === undefined) n.prob = null;
        if (n.fill === undefined) n.fill = null;
        if (n.cond === undefined) n.cond = null;
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
