// The four genre profiles: plain data, no logic.
//
// A profile is the rhythmic and dynamic grammar of a genre, per role. Everything
// the generator decides that *isn't* harmony comes from here, which is what makes
// "DnB" and "house" produce different music from the same progression in the same
// key.
//
// Three things worth knowing before editing one:
//
//   * **`weights` is one bar of sixteenths**, index 0 = the downbeat, 4/8/12 the
//     other beats, 2/6/10/14 the eighth-note "and"s. It is a *relative*
//     likelihood that a step gets a trig, not a rule — 0 means never, and the
//     density slider decides how many of the likely ones actually fire.
//   * **`groove` is per-note micro-timing**, in fractions of a step, and it is
//     how genre feel is expressed. The generator may not touch `swing`: that byte
//     re-times all sixteen tracks in the destination pattern, so a generator
//     setting it would change parts it wasn't asked to touch. Micro-timing is
//     per note, stored on the box, and harmless to the other fifteen tracks —
//     hence house's shuffle living in this array.
//   * **`bpm` is a suggestion**, offered by the panel with a Set button. Nothing
//     here changes the transport behind your back.
//
// Register windows are `[12 * octave, 12 * octave + span]` with the octave coming
// from the song context, so moving a part's octave moves its window rather than
// transposing notes out of the range the roll can draw. `span` is the height; the
// window itself is worked out by `windowFor` in js/gen/theory.js.
//
// This file imports nothing, and the register-window maths that used to live here
// moved to js/gen/theory.js with the rest of the pitch work. Data only.

export const GENRE_IDS = ['dnb', 'breaks', 'electro', 'house'];

// A groove where every off-16th is pushed late by the same amount — the shuffle
// shape, as micro-timing rather than as the swing byte.
const swung = amount => Array.from({ length: 16 }, (_, i) => (i % 2 ? amount : 0));

// DnB's feel isn't a shuffle: it's straight eighths with the 16ths between them
// dragging, and the second half of each beat dragging a touch more.
const DNB_GROOVE = [0, 0.05, 0, 0.06, 0, 0.05, 0.04, 0.07, 0, 0.05, 0, 0.06, 0, 0.05, 0.04, 0.07];

// Conditions, used musically. `chance` is at Looseness 100 and scales down with
// the slider; at 0 no condition is written at all.
const ALT_BARS = { kind: 'altBar', chance: 0.4 };
const EVERY_FOURTH = { kind: 'everyFourth', chance: 0.18, keys: ['3:4', '4:4'] };
const GHOST_PROB = { kind: 'probGhost', chance: 0.85, range: [60, 85] };
const WEAK_PROB = { kind: 'probWeak', chance: 0.3, range: [70, 90] };
const FILL_EXTRA = { kind: 'fill', chance: 0.15, mode: 'on' };
const FILL_STEP_ASIDE = { kind: 'fill', chance: 0.1, mode: 'off' };
const ANSWERING = { kind: 'logic', chance: 0.1, keys: ['PRE', 'NEI'] };

export const GENRES = {
  dnb: {
    id: 'dnb',
    label: 'DnB',
    bpm: 174,
    bpmRange: [172, 176],
    bars: 2,
    groove: DNB_GROOVE,
    roles: {
      bass: {
        // A long root anchor on the 1, then syncopated stabs off the grid. The
        // quarters at 4/8/12 are deliberately weak: four-on-the-floor is the one
        // thing a DnB bassline must not do.
        weights: [1, 0.15, 0.35, 0.7, 0.25, 0.2, 0.6, 0.5, 0.5, 0.2, 0.65, 0.55, 0.3, 0.25, 0.7, 0.45],
        trigsPerBar: [2, 7],
        span: 24,
        anchor: { len: 4 },
        len: { normal: 0.75, ghost: 0.25, max: 6 },
        velocity: { accent: 120, normal: 100, ghost: 66 },
        approach: 0.35,
        octaveLeap: 0.12,
        conditions: [ALT_BARS, GHOST_PROB, FILL_EXTRA],
        lanes: [
          { name: 'filter.cutoff', shape: 'rise', from: 40, to: 105 },
          { name: 'fx.overdrive', shape: 'accent', from: 20, to: 90 },
          { name: 'lfo1.depth', shape: 'swell', from: 64, to: 96 },
        ],
      },
      chords: {
        // Sparse sustained stabs — often only the 1 and the "and" of 3.
        weights: [1, 0.05, 0.1, 0.15, 0.2, 0.05, 0.12, 0.1, 0.35, 0.05, 0.8, 0.15, 0.2, 0.05, 0.25, 0.1],
        trigsPerBar: [1, 3],
        span: 24,
        len: { mode: 'sustain', normal: 8, max: 16 },
        velocity: { accent: 104, normal: 92, ghost: 72 },
        strum: 0.04,
        spread: 0.4,
        conditions: [ALT_BARS, EVERY_FOURTH, WEAK_PROB],
        lanes: [
          { name: 'filter.cutoff', shape: 'arc', from: 50, to: 100 },
          { name: 'fx.reverbSend', shape: 'swell', from: 30, to: 95 },
        ],
      },
      lead: {
        // Half-time feeling: strong on 1 and the "and" of 2, wide space between.
        weights: [0.9, 0.1, 0.3, 0.2, 0.4, 0.15, 0.6, 0.3, 0.7, 0.15, 0.4, 0.35, 0.5, 0.2, 0.55, 0.4],
        trigsPerBar: [2, 6],
        span: 30,
        motif: { notes: [3, 5], window: 8 },
        len: { normal: 1, max: 4 },
        velocity: { accent: 112, normal: 96, ghost: 70 },
        conditions: [ALT_BARS, EVERY_FOURTH, WEAK_PROB, ANSWERING],
        lanes: [
          { name: 'amp.pan', shape: 'wander', from: 40, to: 88 },
          { name: 'fx.delaySend', shape: 'swell', from: 20, to: 90 },
        ],
      },
    },
  },

  breaks: {
    id: 'breaks',
    label: 'Breaks',
    bpm: 135,
    bpmRange: [130, 140],
    bars: 2,
    groove: swung(0.1),
    roles: {
      bass: {
        // Funk-leaning: busy, syncopated, and full of low-velocity ghosts.
        weights: [1, 0.2, 0.45, 0.3, 0.3, 0.5, 0.55, 0.3, 0.6, 0.25, 0.5, 0.45, 0.35, 0.5, 0.6, 0.4],
        trigsPerBar: [3, 9],
        span: 24,
        anchor: { len: 1.5 },
        len: { normal: 0.5, ghost: 0.25, max: 4 },
        velocity: { accent: 118, normal: 98, ghost: 58 },
        approach: 0.3,
        octaveLeap: 0.18,
        conditions: [GHOST_PROB, ALT_BARS, FILL_EXTRA, FILL_STEP_ASIDE],
        lanes: [
          { name: 'filter.cutoff', shape: 'wander', from: 45, to: 100 },
          { name: 'fx.overdrive', shape: 'accent', from: 15, to: 75 },
        ],
      },
      chords: {
        // Stabs off the beat, the way a chopped break's keys land.
        weights: [0.5, 0.1, 0.7, 0.3, 0.2, 0.1, 0.75, 0.25, 0.4, 0.1, 0.7, 0.3, 0.25, 0.15, 0.6, 0.3],
        trigsPerBar: [2, 5],
        span: 24,
        len: { mode: 'stab', normal: 0.75, max: 4 },
        velocity: { accent: 108, normal: 94, ghost: 74 },
        strum: 0.08,
        spread: 0.3,
        conditions: [WEAK_PROB, EVERY_FOURTH, ALT_BARS],
        lanes: [
          { name: 'filter.cutoff', shape: 'accent', from: 55, to: 110 },
          { name: 'fx.delaySend', shape: 'swell', from: 25, to: 85 },
        ],
      },
      lead: {
        // Answering in the gaps — which the busy-step penalty does, not this.
        weights: [0.5, 0.2, 0.35, 0.45, 0.5, 0.25, 0.4, 0.5, 0.55, 0.25, 0.4, 0.5, 0.45, 0.3, 0.5, 0.55],
        trigsPerBar: [3, 8],
        span: 30,
        motif: { notes: [3, 6], window: 8 },
        len: { normal: 0.75, max: 3 },
        velocity: { accent: 110, normal: 94, ghost: 66 },
        conditions: [WEAK_PROB, ALT_BARS, EVERY_FOURTH, ANSWERING],
        lanes: [
          { name: 'amp.pan', shape: 'wander', from: 36, to: 92 },
          { name: 'fx.reverbSend', shape: 'swell', from: 20, to: 80 },
        ],
      },
    },
  },

  electro: {
    id: 'electro',
    label: 'Electro',
    bpm: 130,
    bpmRange: [125, 135],
    bars: 2,
    groove: swung(0.03),
    roles: {
      bass: {
        // Sixteenth-driven and staccato, with octave leaps doing the melody.
        weights: [1, 0.6, 0.7, 0.6, 0.75, 0.6, 0.7, 0.6, 0.85, 0.6, 0.7, 0.6, 0.8, 0.6, 0.75, 0.65],
        trigsPerBar: [6, 14],
        span: 24,
        anchor: { len: 0.5 },
        len: { normal: 0.25, ghost: 0.25, max: 1 },
        velocity: { accent: 122, normal: 100, ghost: 72 },
        approach: 0.15,
        octaveLeap: 0.45,
        conditions: [ALT_BARS, WEAK_PROB, EVERY_FOURTH],
        lanes: [
          { name: 'filter.cutoff', shape: 'wander', from: 40, to: 110 },
          { name: 'filter.resonance', shape: 'rise', from: 20, to: 80 },
          { name: 'lfo1.depth', shape: 'pulse', from: 64, to: 100 },
        ],
      },
      chords: {
        // Held, or pulsing on the beat — the machine, not the band.
        weights: [1, 0.1, 0.2, 0.1, 0.7, 0.1, 0.2, 0.1, 0.8, 0.1, 0.2, 0.1, 0.7, 0.1, 0.25, 0.15],
        trigsPerBar: [1, 4],
        span: 24,
        len: { mode: 'sustain', normal: 4, max: 16 },
        velocity: { accent: 106, normal: 92, ghost: 76 },
        strum: 0,
        spread: 0.2,
        conditions: [ALT_BARS, EVERY_FOURTH],
        lanes: [
          { name: 'filter.cutoff', shape: 'arc', from: 45, to: 100 },
          { name: 'fx.chorusSend', shape: 'rise', from: 20, to: 80 },
        ],
      },
      lead: {
        // Arpeggio-ish: even, mechanical, chord tones climbing.
        weights: [0.8, 0.3, 0.6, 0.35, 0.7, 0.3, 0.6, 0.35, 0.75, 0.3, 0.6, 0.35, 0.7, 0.3, 0.6, 0.4],
        trigsPerBar: [4, 12],
        span: 30,
        motif: { notes: [4, 6], window: 4 },
        len: { normal: 0.5, max: 2 },
        velocity: { accent: 112, normal: 96, ghost: 74 },
        conditions: [ALT_BARS, EVERY_FOURTH, WEAK_PROB],
        lanes: [
          { name: 'amp.pan', shape: 'pulse', from: 44, to: 84 },
          { name: 'filter.envDepth', shape: 'accent', from: 64, to: 100 },
        ],
      },
    },
  },

  house: {
    id: 'house',
    label: 'House',
    bpm: 124,
    bpmRange: [120, 128],
    bars: 1,
    // House shuffle would normally be swing, which the generator may not touch,
    // so it comes out here — every off-16th pushed late, which is the same
    // musical result on one track.
    groove: swung(0.14),
    roles: {
      bass: {
        // The off-beat bass: a note on every "and", almost nothing on the beat.
        weights: [0.35, 0.05, 1, 0.1, 0.3, 0.05, 1, 0.1, 0.3, 0.05, 1, 0.1, 0.3, 0.05, 1, 0.15],
        trigsPerBar: [4, 8],
        span: 24,
        anchor: { len: 0.5 },
        len: { normal: 0.5, ghost: 0.25, max: 2 },
        velocity: { accent: 112, normal: 100, ghost: 78 },
        approach: 0.2,
        octaveLeap: 0.2,
        conditions: [WEAK_PROB, ALT_BARS],
        lanes: [
          { name: 'filter.cutoff', shape: 'rise', from: 45, to: 95 },
          { name: 'fx.chorusSend', shape: 'swell', from: 20, to: 70 },
        ],
      },
      chords: {
        // Seventh stabs on the off-beat, the sound of the whole genre.
        weights: [0.5, 0.05, 0.9, 0.15, 0.25, 0.05, 0.85, 0.15, 0.35, 0.05, 0.9, 0.15, 0.25, 0.05, 0.8, 0.2],
        trigsPerBar: [2, 6],
        span: 24,
        len: { mode: 'stab', normal: 1, max: 4 },
        velocity: { accent: 106, normal: 94, ghost: 78 },
        strum: 0.06,
        spread: 0.5,
        conditions: [WEAK_PROB, ALT_BARS, EVERY_FOURTH],
        lanes: [
          { name: 'filter.cutoff', shape: 'accent', from: 55, to: 105 },
          { name: 'fx.reverbSend', shape: 'swell', from: 25, to: 85 },
        ],
      },
      lead: {
        // Simple and hooky — a few notes you can hum.
        weights: [0.7, 0.15, 0.4, 0.2, 0.5, 0.15, 0.45, 0.25, 0.6, 0.15, 0.4, 0.25, 0.5, 0.2, 0.45, 0.3],
        trigsPerBar: [2, 6],
        span: 30,
        motif: { notes: [3, 5], window: 8 },
        len: { normal: 1, max: 4 },
        velocity: { accent: 108, normal: 94, ghost: 72 },
        conditions: [WEAK_PROB, EVERY_FOURTH, ANSWERING],
        lanes: [
          { name: 'fx.delaySend', shape: 'swell', from: 25, to: 90 },
          { name: 'amp.pan', shape: 'wander', from: 44, to: 84 },
        ],
      },
    },
  },
};

export const genreProfile = id => GENRES[id] ?? GENRES.dnb;

export const genreLabel = id => genreProfile(id).label;

export const roleProfile = (id, role) => genreProfile(id).roles[role] ?? null;

// The height of a role's register window; `windowFor` in js/gen/theory.js turns
// it and the part's octave into the window itself.
export const roleSpan = (id, role) => roleProfile(id, role)?.span ?? 24;
