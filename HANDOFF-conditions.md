# Trig conditions handoff brief (PROB / FILL / COND)

You are implementing the "Next" item in `PLAN.md`: per-trig probability, fill,
and trig conditions for the Digitakt II and Digitone II. Phases 1–4 are
complete and hardware-verified; this feature adds per-trig fields to a
decode/encode we already own. Work through the stages **in order** — each has
acceptance criteria, and Stage 0 is a hardware experiment that gates
everything byte-level.

## Read these before writing any code

- `PLAN.md` §"Next — probability / fill / trig conditions" — the plan this
  brief executes
- `CLAUDE.md` — non-negotiables and safety rules
- `docs/dt2-pattern-format.md`, `docs/dn2-pattern-format.md` — byte layouts;
  especially the six unknown per-step arrays at track offset 256 AND the
  p-lock pool layout (80 × 258 bytes)
- `js/elektron/pattern-core.js` — decode/encode core (`decodePatternKit`,
  `trackNotes`, `encodeTrackNotes`, `describeOffset`)
- `js/elektron/dt2/pattern.js`, `js/elektron/dn2/pattern.js` — device specs
- `js/elektron/safe-write.js` — the safe write flow; **the composition point
  for this feature's write path**
- `js/elektron/copy-track.js`, `js/roll-bridge.js` — note interchange seams
- `js/labs/difflab.js` + `difflab.html` — the experiment workbench
- `test/roundtrip.test.js` — the minimal-diff property test to imitate

## Hard rules (violating any of these fails the task)

1. **Do not modify the hardware-verified encode/decode internals**:
   `sevenbit.js`, `protocol.js`, the decode/encode paths in
   `pattern-core.js`, `dt2/pattern.js`, `dn2/pattern.js`. **Two narrow
   exceptions are pre-authorized by Neil for this feature, and nothing more:**
   - adding constants to each device `SPEC` once Stage 0 has pinned them
     (a lane offset and/or p-lock paramIds — numbers only, no logic);
   - teaching `describeOffset` in `pattern-core.js` to label whatever region
     Stage 0 identifies (it is a diagnostic labeller, not a decode path).

   Everything else composes: the new bytes are read/written by a **new**
   module `js/elektron/trig-cond.js` operating on the payload after/beside
   the existing functions. If you believe you need to change anything else in
   the protected files, **stop and report why** instead of editing.
2. Runtime stays **zero-dependency vanilla JS** — ES modules, no bundler, no
   framework, no npm package reaching the browser. Vitest is dev-only.
3. All five safety rules in `CLAUDE.md` apply. The new fields ride the
   existing `safeWriteTrack` flow — do not add a second write path.
4. **No writes to hardware during development.** Develop against `dumps/`
   fixtures + Vitest. Stage 0 is the exception and is driven by Neil at the
   box; your part of it is captures and diff reading only (read-only SysEx).
5. Every stage gets unit tests before moving on. The model is the existing
   minimal-diff property test: prove untouched bytes stay byte-identical.
6. When reporting finished work, state explicitly what has **not** been
   verified on hardware.

## The hardware model (II-series — verified against the DN2 manual, and the
## DT2's matches; do NOT trust gen-1 Digitakt/Digitone descriptions)

On the II boxes these are **three independent per-trig fields**, all on TRIG
PAGE 1, all applied per trig by holding the trig and turning the knob
(the manual calls these "conditional locks" — a kind of parameter lock):

- **PROB** — probability 0–100% that the trig plays, re-evaluated every time
  the trig comes up. Track-level default 100%; p-lockable per trig.
- **FILL** — ON/OFF. Manual: a trig with FILL ON plays when FILL mode is
  active; a trig with FILL OFF plays when FILL mode is not active. Default
  OFF. (Gen-1's `FILL`/`!FILL` COND values became this dedicated toggle.)
- **COND** — one value from this list, or none (manual §10.12.3):
  - **Logic (8):** `PRE`, `!PRE`, `NEI`, `!NEI`, `1ST`, `!1ST`, `LST`, `!LST`
    (the manual prints negations with an overline; digi-roll uses a `!`
    prefix everywhere — labels, state, docs)
  - **Ratios (35):** `1:2`, `2:2`, `1:3`, `2:3`, `3:3`, `1:4` … `4:4`,
    `1:5` … `5:5`, `1:6` … `6:6`, `1:7` … `7:7`, `1:8` … `8:8`
  - **Negated ratios (35):** `!A:B` for each of the above — true when `A:B`
    is false

  PROB and COND are independent and combine (a trig can be 50% *and* `2:4`).

Semantics, for tooltips/docs: `PRE` = plays if the most recently evaluated
condition on the same track was true; `NEI` = same but on the neighbour
(previous) track; `1ST`/`LST` = plays only on the first / last loop of the
pattern before a pattern change; `A:B` = plays on loop A of every group of B
loops (e.g. `1:2` = loops 1, 3, 5, …; `2:4` = loops 2, 6, 10, …).

**All three fields are per trig (per step), not per note.** In the roll,
notes sharing a step form one trig (a chord). digi-roll's rule, applied
everywhere: **every note on a step carries the same `prob`/`fill`/`cond`
values** — the UI writes them to all notes on the affected steps, import
stamps a step's values onto all of its notes, and the encoder reads the first
note per step (mirroring how velocity/length/micro already work in
`encodeTrackNotes`).

Note-model representation (flat fields on the note, like `micro`):

- `prob`: integer 0–100, or `null` = no p-lock (track default, 100%)
- `fill`: `true` (FILL ON) or `false`/absent = default OFF
- `cond`: canonical label string (`'PRE'`, `'!1ST'`, `'2:4'`, `'!2:4'`) or
  `null` = none

The canonical COND list lives in ONE place (Stage 1) and everything else
imports it.

## Stage 0 — byte-mapping experiment (with Neil, hardware, read-only)

Nothing byte-level may be coded from guesses. **Two storage hypotheses, and
the diff decides:**

- **Hypothesis A — the six per-step lanes at track offset 256** (`0xFF`-
  filled, verified NOT to hold note/velocity/length/micro; `describeOffset`
  already labels them `track N unknown per-step array K, step S`; two fixture
  trigs already show "a single small value" in the first lane).
- **Hypothesis B — the p-lock pool** (pattern offset 68100 DT2 / 68148 DN2:
  80 lanes of `paramId u8, track u8, 128 × uint16be`). The manual calling
  these "conditional **locks**", and PROB being explicitly "parameter
  locked", makes this at least as likely — possibly PROB in the pool and
  FILL/COND in the lanes, or any mix. `describeOffset` labels pool hits
  `p-lock lane N, …` so difflab output names either region directly.

Protocol (Neil turns the knobs; you run `difflab.html`, read diffs, keep the
log). Throwaway project, DT2 first. Batch 16 values per capture. For every
changed byte record: offset, difflab's label, old → new value. Also record
any **step-word** or **trig-record** changes — if setting one of these flips
a flag bit, the write path must reproduce it.

1. **Baseline**: 16 trigs on steps 1–16 of track 1. Capture.
2. **PROB p-locks**: Neil holds each trig and sets a distinct PROB
   (0, 5, 10, 15, … 75 — include 0 and skip 100, the default). Capture +
   diff. This pins PROB's per-trig storage and value encoding.
3. **Track-level PROB**: re-baseline; change the track's PROB (no trig held)
   to e.g. 80%. Capture + diff — pins where the track default lives (track
   struct tail? kit?). digi-roll may choose not to write it, but must know
   what it is so it is never clobbered.
4. **FILL**: re-baseline; FILL ON p-locked on trigs 1–8, leave 9–16 alone.
   Capture + diff. Then track-level FILL ON with no locks, capture + diff.
5. **COND walk**: re-baseline; set COND on trigs 1–16 to the first 16 values
   in the box's COND menu. Capture + diff. Repeat in batches of 16 until the
   whole menu (expected 78 values: 8 logic + 35 ratios + 35 negated ratios)
   is logged, re-baselining between rounds. Record the box's own menu order —
   it is the enum.
6. **Negative probes**, one capture each:
   - set a COND then remove it (hold trig + press NO, or dial to none) →
     what value is stored? Same question for a PROB lock and a FILL lock.
   - COND + PROB + FILL on the **same** trig → confirm the three fields are
     independent bytes/words, and (on the DT2) that quad records don't change
   - delete a locked trig → do the values linger? (Everything else on these
     boxes lingers — confirm, because the write path must clear stale values
     before enabling a trig on a previously-used step.)
7. **DN2 pass**: same regions expected at the same track-relative offsets
   (the +48 shift is in the spec). Abbreviated walk — first/last COND menu
   values, one ratio + its negation, a PROB lock, a FILL lock, the none
   probes — unless anything disagrees with the DT2, in which case walk it
   fully.
8. **Save one capture per box with known values on known steps into
   `dumps/`** — these become the decode-test fixtures.

Deliverables: value ↔ meaning tables for PROB/FILL/COND on both boxes; the
storage locations (lane offsets and/or p-lock paramIds); side effects on step
words/records; updated `docs/dt2-pattern-format.md` and
`docs/dn2-pattern-format.md` (new sections with `[V]` provenance +
experiment-log entries in the DN2 doc's style); the two fixtures committed.

If the diffs land somewhere neither hypothesis predicts, stop and report what
the diff showed before designing anything.

## Stage 1 — enum + decode (read-only, zero device risk)

**`js/elektron/conditions.js`** (new): the canonical tables, built from
Stage 0's results — the ordered COND list (box menu order) as
`{ key, value, group }` with `group` ∈ `'logic' | 'ratio' | 'notratio'`,
plus whatever value-encoding maps PROB and FILL need. If the DT2 and DN2
encodings are identical (expected), one table; if not, keyed by device slug.
Export lookups in both directions; unknown stored values decode to `null`
with a console warning, never a throw (future OS builds may add values).

**`js/elektron/trig-cond.js`** (new): pure functions over a pattern-kit
payload + device spec, composing with — never reaching into — the existing
decode/encode. Exact shape depends on Stage 0 (per-step lane bytes are
trivial; p-lock pool entries mean find-or-create a `(paramId, track)` lane
and read/write its per-step u16s — and freeing a lane that ends up all-unused,
matching whatever the box does). The contract either way:

- `readTrackTrigSettings(spec, payload, trackIndex)` →
  `Map(step → { prob, fill, cond })`, skipping defaults/unknowns.
- `applyTrackTrigSettings(spec, payload, trackIndex, byStep)` → mutates and
  returns the payload (callers pass the fresh copy `encodeTrackNotes` just
  returned): first **clear the track's stored values for all 128 steps** to
  their verified "none" state (a fresh trig on a step with stale leftovers
  would silently inherit them), then write the given steps' values. It
  touches nothing outside the regions Stage 0 mapped for this track.

**Specs**: add the Stage 0 constants to both `SPEC`s (the authorized
change); extend `describeOffset` if the mapped region needs better labels.

**Import**: `trackNotes` stays untouched. Add to `js/roll-bridge.js`:
`attachTrigSettings(notes, byStep)` — stamps `prob`/`fill`/`cond` onto every
note whose `step` has an entry. Call it at the two import sites —
`js/main.js:786-792` and `js/labs/console.js:266-272` — between `trackNotes`
and `deviceNotesToRoll`. `deviceNotesToRoll` and `rollNotesToDevice` in
`roll-bridge.js` pass the three fields through (defaults `null`/`false`/
`null`).

Tests: enum round-trips for every COND value; decoding the Stage 0 fixtures
yields exactly the values Neil set, on exactly the right steps;
`readTrackTrigSettings` on a pre-feature fixture returns an empty map.

## Stage 2 — note model + Edit tab + roll display

**`js/state.js`**: `makeNote(step, pitch, len, velocity, micro, trig)` where
`trig` is optional `{ prob, fill, cond }` spread onto the note as flat
fields with defaults (`prob: null, fill: false, cond: null`). `loadState`
backfills the three fields next to the existing micro backfill.

**Edit tab** (`index.html`, in the Notes group directly under the Velocity
slider) — Neil's requested layout, one control per hardware field:

```html
<div class="row" title="Trig probability for the selected notes — chance the trig plays, re-rolled every pass. 100 = no lock (track default)">
  <span class="lab">Probability</span><b id="probLabel"></b>
</div>
<input id="prob" type="range" min="0" max="100">
<div class="row" title="Fill trigs play only while FILL mode is active on the box">
  <span class="lab">Fill</span><input id="fill" type="checkbox">
</div>
<div class="row" title="Trig condition for the selected notes — one per step on the box; notes sharing a step share it. Combines with probability.">
  <span class="lab">Condition</span><select id="cond"></select>
</div>
```

The `<select>` is built in JS from `conditions.js`: first option `— none —`
(value `''`), then three `<optgroup>`s (Logic / A:B / !A:B) in the box's
menu order. Behaviour for all three controls, mirroring the velocity
slider's selection handling (`js/main.js:302-311`) but **without** a
new-note default — new notes are always unlocked; these are placed
deliberately:

- changing a control sets the field on every selected note **and every note
  sharing a step with a selected note**, then saves state and redraws;
- `prob` slider at 100 stores `null` (no lock), anything else the integer;
- with nothing selected the controls are no-ops;
- the `onSelect`/`lastTouched` hook that mirrors velocity into the slider
  (`js/main.js:116-119`) also mirrors the touched note's three fields into
  the controls (`prob ?? 100`, `fill`, `cond ?? ''`).

**Roll display** (`js/pianoroll.js` — it knows nothing about devices, and
these are just a number/bool/string, so this stays true): in the
note-drawing pass (around `js/pianoroll.js:372`), when a note has any of the
three set, draw a small marker — a 5px triangle clipped into the note's
top-right corner in a darker shade — and, when the note is at least 2 cells
wide, a compact text tag left-aligned inside the note: the cond label and/or
`n%`, `F` for fill (e.g. `2:4 50%`, `F`, `!1ST`). No new canvas
interactions; the Edit tab is the only way to set these in this release.

**Carry the fields through every place notes are rebuilt** (this is where
drift happens — hit each one):

- clipboard copy `js/main.js:339` (add the three fields) and paste
  `js/main.js:357`
- dup bar `js/main.js:408`
- chord builder `js/main.js:289` (chord-mates take the source note's fields
  so the step-uniformity rule holds)
- chord-draw stamping in `js/pianoroll.js:206` stays unlocked (new notes)
- MIDI import `js/main.js:387` stays unlocked (SMF has no such concept);
  MIDI **export** drops them — add one line to the export button's title
  saying so
- bank `js/bank.js`: `serializePattern` adds the three fields;
  `deserializePattern` passes them into `makeNote`. **Do not bump
  `BANK_SCHEMA`** — old saves load with defaults, old code ignores the extra
  fields.

Update the two hint/help paragraphs (`index.html:88` and the help panel at
`index.html:204-205`).

Tests: state round-trip through save/load keeps all three; bank round-trip
keeps them and old-schema entries still load; the step-uniformity rule after
the UI operations above (pure-function tests where possible).

## Stage 3 — write path + cross-device copy

**`js/elektron/safe-write.js`** (the composition point): `safeWriteTrack`'s
`notes` now carry the three fields. After `const { payload, dropped } =
mod.encodeTrackNotes(original, trackIndex, notes)`
(`js/elektron/safe-write.js:128`), build `byStep` — for each step, the first
note's `{ prob, fill, cond }`, sorted (step, pitch) to match the encoder,
skipping steps where all three are default — and run
`applyTrackTrigSettings(mod.SPEC, payload, trackIndex, byStep)` before
`sendPatternKit`. The existing verify/backup machinery needs no changes.

**`js/elektron/copy-track.js`**: the fields travel with the notes.
`deviceNotesToEncoder` (`js/elektron/copy-track.js:19`) passes them through;
`copyTrack` reads source settings via `readTrackTrigSettings` and applies
them to the target payload after `encodeTrackNotes`. Both boxes share the
same lists, so nothing should degrade — but if Stage 0 finds any value one
box has and the other lacks, drop it loudly via the `warnings` array,
`describeChordDrops` style, never silently. Check the console copy path
`js/labs/console.js:508-516` end-to-end.

Tests, in the image of the existing minimal-diff property test:

- encode + apply on a fixture: every byte outside the track's step words,
  the trig-record pool, **and the Stage 0 regions for that one track** is
  byte-identical; other tracks' regions untouched (for p-lock storage this
  includes: other tracks' lanes never touched, and lane allocation matching
  the box's observed behaviour)
- write-then-read pure round-trip: notes with all three fields → encode +
  apply → decode + read + attach → the same notes with the same fields
- a locked note on a step whose stored bytes held stale leftovers: the fresh
  value wins; an unlocked note on such a step: leftovers cleared to none
- a chord truncated by `truncateChords` keeps the step's settings

Acceptance: `npx vitest run` fully green; a fixture-only end-to-end (import
locked fixture → roll → write-encode → byte-compare against expectation)
passes. **State plainly that hardware write verification has not happened
yet** — that's the checklist below, run by Neil.

## Stage 4 (optional, last) — browser playback preview

If everything above lands cleanly: `js/midi.js`'s scheduler (`_schedule`,
around `js/midi.js:238`) evaluates per pass, using the loop count
`Math.floor(this._step / lengthSteps)`:

- `prob` → play if `rng() * 100 < prob` (null = play)
- `A:B` → play if `loop % B === A - 1`; `!A:B` → the inverse
- `1ST` → loop 0 only; `!1ST` → loop > 0
- `PRE`/`!PRE`/`NEI`/`!NEI`/`LST`/`!LST` and `fill` → **always play** in
  preview (the browser has no fill mode, no cross-track evaluation, and no
  "last loop before a pattern change"); say so in the controls' title text

Keep it to a small pure helper `shouldPlay(note, loop, rng)` with unit tests
(deterministic cases; inject the RNG). If this stage threatens to grow
beyond that, skip it and note it as follow-up.

## Wrap-up

- Update `PLAN.md`: move this to Shipped (with the not-yet-hardware-verified
  caveat until Neil's smoke test), keep the p-lock item as Next — and if
  Stage 0 proved the p-lock-pool hypothesis, note that the lane-management
  code in `trig-cond.js` is the foundation the p-lock feature builds on.
- Docs were updated in Stage 0; add a "what digi-roll does with this" line to
  both format docs mirroring the existing sections.
- Hardware smoke-test checklist for Neil (do NOT run it yourself):
  1. throwaway project; draw a pattern with a PROB lock, a FILL trig, a
     ratio + a negated ratio COND, and one locked chord; Send to box
  2. box UI shows the right PROB/FILL/COND on each trig; playback behaves
  3. re-read → byte-identical (the verify step reports this)
  4. import the same track back → all three fields round-trip exactly
  5. cross-device copy DT2 ↔ DN2 with locks → same checks

## Out of scope

General p-lock lanes in the roll UI (next roadmap item — even if this
feature's storage turns out to be p-locks, only PROB/FILL/COND are surfaced);
retrigs; LFO.T/FLT.T trig toggles; drawing locks with mouse gestures on the
canvas; fill-mode simulation in the browser; the Octatrack live-record path.
