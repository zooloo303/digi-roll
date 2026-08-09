# The pattern generator — design

Status: **built and hardware-verified 2026-08-09**, all five phases, on branch
`pattern-generator`. Decided with Neil the same day; the four scope questions and
their answers are at the bottom, and **“What actually shipped”** near the end
records the places the build departed from this plan and why.

Somewhere between a randomiser and a session musician: pick a genre and a key,
and digi-roll writes a **bassline, a chord part and a lead** that agree with each
other — using the trig conditions, track-level feel and p-lock lanes it already
knows how to send.

## What it is, in one paragraph

A **song context** (key, scale, bars, chord progression, genre, seed) sits above
the eight pattern slots. Generating fills one slot per part — bass into slot 1,
chords into slot 2, lead into slot 3 — all locked to the same progression and
aware of each other's rhythm. Each slot is then sent to its own track on the box
by the existing **Send to box** path. Everything the generator produces is
ordinary pattern state: notes, per-note velocity/length/micro-timing, per-trig
PROB/FILL/COND, and p-lock lanes.

## The safety story: no new write surface

This is the reason a feature this size is low-risk. The generator is a **pure
producer of `js/state.js` pattern objects**. It never encodes a byte, never
touches `js/elektron/`, and adds no write path — its output leaves for the box
through `safeWriteTrack`, unchanged and already hardware-verified. Concretely:

- No protected file is touched (`sevenbit.js`, `protocol.js`, the
  `pattern-core.js` encode/decode paths, `dt2/pattern.js`, `dn2/pattern.js`).
- No file under `js/elektron/` is modified at all, with one read-only exception:
  the generator *reads* the curated parameter tables to know which p-lock lanes
  are writable on the target box.
- **The generator never writes `pattern.swing`.** Neil's explicit constraint, and
  it has teeth: swing is the one per-pattern byte that re-times all sixteen
  tracks in the destination slot, so a generator quietly setting it would change
  parts it wasn't asked to touch. Genre groove is expressed through **per-note
  micro-timing** instead, which is per note, stored on the box, and harmless to
  the other fifteen tracks.
- It also leaves `trackProb`, `channel`, `source` and `dest` alone. Track PROB is
  a per-pattern default the user sets; the generator expresses chance through
  **per-trig PROB locks**, which is the hardware's own model (see CLAUDE.md).
- It *does* set `lengthSteps`, because bar count is part of the song context, and
  `notes` / `plocks`, which is the point.

Runtime stays zero-dependency vanilla ES modules. Every module below is pure and
canvas-free, tested in the `edit-ops.js` / `chords.js` style.

## Module layout

New directory `js/gen/`, all pure:

| file | what it owns |
|---|---|
| `rng.js` | seeded PRNG (mulberry32) + `pick` / `weighted` / `chance` / `range`; `rngFor(seed, tag)` derives an independent stream per part |
| `theory.js` | key/scale/degree maths, roman-numeral parsing, chord-tone sets per bar, register windows |
| `progressions.js` | the genre-tagged progression library |
| `genres.js` | the four genre profiles — tempo, bar count, per-role step weights, length and velocity distributions, groove offsets, lane and condition recipes |
| `rhythm.js` | step-weight table + density → the set of steps that get trigs; syncopation, accents, ghosts, groove micro-timing |
| `motif.js` | motif generation and development (transpose, displace, invert, retrograde) — the lead's memory |
| `parts/bass.js` `parts/chords.js` `parts/lead.js` | one function each: `(ctx, rng, band) → { notes, lanes }` |
| `plockdesign.js` | role + genre + target device → p-lock lanes from the curated writable set |
| `arrange.js` | the orchestrator: song context → per-slot results, generating in band order and threading the shared rhythm map |
| `context.js` | the song-context object, defaults, genre-driven re-defaults, (de)serialisation |

UI: `js/genpanel.js` (panel wiring in the `main.js` idiom) and a new
`generatePanel` aside plus rail button in `index.html`.

Tests, one file per module, in `test/`: `gen-rng`, `gen-theory`,
`gen-rhythm`, `gen-motif`, `gen-parts`, `gen-plocks`, `gen-arrange`,
`gen-context`.

## The song context

```js
{
  genre: 'dnb' | 'breaks' | 'electro' | 'house',
  root: 0-11,            // shared with state.scaleRoot
  scale: 'Minor' | ...,  // shared with state.scale, a key into SCALES
  bars: 1 | 2 | 4 | 8,   // → lengthSteps 16 / 32 / 64 / 128
  progression: [ { degree: 1-7, quality, seventh, bars } ],
  seed: uint32,
  feel: { motion, looseness, humanize },      // 0-100 each
  parts: {
    bass:   { on, slot, density, octave },
    chords: { on, slot, density, octave },
    lead:   { on, slot, density, octave },
  },
}
```

Lives at `state.gen`, backfilled in `loadState` exactly as `trackProb` and
`plocks` were — no schema bump, older saves simply get the defaults.

Root and scale are **the same values the Harmony panel already edits**, not a
second copy. The generate panel's Root/Scale selects write `state.scaleRoot` /
`state.scale` and are re-read by `syncToolbar`, so the tinted rows on the grid
always agree with what was generated.

## Seeds: reproducible, and stable under tweaking

A visible seed makes any result reproducible and shareable, `🎲` rolls a new one,
and the lock keeps it fixed while you push density and genre around. The detail
that makes locking feel right: each part draws from `rngFor(seed, 'bass')` rather
than one shared stream, so nudging the lead's density doesn't reshuffle the bass.
Every generator function takes an rng argument and calls no global random — which
is also what makes them testable.

## Genres

Four profiles, each a plain data object. They supply a **suggested tempo** (the
panel offers "set 174 bpm?" rather than changing it behind your back) and the
rhythmic grammar per role.

- **DnB** — 172–176, 2 bars default. Bass: a long root anchor on the 1, then
  syncopated stabs off the grid; deep register; heavy use of `1:2`/`2:2` so a
  two-bar loop breathes. Chords: sparse sustained stabs, often only on the 1 and
  the "and" of 3. Lead: half-time-feeling motifs, wide space.
- **Breaks** — 130–140, 2 bars. Funk-leaning: syncopated bass with ghost notes at
  low velocity carrying PROB locks, chords as stabs off the beat, lead answering
  in the gaps.
- **Electro** — 125–135, 2 bars. Sixteenth-driven staccato bass with octave
  leaps, held or pulsing chords, arpeggio-ish leads.
- **House** — 120–128, 1–2 bars. The off-beat bass (a note on every "and"),
  seventh-chord stabs on the off-beat, simple hooky leads. House shuffle would
  normally be swing, which we may not touch — it comes out as micro-timing.

## Progressions

A genre-tagged library of roman-numeral progressions (minor loops like
`i · VI · III · VII`, house seventh vamps like `i7 · iv7`, DnB pedal-and-move
shapes), picked by the genre with a `↻` to shuffle to another of that genre's,
and an editable text field so you can type your own (`i VI III VII`, or with
explicit qualities). Parsing is `theory.js`; a malformed entry is reported on the
status line and the previous progression is kept.

The key comes from Root + Scale. Chord tones per bar come from `chordPitches` in
`js/chords.js` — the existing diatonic thirds-walker, so a degree gets its
natural quality with no chord tables, exactly as chord draw already does.

## The three parts, and why it's a band and not three randomisers

Parts are generated **in order — bass, chords, lead** — and each is handed the
accumulated *rhythm map* (which steps are already busy, and in which register)
plus the shared progression. That single piece of shared state is what buys
call-and-response.

**Bass.** Roots, fifths, octaves and the flat seven, with occasional approach
tones into a chord change. Register window 24–48. Downbeats accented, ghosts
soft. Note lengths from the genre profile — DnB's long anchor notes use the fine
LEN scale via `snapLenFine`, so what's drawn is what the box stores.

**Chords.** One voicing per progression slot, stamped through `chordPitches` and
`voiceChord` (which already handles the 4-note hardware ceiling, the strum
stagger and the velocity taper). The session-musician touch here is **voice
leading**: the inversion of each chord is chosen to minimise total semitone
movement from the previous one, so the part walks instead of jumping. Register
48–72.

**Lead.** Motif-based, which is the actual difference between this and a
randomiser. A short 3–6 note motif is generated once, then *developed* across the
progression — repeated, transposed onto the next chord's tones, rhythmically
displaced, inverted, occasionally retrograded. Strong beats land on chord tones,
weak beats may pass. Density is penalised on steps the bass already owns, so the
lead answers rather than doubles. Register 60–90.

## Conditions, used musically

The generator uses per-trig PROB/FILL/COND for the things they're actually for,
with the amount driven by the **Looseness** slider (0 = none):

- `1:2` / `2:2` — alternate bars, so a two-bar loop isn't two identical bars
- `3:4` / `4:4` — details that arrive every fourth time round
- PROB 60–85 on ghost notes and passing tones — the part breathes
- `FILL` ON for notes that only exist when you hold FILL, OFF for notes that step
  aside during one
- `NEI` / `PRE` sparingly, for a run that answers the trig before it

## P-lock lanes

Driven by the **Motion** slider (0 = generate no lanes). Lanes are chosen from
the curated, *writable* parameters for the resolved target box only — cutoff,
resonance, env depth, pan, overdrive, the three sends, the three LFO depths.
Recipes are per role: a cutoff contour that opens across a phrase, delay/reverb
send swelling at phrase ends, overdrive on bass accents, pan movement on a lead.

The target box is resolved exactly as the add-lane picker already does —
pattern provenance, then connected-box identity, then MIDI port name. **With no
box resolvable the generator makes no lanes and says so on the status line**,
rather than guessing a device kind, because a lane belongs to one box's parameter
numbering. Values sit on the display axis and only reach uint16 at the existing
roll↔device seam, so nothing new knows about bytes. Lanes only get values on
steps that have trigs, which is the v1 rule `pruneLanesToTrigs` enforces anyway.

## The panel

New rail button **Generate** (between Harmony and Library — it's a
composition tool, and it reads the Harmony panel's key).

```
Genre  [ DnB ▾ ]        Bars [ 2 ▾ ]        ⓘ suggests 174 bpm  [Set]
Root   [ C ▾ ]          Scale [ Minor ▾ ]
Progression [ i VI III VII        ] [↻]
Seed        [ 1834721 ] [🎲] [🔒]

Parts
  ☑ Bass    → slot [1 ▾]   density ▓▓▓░░
  ☑ Chords  → slot [2 ▾]   density ▓▓░░░
  ☑ Lead    → slot [3 ▾]   density ▓▓░░░

Feel   Motion ▓▓░   Looseness ▓▓░   Humanize ▓░░

[ Generate arrangement ]   [ Generate this slot ]
```

`Generate arrangement` replaces every checked slot; `Generate this slot`
regenerates only the current one against the same context, which is how you keep
a bass you like and re-roll the lead. Both are destructive by design (the agreed
answer to question 4) and both are undoable.

**Undo needs one small change to `main.js`.** Today an undo entry is a snapshot of
*one* slot (`snapshot(slot)` / `step()`), which can't express "three slots
changed at once". The entry becomes a list of slot snapshots — a single-slot
entry is a list of one, so every existing caller is unchanged in behaviour. This
is the only edit to existing app code the feature needs beyond wiring.

## Phasing

Each phase ends with `npx vitest run` green and something usable.

1. **Foundation** — `rng`, `theory`, `progressions`, `genres`, `context`, the
   `state.gen` plumbing and the multi-slot undo entry. No UI. Tests prove
   determinism (same seed ⇒ identical output, different tags ⇒ independent
   streams) and the roman-numeral parsing.
2. **Bass + panel skeleton** — `rhythm.js`, `parts/bass.js`, the Generate panel
   with genre/key/bars/progression/seed and a single-slot generate. First thing
   you can hear on the box.
3. **Chords + lead + arrangement** — voice leading, motif development, the
   shared rhythm map, `arrange.js`, `Generate arrangement`.
4. **Conditions + p-locks** — the Looseness and Motion sliders, `plockdesign.js`,
   the device resolution and its honest refusal.
5. **Polish** — help page section, the bpm suggestion, panel hints, PLAN.md
   record, and a hardware smoke test.

## What actually shipped (2026-08-09)

All five phases, in one session. Every module in the table above exists with the
contents described, plus `js/genpanel.js` and the `generatePanel` aside. **801
tests green** in the suite as a whole, 291 of them new: `gen-rng` (19),
`gen-theory` (37), `gen-rhythm` (27), `gen-motif` (21), `gen-parts` (65),
`gen-plocks` (23), `gen-context` (26), `gen-arrange` (37) and `genpanel` (36).

Nine things the build settled that this plan either left open or got wrong. Each
one is a decision worth not re-deriving:

1. **The progression is stored as text, not as a parsed array.** The context
   holds `progression: 'i VI III VII'` and `resolveContext` is the only thing
   that parses. One source of truth for the field you type in — and it made the
   error behaviour better than planned: a malformed entry **stays on screen**
   with the parser's own sentence under it in red, the context keeps the last
   good progression, and *generating refuses* until it's fixed. Reverting what
   somebody typed, which is what "the previous progression is kept" implied,
   loses their work and hides the mistake.
2. **`state.gen` is backfilled by the panel, not by `loadState`.** Putting it in
   `loadState` would make `js/state.js` import `js/gen/context.js`, which reaches
   `theory.js` and so `js/pianoroll.js` — which imports `js/state.js`. A cycle
   through the module everything else depends on isn't worth it, so `state.js`
   declares `gen: null` with a pointer and `GeneratePanel`'s constructor
   normalizes it at start-up. Same user-visible behaviour, no cycle.
3. **"Generate this slot" bumps a per-part `variation`, not the seed.** Rolling
   the seed would move all three parts, so the re-rolled lead would be answering
   a bassline that is no longer in the slot. Instead each part's stream tag is
   `role` or `role#variation` (`streamTag` in `arrange.js`), so only the part you
   asked for changes and it still answers the parts you kept. `variation` is a
   context field the plan didn't have. The seed lock keeps its meaning: locked,
   `Generate arrangement` reproduces the same song; unlocked, it rolls a new one.
4. **All three parts are generated even when unchecked**, and the caller applies
   only the checked ones. Otherwise unchecking the bass would reshuffle the lead,
   because the lead answers the bass's rhythm map.
5. **Motion drives nothing but automation.** An early cut had the bass's
   approach-tone and chord-tone odds scaled by Motion, which meant moving the
   Motion slider rewrote the notes. Every pitch decision now reads only the genre
   profile and the seed; Motion is p-locks, Looseness is conditions, and each
   slider changes exactly the thing it names. Lanes also draw from their own
   stream (`role.lanes`), for the same reason.
6. **Voice leading needed octave transpositions, not just inversions**
   (`voicingCandidates` in `theory.js`). Inversions alone all sit wherever the
   folded root landed, so on a low window the next chord can only travel upward —
   the opposite of voice leading. Two traps came with it: candidates the window
   *clipped* have to be dropped, or a two-note chord wins any "moves least"
   contest by having fewer notes to move; and the **first** chord has nothing to
   lead from, so it is placed near the middle of the register instead.
7. **Groove and strum are snapped to the box's 1/24-step micro grid**
   (`snapMicro`), the same bargain `snapLenFine` strikes for note lengths: what
   the roll draws is what the hardware stores, rather than a number that quietly
   rounds on write.
8. **Per-trig conditions are applied in `rhythm.js`** (`trigFeelFor`), keyed by
   *step*, and the parts stamp the result on every note sharing that step — the
   step-uniformity rule the encoder relies on. The plan implied the parts would
   each do it; one function keeps chords honest.
9. **`windowFor` lives in `theory.js`**, not `genres.js`, which is now a pure
   data leaf with no imports at all.

The panel gained two hints the plan didn't ask for and wants: it names the parts
when **two are aimed at one slot**, and it says up front when Motion is up but no
box can be resolved. Generating asks before replacing a slot that holds notes
(naming each slot and its note count), exactly as `Clear` does.

Testing the panel needed a DOM, and the repo has none. `test/genpanel.test.js`
stands up a ~40-line stub whose `getElementById` **only answers for ids that are
actually in `index.html`** — so a control the panel reaches for that the page
doesn't have is a test failure rather than a blank space in a browser. The 35
tests there cover the wiring proper: which control writes which field, the
confirm, the single multi-slot undo entry, the seed-lock semantics, the re-roll.

`test/gen-arrange.test.js` also carries the safety claim as a test: a generated part
goes through `encodeTrackNotes` + `applyTrackTrigSettings` + `applyTrackPLocks`
into a **real hardware fixture** for both boxes, and the notes, conditions and
lanes read back identically, with nothing outside the target track changed and
byte-identical output for a given seed.

## Hardware verification

Nothing here needed new hardware verification to be *safe* — the generator emits
the same pattern state a hand-drawn pattern emits, over write paths already
verified on both boxes, and the fixture tests above prove the encode end of that.
The smoke test was musical rather than protocol work:

10. Generate an arrangement, send bass/chords/lead to three tracks, and check on
    the box that the notes, per-trig conditions and p-lock lanes are what the roll
    drew, that playback sounds like the genre, and that **the destination
    pattern's swing is unchanged**.

**Run by Neil on hardware 2026-08-09, immediately after the build: everything
worked.** That also covered the panel in a real browser, which the build itself
never did — the Playwright browser was held by another session at the time, so
the panel had been driven only through `test/genpanel.test.js`'s DOM stub.

Two things the session didn't record, worth pinning down the next time hardware is
in front of someone: **which box** it was tested on (the p-lock lane recipes
resolve per box by canonical name, so DT2 and DN2 are separate confirmations), and
whether the genre groove reads as intended at each genre's own tempo.

## The four scope decisions (2026-08-09)

1. **Part scope: multi-slot with shared harmony.** A song context above the
   slots; generate all three parts locked to one progression. Rejected: one slot
   at a time with a remembered context, and fully self-contained per-slot
   generation.
2. **Melodic only for v1.** No drum or percussion role. A real breakbeat
   generator wants a whole DT2 kit, and digi-roll writes one track at a time —
   that belongs with the multi-track session sequencer in PLAN.md.
3. **Genre progression library with manual override.** Canned progressions tagged
   by genre, plus an editable field. Rejected: always-manual, and inferring a
   progression from an existing slot.
4. **Replace, with seed and reroll.** Generation overwrites the target slot as
   one undo entry; a visible, lockable seed makes results reproducible. No
   separate non-destructive "vary" mode in v1 — regenerating with the seed locked
   and one slider moved covers most of what it would have been for.

Primary target is the **Digitone II** (three melodic parts is what it's for);
everything works on a **Digitakt II** too, where the p-lock lane recipes resolve
to the DT2's own parameter numbering by canonical name.
