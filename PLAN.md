# digi-roll roadmap

Where this is going. Constraints and safety rules live in `CLAUDE.md`; the
byte-level formats in `docs/`. This file is the "what's next".

## Shipped

Phases 1–4, hardware-verified on a Digitakt II (OS 1.15B) and a Digitone II
(OS 1.10D), 2026-08-01/02:

- Whole-project backup to `.syx` — no Transfer app
- Pattern read/write for both boxes, including what we believe is the first
  SysEx pattern write to a Digitone II. Notes, velocities, lengths and
  micro-timing exact
- Round trip: import a track → edit → **Write back** (gated on provenance, so it
  won't write to a different box than the notes came from)
- **Send to box** on the main page — a fresh pattern into any track
- Cross-device track copy (DT2 ↔ DN2, or between slots on one box)
- Pattern bank: named localStorage saves, JSON export/import
- Editor: undo/redo, multi-select, copy/paste, dup bar, scale highlight, swing +
  micro-timing, MIDI file import/export
- The diffing lab (`difflab.html`) that reverse-engineered the DN2 format

**Per-trig conditions — PROB / FILL / COND** (2026-08-02). Byte mapping *and*
write path both hardware-verified on both boxes — the mapping 2026-08-02, the
write 2026-08-03 (checklist below). All three turned out to be plain per-step
byte lanes in the track struct — track offsets 256 (COND), 384 (FILL) and 512
(PROB) — *not* p-lock pool entries, which stayed empty throughout the
experiment. Identical on the DT2 and DN2, including one shared 76-value COND
list, so cross-device copy needs no translation. Format docs have the full
tables and experiment logs.

What shipped: the whole COND menu in the box's own order, tri-state FILL
(unlocked / ON / OFF — there is no track-level FILL or COND at all), 0–100%
probability, a step-aligned **trig lane** under the roll to edit them, and
carriage through import, write-back, cross-device copy and Library saves. The
browser preview evaluates probability and the loop-counting conditions; PRE,
NEI, LST and FILL always play, and the UI says so.

Smoke test, run and passed 2026-08-03. Kept as the recipe for repeating it on
a new OS build:

1. Throwaway project. Draw a pattern with a PROB lock, a FILL trig, a ratio and
   a negated ratio, and one locked chord. Send to box.
2. Box UI shows the right PROB/FILL/COND on each trig; playback behaves.
3. Re-read — the verify step should report byte-identical.
4. Import the same track back; all three fields round-trip exactly.
5. Cross-device copy DT2 ↔ DN2 with locks, then repeat checks 2–4.

Chord policy, DN2 → DT2: a DT2 trig holds 4 note slots, the DN2 is unlimited.
Fat chords keep the 4 highest-velocity notes (ties → lower pitches) and warn,
listing what was dropped. Decided and implemented.

## User-feedback round — built 2026-08-03

Three requests from actual users; this jumped the p-lock queue. All three are
**implemented, unit-tested** (`npx vitest run` green, 280 tests), driven
end-to-end in a real browser, and **tested by Neil on hardware 2026-08-03** —
including the track-PROB write, which was the one new write surface here.
The plan as built is below, with the decisions it was built from.

Two findings shaped the whole plan:

- **The hardware already supports all three.** Pattern-wide probability is the
  track-level PROB byte (`trackProb: 1168` in both device specs, decoded and
  documented but never written). Fine note lengths are native to the LEN byte
  scale (`lengthByteToSteps` in `pattern-core.js:31` — 1/16-step resolution
  below 2 steps, doubling above); only the roll UI and the import bridge
  quantize to whole steps.
- **Nothing here touches the protected encode/decode internals.** Every new
  byte write composes *after* `encodeTrackNotes`, in the `trig-cond.js` idiom,
  with a minimal-diff property test proving nothing else moved.

`npx vitest run` stays green throughout; every feature gets unit tests
(extract pure helpers, test them canvas-free, in the `triglane.test.js` style).

### A. Paste at position + alt-drag-copy — done

**Paste caret.** `PianoRoll.caret` records the last mouse-down grid cell.
`paste()` offsets the clipboard so its anchor note — earliest step, highest
pitch among ties — lands on the caret, preserving relative timing and pitch.
Notes whose start falls past the pattern end or off the pitch range are
dropped (and counted in the status line); lengths clamp as before. Caret
`null` (no click yet) ⇒ the old absolute-position behaviour. Pasted notes
become the selection.

**Alt-drag-copy.** Alt+mousedown on a note is now undecided until it moves,
the same bargain shift already strikes: past `DRAG_PX` it fires `onBeforeEdit`,
clones the group (the selection when the pressed note is in it, else just that
note), selects the clones and continues as `mode:'move'` on them. Mouseup
without movement deletes, as before. Right-click delete stays immediate.

The placement maths is `js/edit-ops.js` (`clipboardAnchor`, `placeClipboard`),
tested canvas-free in `test/edit-ops.test.js`. One undo entry per paste and per
drag-copy gesture. Help page and the Edit panel hint updated.

### B. Pattern-wide probability (track-level PROB) — done

The real hardware model, not a bulk-stamp: trigs without a PROB lock follow
the track default; explicit locks override. Exactly the user's "30% track,
some trigs at 100%".

- **State:** `pattern.trackProb` (0–100, default 100) in `defaultPattern`,
  backfilled on load like prob/fill/cond. Rides along in `serializePattern` /
  `deserializePattern`, defaulting to 100 when absent — no schema bump.
  Survives Clear, like swing and channel do.
- **UI:** a slider in the Edit panel's **Pattern** group, under Swing (the plan
  said "next to Velocity"; the Pattern group is where the other per-pattern
  controls live, and this one is per pattern). Cloned from the velocity slider
  including its one-undo-per-drag gesture latch, and re-synced by `syncToolbar`
  on slot switch. The PROB row of the trig lane renders the inherited default
  dimmed on note-steps without a lock, and only when the track isn't at 100.
- **Locking a trig at 100:** `probFromDrag` no longer collapses ≥100 to `null`;
  the top of the range is an explicit 100% lock. Clearing is alt/right-click
  only. `triglane.test.js` and the help page say so.
- **Device I/O:** `readTrackProb` / `applyTrackProb` in `trig-cond.js`, over the
  existing `trackProb` spec offset. Read on import in `main.js` and
  `labs/console.js`; applied in `safe-write.js` (new optional `trackProb`
  option, `null` = leave the byte alone), `copy-track.js`, and the console's
  cross-device copy. Out-of-range reads warn and give 100 rather than throwing.
  The console's Phase 2 inline write button was deliberately **not** touched at
  the time — it was kept as the untouched hardware-verified reference, and it
  already carried no per-trig conditions either. (Superseded by the console UX
  round below: that row now runs `safeWriteTrack` like everything else.)
- **Preview:** `shouldPlay(note, loop, rng, trackProb = 100)` uses the track
  default when `note.prob == null`; the engine passes `pattern.trackProb`.
- **Tests:** fixture-backed byte reads, a one-byte-moved property test for
  `applyTrackProb` on both boxes, cross-device carry, `shouldPlay` fallback
  cases, and the "30% track, one trig at 100" case end to end.

**Hardware-verified 2026-08-03** — the track PROB write works on the box. This
was a new write surface: reading the byte was already verified, writing it now
is too.

### C. Fine-grained note length — done

The encoder already passed fractional lengths through; the only quantizers were
the roll's resize handler and the import bridge.

- **Resize:** a plain edge-drag keeps whole-step snapping. Holding **shift**
  during a resize switches to fine mode: the raw fractional length under the
  pointer, snapped to the nearest hardware-representable value. Shift is free
  here — its velocity meaning binds on the note *body*, not the edge. Minimum
  0.125 steps.
- **Layering:** `roll-bridge.js` exports `snapLenFine(steps, maxSteps)`;
  `main.js` passes it in as the roll's `snapLen` opt, like `getDefaultVelocity`.
  The roll stays device-agnostic. Snapping picks the *nearest* representable
  length, which can round up past the room left in the pattern, so the result
  is walked back down the LEN scale until it fits.
- **Feedback:** the current length (`4.75`) is drawn next to the dragged edge
  during a fine resize. Notes shorter than ~2 px still draw a visible sliver.
- **Import stops rounding:** `deviceNotesToRoll` clamps to `[0.125, room]` with
  no `Math.round`. The DN2 fixture's 4.75-step trig now survives the whole
  round trip, and `roundtrip.test.js` asserts the notes come back *identical*
  rather than documenting the rounding.
- **Fraction-tolerance audit:** drawing, hit-testing, bank JSON and the
  remaining `n.len` clamps are all fractional-safe. One real bug found and
  fixed: the engine's note-off scheduled at `t + len*stepMs - 8`, which lands
  *before* the note-on for a 0.125-step note at a fast tempo — now floored at
  `t + 1 ms`. MIDI *file* export stays quantized at 24 ticks/step (accepted,
  said in the help page); MIDI import keeps rounding.
- **Chords:** the format stores one LEN per step — unchanged, not fought.

### Hardware smoke test — run and passed 2026-08-03

Track PROB was the item at risk, and it works on the box: the byte lands, the
TRIG page shows it, and an explicit per-trig 100% lock stays distinct from the
track default. Fine note lengths verified in the same session, as did the
per-trig conditions checklist above (steps 1–5). The steps, kept for whoever
repeats them on a new OS build:

6. Set track PROB 30% with one trig explicitly locked at 100%. Send to box —
   the TRIG page default shows 30, the locked trig shows 100, playback
   behaves. Verify step reports byte-identical; re-import round-trips
   `trackProb`; cross-device copy carries it.
7. Draw a note fine-resized to 4.75 steps and one at 0.125. Send, check LEN on
   the box, re-read byte-identical, re-import exact.

Every write surface as of that date — notes, per-trig conditions, track PROB,
fine lengths — went through encode → send → box UI → re-read on both boxes at
the allowlisted builds (DT2 `0070`, DN2 `0049`). Per-note chord values and
pattern swing joined them on 2026-08-04, so **nothing digi-roll writes is
unverified on a DN2**. The one gap is that swing has never been written to a
*DT2* — same byte, corroborated by the fixtures, untested on the box.

## Chord round — built 2026-08-04

Both items came out of Neil playing with chords on the box.

### A. Per-note velocity / length / micro — done, hardware-verified 2026-08-04

`encodeTrackNotes` took all three from a step's first note and mirrored them
across the trig, so every chord reached the box flattened to the *lowest*
note's values (the encoder groups by pitch). Strum and velocity taper were
discarded, and importing a box-authored chord and writing it back destroyed
what the box had stored.

Settled by a read-only capture: the DN2 edits all three per note in its own
NOTE EDIT menu, and its records carry three different velocities within one
trig. Ground truth is `dumps/digitone2-pernote-chords-2026-08-04.syx`, pinned
by `test/roundtrip.test.js`. The fix is a no-op for single-note trigs — a lone
note still mirrors across a DT2 quad — so nothing verified earlier moved. The
only approved edit to a protected encode internal so far.

Still unknown: whether a DT2 MIDI track *plays* each note slot's own values or
reads only the first. Harmless either way; the bytes round-trip.

### B. Resizing a selection — done, needs no hardware

Length was the last edit that ignored the selection, while moving, deleting and
velocity all honoured it. Two ways to change several at once, because they mean
different things:

- **Edge-drag with a selection** applies one delta to every note, so long and
  short notes stay long and short. Clamped once for the group, so the relative
  shape can't collapse at the pattern's end.
- **The Length slider** (Edit panel) makes them all equal, clamped per note so
  one cramped note doesn't hold the rest back. It runs along the LEN byte, so
  every position is a length the hardware stores.

Maths lives in `edit-ops.js` (canvas-free, unit-tested both ways); the drag is
`pianoroll.js`, the slider is `main.js`. Verified in the running app: a chord
of 3 / 2.75 / 3 dragged to 5 / 4.75 / 5, the slider flattened it to 2, and a
128-step request clamped to the 8 steps of room those notes had.

### C. Swing transfers to the box — done, byte mapping verified 2026-08-04

Swing existed only in the browser: the realtime engine, .mid export and Library
saves all honoured it, but nothing under `js/elektron/` had ever heard of it, so
sending a pattern left its feel behind.

Found by diffing a **fresh project**: two untouched patterns are byte-identical,
so A01 at swing 78% against blank A02 gave a noise-free diff of one byte, and
moving A01 to 65% changed that byte from 28 to 15 and nothing else. Both format
docs had already flagged the byte as an unknown pattern setting and never
connected it to swing.

```
DT2 88764 · DN2 88812 · both = pattern nameOffset + 24
value = swing% − 50   (0 = straight, 30 = 80%)
```

`js/elektron/pattern-settings.js` holds `readSwing`/`applySwing`, composed onto
the payload exactly as `applyTrackProb` is — **no protected file was touched**.
Wired into send, import, and the console lab's import.

The interesting wrinkle: this is the first thing digi-roll writes that is **per
pattern, not per track**, so it re-times all sixteen tracks in the destination
slot. Consequences, both deliberate:

- The send confirmation names the change whenever it differs from what the box
  holds, rather than letting it be discovered on playback.
- Cross-device track copy does *not* carry it — a one-track copy has no business
  re-timing the fifteen tracks already in the target slot.

**Hardware-verified 2026-08-04**, both halves: the byte mapping by controlled
experiment (DN2 OS 1.10D), then the write by a write-back to the box, which
landed and played. The steps, for whoever repeats them on a new OS build:

8. Set a pattern's swing, send it, and check the box's own swing setting reads
   the same number. Verify byte-identical, re-import round-trips, and confirm
   the other tracks in that slot are re-timed too — swing reaching past the
   track being written is the part that is new in kind.

Not verified on a **DT2**: the byte sits at the sibling offset and the fixtures
corroborate it, but no swing has been written to one.

## P-lock audition round — built 2026-08-04

Neil's idea, and it changed the shape of the feature: **each curated parameter has
a MIDI CC/NRPN number, so a lane can be *heard* before it can be *stored*.** The
charts are public (DT2 Appendix B, DN2 Appendix C — extracted from the manual
PDFs, and independently matching midi.guide's DT2 table value for value), which
means the audition half needs no reverse engineering at all.

The design consequence is the whole of this round: a parameter now carries **two
independent mappings**, and separating them is what unblocks everything.

```
midi   { cc, ccLsb, nrpn }        published → known now
plock  { id, toStored, fromStored }  hardware → null on every entry
```

A parameter with `midi` and no `plock` can be drawn and auditioned but not
written. So lanes are identified by **canonical name** when digi-roll authors
them and by raw `paramId` when they come off a box, values live on the
parameter's **display axis** rather than the lane's uint16, and the byte
conversion happens only at the roll↔device seam where a missing measurement can
be refused out loud instead of guessed.

What that buys, working today: add a `FLTR CUTOFF` lane, draw a sweep, hit Play,
and the box sweeps. Sent over NRPN on the pattern's channel, 2 ms ahead of the
step's note-ons, suppressed when a trig is silenced by probability. Trying to
*send* that lane into a pattern is refused with a warning that says both halves:
"digi-roll can play that parameter over MIDI but hasn't yet measured which p-lock
slot the pattern format stores it in."

The eleven, chosen because they exist on both boxes: filter cutoff, resonance,
filter env depth, pan, overdrive, delay/reverb/chorus send, LFO 1–3 depth. The
full CC/NRPN table with its traps and manual typos is in
`docs/dt2-pattern-format.md`. **Retrig is deferred** — no CC, no NRPN, and not
one knob (RATE/LEN/VEL/on-off), so nothing to audition and no reason to assume a
single lane; it joins the list once a capture shows its shape.

Decisions taken with Neil: NRPN over CC (reaches the DN2's LFO 3, which has no CC
at all; carries 14 bits; numbering mostly shared between boxes where the CCs
emphatically are not — pan is CC 90 on a DT2 and CC 89 on a DN2, where 89 is
Volume). Retrig deferred. Auditioning moves the box's real parameters and nothing
puts them back: accepted, and said plainly in the panel, on Play, and in the help
page, rather than hidden behind a toggle.

Two UI changes came out of driving it:

- The lane **sets on press**, click-to-set and drag-to-draw, like any automation
  lane. It first copied the trig lane's 3 px drag threshold, which exists there to
  tell a click (open the COND picker, cycle FILL) from a drag — the p-lock lane has
  no click action, so the threshold bought nothing and created a dead zone that
  swallowed small adjustments near the press point.
- The add-lane picker shows **one box**, not both. Offering 22 parameters when only
  one box is in play is an invitation to pick the wrong one, and the two boxes even
  label the same knob differently (`FLTR CUTOFF` vs `FLTR FREQ`). Resolved in
  order: the pattern's own provenance, then the connected box's identity once a
  handshake has happened, then the **MIDI port name** (`slugFromPortName` in
  `device.js` — longest name first, so "Elektron Digitakt II" isn't claimed by the
  gen-1 "Digitakt" entry it starts with), then both as a fallback with a hint
  saying to pick a box. Re-filled on every panel sync, so it tracks the slot you
  switch to and the output you choose.

### The first real lane, and what it says

A p-lock made on a DN2 and imported through digi-roll — the first allocated lane
in any capture this project holds. Full log in `docs/dn2-pattern-format.md`:

```
paramId 74 (0x4A), track 0, step 1 = 16169 (0x3F29), every other step FFFF
```

Three findings. The `FFFF`-means-no-value guess the write path was making is now
**confirmed** rather than inferred. A lane value uses far more than 7 bits, so it
is *not* the CC-scale number — `0x3F29` sits just under the 14-bit ceiling of
16383, which is exactly what NRPN carries. And paramId 74 is not any of the
eleven's NRPN LSBs, but it *is* an NRPN LSB in the DN2 appendix — SYN page 1,
data entry knob B — so the hypothesis below survives and even predicts what was
locked.

## P-lock lanes — the byte layer, Phases 1–3 built 2026-08-04

The foundation the audition round above sits on: the 80-lane pool, read and
written — and as of the end of the day, **written to real hardware and
verified**.

**Phase 0 ran 2026-08-04 — both boxes, all questions answered.** See the
section below for the results; the param tables are filled in and 441 tests
are green. **The Phase 3 write smoke test ran the same day, on both boxes:**
lanes drawn in digi-roll, sent, verified byte-identical, and the box UI showed
the right values with playback behaving. Not yet exercised on hardware:
freeing an existing lane *through a digi-roll write* (the free form itself is
hardware-corroborated — Phase 0 watched the box free a lane and the write path
emits identical bytes), and cross-device lane translation.

- **Built and unit-tested (432 tests green):** reading a pattern's lanes, carrying
  them through import → edit → write-back → cross-device copy → Library save
  byte-exact, the write path with its scrub/reallocate policy and lane budget, the
  stacked lane UI under the grid, and the difflab **p-lock lane report** that turns
  a capture pair into "lane 0 allocated: paramId 0x2a, track 3, step 1 = 0x2000".
- **Measured 2026-08-04 (was: blocked on hardware):** which parameter each
  paramId *is*, and what its uint16 values scale to — the Phase 0 results
  below. The `plock` half of all 22 table entries is filled in from the
  captures; the fixture-backed tests read the numbers back off the real dumps.
- **Consequence today:** a curated lane — digi-roll-authored *or* imported off
  a box, now that paramIds resolve — is editable, audible and sendable. A lane
  whose paramId is still not one of the measured eleven keeps the old
  behaviour: listed, drawn grey, read-only, preserved byte-exact, never
  translated.

Against the plan below: Phase 1 (decode + docs) complete; Phase 2 (model + lane
UI) complete; Phase 3 (write path) complete and composed after `encodeTrackNotes`
with a minimal-diff property test on both boxes — **no protected file was
touched**. Only Phase 0 is outstanding, and it is hardware work.

Three findings worth keeping:

- **Both format docs were wrong about the free-lane form.** They said `FFFF`
  marked an unused value word. Measured across every committed fixture — all 128
  DT2 patterns and every DN2 dump — a free lane is `FF FF` followed by **256 zero
  bytes**: exactly 160 `FF`s and 20 480 zeros in the region, no exceptions. That
  is what `applyTrackPLocks` writes when it frees a lane, and both docs are now
  corrected with the evidence.
- **The per-step `FFFF` sentinel is confirmed**, no longer inferred. It was the one
  guess the write path was making, and the first real lane (see the audition round
  above) holds `FFFF` on all 127 of its unlocked steps.
- **Sending a pattern now replaces the destination track's lanes**, freeing any
  the roll doesn't have — the same bargain `applyTrackTrigSettings` has always
  struck with the PROB/FILL/COND lanes. Before this round, p-locks survived a send
  by accident of the layout. The send confirmation names it whenever the
  destination has lanes, and a caller with nothing to say about p-locks passes
  `plocks: null` and leaves the pool untouched.

Phase 0 ran and the tables are filled (see below); the Phase 3 write smoke
test passed on both boxes the same day. Trigless locks stay out of v1: a lane
the box filled on a step with no trig comes in flagged and is held read-only
rather than edited into something that isn't what the box has.

Scope decisions settled with Neil 2026-08-03, all honoured as built:

- **Curated params + raw passthrough.** Reverse-engineer a curated musical set
  properly (candidate list: filter cutoff/resonance, tune, pan, volume, decay —
  final list from the experiments) with names, ranges and scaling per device.
  Any *other* lane found in an imported pattern is preserved byte-exact and
  shown read-only — nothing is destroyed on round-trip.
- **Note trigs only in v1.** No trigless locks (they likely need a trig-type
  bit in the hardware-verified step words); imported patterns containing them
  still round-trip byte-exact. Follow-up feature.
- **Stackable lanes.** An "add lane" picker; each param gets its own bar-graph
  row (taller than the 18 px trig rows) with vertical-set / horizontal-paint
  editing, stacked under the trig lane, collapsible.

Conditions paid off in two ways this work inherits: `js/triglane.js` is the UI
skeleton (step-aligned hit-testing, drag-painting, selection-aware edits via
`targetSteps`), and `js/elektron/trig-cond.js` is the write discipline (pure
read/apply over a payload, composed *after* `encodeTrackNotes`, minimal-diff
property test).

The lane **layout** is documented and now exercised: 80 lanes × 258 bytes at
`pLocksIndex` — `paramId` u8, `track` u8, then a uint16be per step, a free lane
being `FF FF` + 256 zeros (see the p-lock sections of both format docs; spec
fields `numPLocks`/`pLockSize` in both device specs). What's genuinely unknown,
and is the real work:

1. the **paramId numbering** on each box (they differ),
2. **value scaling** per param (what the u16 means),
3. **allocation/free semantics** — which lane a new lock claims, and what the
   box writes when the last lock of a param is removed (paramId back to `FF`?
   lanes compacted?).

### Phase 0 — **ran 2026-08-04, complete on both boxes**

Eleven captures (six DT2, five DN2), Neil on the knobs and the difflab p-lock
lane report reading every diff. Logs in both format docs ([V3] in the DT2's,
[V5] in the DN2's); fixtures in `dumps/fixtures/`; the `plock` halves of both
param tables are filled in and pinned by fixture-backed tests.

What the captures settled, against the questions below:

1. **paramId numbering, both boxes.** NOT the NRPN LSB — experiment 0's
   hypothesis died in the first capture (cutoff: NRPN LSB 20, paramId 44). It
   is each box's internal page-ordered parameter index, and it differs per box
   with a real collision: **74 = overdrive on the DT2, filter frequency on the
   DN2**, so translation stays by canonical name. DT2: cutoff/reso/envDepth
   44/45/46, cho/del/rev/pan 62–65, overdrive 74. DN2: the same blocks at
   74/75/76 and 92–95, overdrive 104. LFO1/2/3 depth are 29/30/31 on *both*.
2. **Value scaling: one law everywhere.** stored = (display − min) / range ×
   32768 — a 15-bit axis, not the 14-bit NRPN value. On digi-roll's MIDI 0–127
   display axis that is exactly ×256 for every curated parameter, so all 22
   entries are `scaledPlock(id, 256)`. The box keeps sub-MIDI fine resolution
   in the low bits (a knob nudge leaves +1/256 residues); re-sending an
   imported lock quantises it to the nearest MIDI step — accepted, and the DN2
   mystery lane is now identified as FLTR FREQ ≈ 63.16.
3. **Allocation/free semantics: exactly what `applyTrackPLocks` guessed.**
   Lowest free lane claimed including mid-pool holes; freeing is in-place to
   the `FF FF` + 256-zeros form with **no compaction** — byte-for-byte what the
   write path already emits. The lane key is (paramId, track), confirmed by the
   same paramId allocated once per track. A lock inside a chord is **one value
   per step**, and a new lock joins its parameter's existing lane.

The original experiment plan, kept for reference:

DT2 first (its per-step sound p-lock at track `+1024` is the worked example),
then repeat on the DN2. Throwaway project; commit every dump to
`dumps/fixtures/` with the established naming. For each capture, diff against
the previous dump in the difflab and log findings in the format docs with the
usual [V]/[F]/[S] markings.

The difflab now does the reading for you: tick **p-lock lane report** and each
capture pair prints which lane was allocated or freed, its paramId and track, and
every per-step value word that moved, in hex and decimal. It saves into the
notebook and exports to Markdown with the byte ranges, so a capture becomes a
docs entry without hand-decoding 20 640 bytes. A capture where the pool didn't
change says so explicitly — itself a finding, and the one the trig-condition
experiments recorded.

**Do experiment 0 first — it may collapse most of the rest.**

> **Hypothesis: `paramId` == the parameter's NRPN LSB, and the lane's uint16 is
> the 14-bit value NRPN carries.**
>
> Why it's plausible: the two boxes use wildly different CC numbers for the same
> knob but *largely the same NRPN numbers* (cutoff 1/20 on both, all three sends
> identical, all three LFO depths identical), which is what an internal parameter
> index looks like rather than a MIDI assignment. The one real lane we have holds
> `0x3F29` — just under the 14-bit ceiling — so the value side fits too, and its
> paramId 74 is a valid DN2 NRPN LSB (SYN page 1 knob B).
>
> The capture: p-lock **filter frequency** on one trig, set to a known value, and
> dump. Then check (a) does the lane's paramId read **20**, and (b) is its uint16
> the 14-bit number NRPN would send for that display value? Sweep the same
> parameter to min / centre / max on three trigs to get the scaling in one go.
>
> If both hold, both parameter tables come off the manual and steps 3–4 below
> collapse to a handful of confirmations. If the paramId doesn't match, it needs
> enumerating by hand, one parameter per capture — which is what steps 3–4 are.
> Either way this is one dump, and it decides how much work the rest is.

1. Baseline: one track, a few plain trigs, dump.
2. P-lock **one** curated param on one trig → which lane allocates, what
   paramId, what value word.
3. Sweep the curated list one param at a time → the paramId table per box.
4. Scaling: lock known min / center / max values from the box UI (e.g. tune
   −24/0/+24, cutoff 0/64/127) → u16 ↔ display mapping per param.
5. Two params on one track, then a param on a *second* track → lane ordering
   and the (paramId, track) key.
6. Remove all locks of one param on the box → the free/compact behavior the
   write path must imitate.
7. Confirm one value per step (lock inside a chord — per-step, not per note
   slot, expected).
8. Observe only, for the follow-up: a trigless lock → what changes in the step
   words.

### Phase 1 — decode + docs — done 2026-08-04

- `js/elektron/plocks.js`: pure `readLane` / `readAllPLocks` /
  `readTrackPLocks(spec, payload, trackIdx)` → lanes as
  `{ lane, paramId, track, values }`, values being the stored uint16 or `null`.
  **pattern-core untouched** — the lane-level enrichment for diffs lives in the
  difflab layer (`plockReport`), as planned.
- Param tables `js/elektron/dt2/params.js` / `dn2/params.js`, plus the shared
  descriptor layer `js/elektron/params.js` and `param-tables.js` as the registry.
  A descriptor carries a canonical name, labels, and the **two independent
  mappings** the audition round introduced: `midi` (CC/NRPN, filled in from the
  manuals) and `plock` (paramId + uint16 scaling, **null on all 22 entries** —
  Phase 0's output, with `plainPlock`/`scaledPlock` ready for whichever shape the
  measurements turn out to need). A test asserts every `plock` is still null, so
  filling one in is a deliberate, visible act.
- Format docs get the layout, the measured free-lane form, the published CC/NRPN
  table with its traps, the first real lane's bytes, and an explicit list of what
  remains unknown. The paramId numbering itself awaits Phase 0.
- Tests: fixture-backed lane reads over both boxes, including that all 128 DT2
  patterns and every DN2 fixture hold no allocated lane.

### Phase 2 — model + lane UI — done 2026-08-04

- State: `pattern.plocks`, lanes as `{ name, paramId, deviceKind, values,
  trigless }`. Identity is the canonical **name** when digi-roll authored the lane
  and the raw **paramId** when it came off a box — one of the two is always set,
  both once Phase 0 lands. Values live on the parameter's **display axis** (MIDI
  0–127), not the lane's uint16, which is what lets a lane be drawn and heard
  before any scaling is known; the byte conversion happens only at the roll↔device
  seam, and is the identity for an unidentifiable lane so it still round-trips
  byte-exact. `deviceKind` is what stops a DT2 lane being read as a DN2 one. Bank
  serialize/deserialize ride along, no schema bump, stored step-keyed
  (`{"3": 96}`) so a nearly-empty 128-step lane doesn't bloat a save.
- Import via roll-bridge in both the main page and the console lab. The v1
  "locks ride on trigs" rule is enforced on the way *out* (`pruneLanesToTrigs`,
  on editable lanes only — pruning a read-only lane would change bytes we
  promised not to touch), and a lane the box filled on a trigless step comes in
  flagged `trigless` and is held read-only.
- `js/plocklane.js` in the triglane idiom: bar rows under the trig lane, click to
  set and drag to draw, absolute (the pointer sits on the bar's top edge — there's
  a test for drag and draw agreeing on the geometry), sideways paint,
  alt/right-click clears, selection-aware, snapped to the parameter's own
  resolution. Unidentifiable and trigless lanes render grey and refuse edits with a
  status line saying why. The strip disappears entirely when a pattern has no
  lanes. The add-lane picker shows one box's parameters, resolved from provenance /
  identity / port name (see the audition round above).
- The browser does not *synthesize* p-locked parameters — but as of the audition
  round it does **send them to the box** as live parameter changes, so they can be
  heard. The help page says what that costs (the track's real parameters move and
  stay moved).

### Phase 3 — write path — done 2026-08-04, **hardware-verified the same day**

- `applyTrackPLocks` in `plocks.js`, composed after `encodeTrackNotes` in
  `safe-write.js`, `copy-track.js` and the labs console. Policy: rewrite a lane
  **where it already sits** (lane order on the box is unknown, so the smallest
  diff is the safest guess), free lanes the track no longer wants to the measured
  `FF FF` + zeros form, give new parameters the lowest free lane *after* the
  frees, never read or move another track's lanes, and don't allocate a lane with
  no values in it. `plocks: null` leaves the pool entirely alone, for a caller
  that doesn't model p-locks.
- Cross-device copy translates by canonical name through both descriptors'
  scaling; untranslatable lanes are dropped with a warning naming them, exactly
  like the chord policy. Same-box copies short-circuit and carry lanes unchanged.
- The 80-lane budget is reported as a warning on an otherwise-good write, and
  `writeResultMessage` treats a warning as loud — "verified byte-identical" alone
  would read as "all of it went".
- Minimal-diff property tests on both boxes: only the pool moves, only the
  claimed lane inside it, a freed lane is byte-identical to the fixture again,
  and a second identical write changes nothing.
- **Hardware smoke test — run and passed 2026-08-04, both boxes**, once Phase 0
  unblocked it: lanes drawn in digi-roll and sent; verify reported
  byte-identical; the box UI showed the right values and playback behaved.
  Kept as the recipe for a new OS build:

  9. Draw p-lock lanes for a few curated params, send, check the values on the
     box's own TRIG page, verify byte-identical, re-import and round-trip.

  The two checklist items that round left open were both verified 2026-08-04
  in a follow-up hardware session: emptying a lane via a digi-roll send
  (verify passed — matching Phase 0's finding that the box's own free form is
  byte-identical to what the write path emits), and a cross-device copy
  carrying name-translated lanes, DN2 → DT2 through the console's Copy track
  row using an in-memory source across a reconnect. DT2 → DN2 is untested but
  runs the same name-keyed path.

Out of scope for v1, explicitly: trigless locks, the DT2 per-step *sound*
p-lock lane (track `+1024`, a different structure), and previewing p-locked
params in the browser.

## Also open

- [x] **P-lock Phase 0** — ran 2026-08-04 on both boxes; see the Phase 0 section.
      Both param tables measured, docs corrected, fixtures committed.
- [x] **P-lock Phase 3 hardware smoke test** — run and passed 2026-08-04 on
      both boxes (send + box UI + byte-identical verify). Both residuals also
      verified 2026-08-04: empty-a-lane-via-send, and a cross-device copy with
      translated lanes (DN2 → DT2; the reverse runs the same path, untested).
- [x] **Console UX round** — the three gaps the residual testing surfaced, all
      closed 2026-08-04. **Not hardware-verified** (see below).

  1. **The "Write to box" row now runs `safeWriteTrack`.** It was the last
     caller still on its own inline copy of the write sequence — the original
     Phase 2 implementation — so it wrote notes and nothing else: trig
     conditions, track PROB, p-lock lanes and swing were silently dropped, and
     the same slot landed differently depending on which page you sent it from.
     Its duplicated `WRITE_ALLOWED_BUILDS` and backup-download helper are gone
     with it, so the allowlist lives in exactly one place.
  2. **Save one pattern as `.syx`.** `patternKitFile` in `safe-write.js` wraps a
     payload back into a dump message the box would accept; `patternKitBackup`
     is now a thin wrapper on it, differing only in the word in the filename
     (`-backup-` vs `-pattern-`). The import row's new **Save .syx** button
     saves whatever is currently decoded — fetched or file-loaded — which is
     also the missing first step of a cross-device copy.
  3. **The copy row names its destination, and says the source is held.** It
     reads "→ into *Digitakt II*", amber "no box connected" when there isn't
     one. The first pass at this shipped a static hint describing the `.syx`
     detour — which was the *wrong flow to document*: `copySource` is an
     in-memory snapshot and nothing clears it, so the real route between two
     boxes is **Load source → switch the device dropdown → Connect the other box
     → Copy to track**, no file at all. (That is the route the Phase 3 residual
     was hardware-verified on.) Nothing in the row said the source survives a
     reconnect, so it was unguessable. The hint is now state-dependent — no
     source / held with no box / held on the same model / held and crossing
     models — and lives in `js/labs/copy-hint.js` as a pure function so the
     wording is testable, like `writeResultMessage`. A **Save .syx** button also
     sits in the copy row now, so the file route (for a *later session*, which is
     all it's good for) doesn't send you to the import bar to borrow a button.

  One shared piece came out of the first gap: `writeImpactLines` in
  `safe-write.js`, next to `writeResultMessage`. It owns the sentences a confirm
  dialog must not leave out — lanes written and cleared, a pool with no room, a
  PROB default that isn't 100, and swing reaching all sixteen tracks — so that
  the class of bug gap 1 *was* (a write path quietly not mentioning a surface)
  can't come back one path at a time. All three callers use it: the roll's send,
  the console's write row, and cross-device copy, which as a bonus now names the
  source track's PROB default it has been carrying silently, and says out loud
  that the destination's swing is left alone.

  Covered by five tests in `test/copy-hint.test.js` (every hint state, including
  that the same-model one names the dropdown-and-Connect route) and eight in
  `test/safe-write.test.js` (the impact sentences
  including the quiet cases, and the single-pattern file round-tripping through
  `splitSysExStream`), and the save path was exercised end to end in a real
  browser against `dumps/digitakt2-project-2026-08-01T23-37-04.syx`: the
  downloaded file is one valid pattern-kit message whose payload is
  byte-identical to the fixture's. **What is not verified: no byte has been sent
  to a box.** The console write row is new code over an already-verified flow —
  the same `safeWriteTrack` the main page's hardware-verified send uses — but
  the row itself has not been run against hardware, and on a DT2 that path now
  includes the swing byte, whose write is still DN2-only (see the swing section).
  The smoke test is: send a slot with conditions, a track PROB, a p-lock lane
  and a non-straight swing from the console row, and check all four on the box.
- [x] **Diff lab: crowdsourced device mapping** — built 2026-08-04 so the
      Elektronauts community can map boxes nobody here owns (Digitone, Syntakt,
      Analog Rytm/Four, gen-1 Digitakt). The lab could already *diff* a box it
      had a family byte for; it could not onboard one, and a contributor's bytes
      could not leave their browser. Three things closed that:

  1. **Probe** (`js/labs/probe.js` + `ElektronDevice.probeDumpRequests`) — the
     sweep that found the DN2's `0x15` by hand, as a button. Two passes: every
     candidate family byte × the two pattern-shaped requests, then all five dump
     types for whatever answered. Output is a Markdown report to paste into the
     thread, and it points the capture target at what replied. Silence is
     reported as a finding rather than an error.
  2. **Generic capture** — `fetchDump(family, requestType, index)` under the old
     `fetchPatternKit`, plus editable family/type fields, so a box the code has
     never met is capturable the moment the probe finds its family byte. Struct
     annotation is keyed on *what was captured* (family + request type), not on
     the connected box, so an unmapped box gets honest raw offsets instead of the
     wrong map, and a donated DT2 pair gets the full annotation.
  3. **Capture pairs** (`js/labs/capture-pair.js`) — baseline + after + the note
     as one JSON file, the two dumps kept byte-exact including framing and
     version bytes (on an unmapped box those are evidence). Export is the thread
     attachment; **Open pair…** diffs a donation *with no box attached*, which is
     what lets us work on a format we can't reach.

  **Read-only is structural, not a promise:** `0x5n` is the opcode that stores a
  payload, so `fetchDump` and the probe refuse anything outside the request range
  `0x60`–`0x6e` and throw before sending. That is the guarantee the pitch to
  strangers rests on, and `test/device.test.js` asserts it directly.

  Tests: 7 new in `test/device.test.js` (generic fetch, raw-framing preservation,
  opcode refusal on both paths, probe attribution, probe silence), 12 in
  `test/probe.test.js` (plans, the 0x10 exclusion, report contents), 7 in
  `test/capture-pair.test.js` (byte-exact round trip incl. a real 111,616-byte
  pattern, and each malformed-donation message). Verified in a browser with no
  box: a synthetic DT2 donation imports and annotates correctly
  (`[132..132] track 1 step word, step 65 (hi byte)`), and a synthetic Syntakt
  donation (family `0x1a`, request `0x61`) falls back to raw offsets with no
  p-lock report and carries `family 0x1a · request 0x61` into the notebook.
  **Not verified: the probe against real hardware** — it needs a box, and the two
  here are already mapped, so the honest test is a contributor's first report.
  `docs/adding-a-device.md` is the walkthrough to link from the forum post.
- [ ] **Retrig as a p-lock lane** — deferred from the audition round: no CC, no
      NRPN, and not one knob (RATE/LEN/VEL/on-off), so it needs a capture to show
      its shape before it can be modelled at all.
- [ ] **Trigless locks** — out of scope for p-lock v1; a lane the box filled on a
      step with no trig is carried read-only rather than authored. Needs a
      trig-type bit in the step words, which is why it waits.
- [ ] **Pattern chaining preview** — play slots A→B→C to audition a sequence
      (pure frontend, no device risk; the last unfinished editor item)
- [ ] **Firmware stability across an OS update.** The allowlist pins exactly one
      build per box (DT2 `0070`, DN2 `0049`), so any update drops writes to
      read-only until someone re-verifies. Worth learning whether the struct
      actually moves between builds, or whether the gate can widen safely.
- [ ] **Sync-to-external-clock** (Octatrack as master) for the live-record path.
      Blocked on hardware: needs a MIDI interface on the OT's DIN out.

Out of scope: Octatrack pattern write — no pattern SysEx exists for it, so it
stays on the live-record path.
