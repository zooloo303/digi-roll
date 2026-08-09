// The progression library, tagged by genre.
//
// Roman numerals in the key the Harmony panel is set to, so `i VI III VII` in C
// minor and in F# minor are the same progression — which is the point of writing
// them this way rather than as chord names.
//
// These are loops, not songs: two to four chords, because a pattern is one to
// eight bars and the box loops it. Anything longer belongs in the editable field.
//
// Every entry's `text` is parsed by js/gen/theory.js, and the test suite parses
// all of them — a typo here is a test failure rather than a status-line error in
// front of a user.

export const PROGRESSIONS = [
  // --- minor loops, the shared backbone -----------------------------------------
  {
    text: 'i VI III VII', genres: ['dnb', 'breaks', 'electro'],
    note: 'the minor four-chord workhorse — descending, never resolves',
  },
  {
    text: 'i VII VI VII', genres: ['dnb', 'electro'],
    note: 'rocking minor vamp, stays close to home',
  },
  {
    text: 'i iv VI v', genres: ['breaks', 'dnb'],
    note: 'minor with a real subdominant — more movement, more soul',
  },
  {
    text: 'i VI iv VII', genres: ['breaks', 'electro'],
    note: 'lifts on the iv, lands on the VII',
  },

  // --- DnB: pedal and move ------------------------------------------------------
  {
    text: 'i:2 VI:2', genres: ['dnb'],
    note: 'two bars on the tonic, two on the relative major — room to breathe',
  },
  {
    text: 'i:2 VII:2', genres: ['dnb'],
    note: 'pedal-and-move: sit on i, drop a tone',
  },
  {
    text: 'i7:2 iv7:2', genres: ['dnb'],
    note: 'liquid: minor sevenths, two bars each',
  },

  // --- house: seventh vamps -----------------------------------------------------
  {
    text: 'i7 iv7', genres: ['house'],
    note: 'the two-chord house vamp — everything else is groove',
  },
  {
    text: 'i7 VI7 iv7 v7', genres: ['house'],
    note: 'four sevenths round the loop, deep-house flavoured',
  },
  {
    text: 'ii7 v7', genres: ['house'],
    note: 'ii–v that never resolves, which is why it loops forever',
  },
  {
    text: 'i7:2 VII7:2', genres: ['house', 'dnb'],
    note: 'sevenths, two bars each — pads more than stabs',
  },

  // --- electro: static and mechanical -------------------------------------------
  {
    text: 'i i VI VI', genres: ['electro'],
    note: 'barely moves — the riff does the work',
  },
  {
    text: 'i III VII iv', genres: ['electro', 'breaks'],
    note: 'brighter middle, dark landing',
  },
  {
    text: 'i:4', genres: ['electro', 'dnb', 'breaks', 'house'],
    note: 'one chord, four bars — a modal drone for a riff to sit on',
  },
];

export const progressionsFor = genre => PROGRESSIONS.filter(p => p.genres.includes(genre));

// The one a genre starts on: its first entry, which is the most characteristic
// of that genre by the order above.
export function defaultProgressionFor(genre) {
  return progressionsFor(genre)[0]?.text ?? PROGRESSIONS[0].text;
}

// The ↻ button: the next progression of this genre after the current text,
// wrapping. Text the library doesn't have (something typed by hand) starts the
// cycle from the beginning rather than being treated as an error — the button
// means "show me another", not "validate what I typed".
export function nextProgressionFor(genre, text) {
  const list = progressionsFor(genre);
  if (!list.length) return defaultProgressionFor(genre);
  const at = list.findIndex(p => p.text === String(text ?? '').trim());
  return list[(at + 1) % list.length].text;
}

export const progressionNote = text =>
  PROGRESSIONS.find(p => p.text === String(text ?? '').trim())?.note ?? '';
