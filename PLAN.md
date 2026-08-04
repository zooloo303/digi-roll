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
  The console's Phase 2 inline write button is deliberately **not** touched —
  CLAUDE.md keeps it as the untouched hardware-verified reference, and it
  already carries no per-trig conditions either.
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

**Nothing digi-roll writes is unverified any more.** Every write surface —
notes, per-trig conditions, track PROB, fine lengths — has been through
encode → send → box UI → re-read on both boxes at the allowlisted builds
(DT2 `0070`, DN2 `0049`). The next thing to break that is an OS update or the
p-lock pool.

## Next — p-lock lanes (planned 2026-08-03)

p-lock lanes in the roll (filter, pitch, amp, …) as automation lanes. Scope
decisions settled with Neil 2026-08-03:

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

The lane **layout** is already documented, not unexercised: 80 lanes × 258
bytes at `pLocksIndex` — `paramId` u8, `track` u8, then a uint16be per step,
`FF` = unused (`docs/dt2-pattern-format.md:45`, dn2 `:69`; spec fields
`numPLocks`/`pLockSize` in both device specs; the diff annotator already names
lane offsets). What's genuinely unknown, and is the real work:

1. the **paramId numbering** on each box (they differ),
2. **value scaling** per param (what the u16 means),
3. **allocation/free semantics** — which lane a new lock claims, and what the
   box writes when the last lock of a param is removed (paramId back to `FF`?
   lanes compacted?).

### Phase 0 — experiments (Neil on hardware, difflab to decode)

DT2 first (its per-step sound p-lock at track `+1024` is the worked example),
then repeat on the DN2. Throwaway project; commit every dump to
`dumps/fixtures/` with the established naming. For each capture, diff against
the previous dump in the difflab and log findings in the format docs with the
usual [V]/[F]/[S] markings.

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

### Phase 1 — decode + docs

- `js/elektron/plocks.js`: pure `readTrackPLocks(payload, spec, trackIdx)` →
  lanes as `{ paramId, values }`. No writes yet. **pattern-core stays
  untouched** — param-name enrichment for diffs goes in the difflab layer.
- Param tables `js/elektron/dt2/params.js` / `dn2/params.js`: id, canonical
  name (shared across devices for translation), display range, u16 mapping.
- Format docs get the paramId tables and experiment logs.
- Tests: fixture-backed lane reads, `conditions.test.js` idiom.

### Phase 2 — model + lane UI

- State: `pattern.plocks` — curated lanes keyed by canonical param name with
  display-scaled per-step values; unknown lanes kept raw
  (`{ deviceKind, paramId, u16 values }`) and flagged read-only. Bank
  serialize/deserialize ride-along, no schema bump.
- Import via roll-bridge; values land only on steps that have notes (v1 rule);
  a lock on a trigless step keeps its lane raw/read-only rather than lying.
- `js/plocklane.js` in the triglane idiom: add-lane picker from the device's
  curated set, bar rows, drag to set / paint across steps, alt/right-click
  clears, selection-aware, snaps to the param's device resolution. Read-only
  raw lanes render dimmed, uneditable.
- Browser preview does **not** simulate p-locked params (nothing to synthesize)
  — say so in the help page, like the condition caveats.

### Phase 3 — write path

- `applyTrackPLocks` in `plocks.js`: scrub-then-write like
  `applyTrackTrigSettings` — free this track's lanes exactly the way Phase 0
  step 6 observed, reallocate one lane per param with values, reapply raw
  read-only lanes byte-exact, leave other tracks' lanes alone. Composed after
  `encodeTrackNotes` in `safe-write.js`, `copy-track.js` and the labs console.
- Cross-device copy translates curated params by canonical name; untranslatable
  lanes are dropped with a warning listing them (chord-policy style).
- Warn when a write would exceed the 80-lane budget.
- Minimal-diff property test (`trig-write.test.js` model) proving only the
  expected lanes moved.
- Hardware smoke test: write locks for each curated param plus one raw
  passthrough lane; box UI shows the right values; verify byte-identical;
  re-import round-trips; empty a lane and confirm the free behavior matches
  the box's own; cross-device copy with translation.

Out of scope for v1, explicitly: trigless locks, the DT2 per-step *sound*
p-lock lane (track `+1024`, a different structure), and previewing p-locked
params in the browser.

## Also open

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
