# digi-roll — working notes for Claude

A browser piano roll that writes patterns straight into Digitakt II / Digitone II
pattern slots over SysEx. No build step. See `README.md` for what it does and how
to run it; this file is the set of constraints that don't change between sessions.

## Non-negotiables

**Runtime stays zero-dependency vanilla JS** — ES modules, no bundler, no
framework, no npm package reaching the browser. Vitest is dev-only.

**Do not modify the hardware-verified encode/decode internals:**

- `js/elektron/sevenbit.js`, `js/elektron/protocol.js`
- the decode/encode paths in `js/elektron/pattern-core.js`
- `js/elektron/dt2/pattern.js`, `js/elektron/dn2/pattern.js`

These were mapped byte-by-byte against real hardware and every byte layout in
`docs/` is derived from them. Compose them instead. If a task genuinely seems to
require changing one, **stop and explain why** rather than editing.

## Safety rules for any write path

Non-negotiable, enforced in code. `js/elektron/safe-write.js` implements all
five as one function so a caller can't skip one — new write paths go through it
rather than reimplementing the sequence.

1. **Auto-backup** the target before writing (offered as a `.syx` download); no
   backup, no write.
2. **Minimal diff** — only touch bytes the decoder understands; everything else
   round-trips byte-identical.
3. **Firmware allowlist** — unknown OS build ⇒ read-only. Current allowlist is
   in `safe-write.js`: DT2 build `0070` (OS 1.15B), DN2 build `0049` (OS 1.10D),
   both hardware-verified 2026-08-01.
4. **Verify after write** — read back, byte-compare, report mismatches loudly.
5. **Throwaway projects only** — never a live set.

Always re-fetch the target pattern immediately before encoding. Never write back
a payload captured earlier: it would silently revert anything changed on the box
since.

## Hardware is not part of the dev loop

**Don't write to a connected box while developing.** Work against the committed
fixtures in `dumps/` and the Vitest suite; Neil runs hardware smoke tests as a
separate manual step. Read-only checks against a box (identity, fetch) are fine.

When reporting finished work, say explicitly what has **not** been verified on
hardware.

## Tests

`npx vitest run` — must stay green (`test/`, fixtures from `dumps/`). Every
feature gets unit tests. The model to copy is the minimal-diff property test for
`encodeTrackNotes`: prove the untouched bytes stay byte-identical.

## Orientation

- `js/state.js` pattern model (notes + micro-timing + swing + track PROB +
  p-lock lanes + provenance) · `js/pianoroll.js` canvas editor, knows nothing
  about devices · `js/edit-ops.js` paste placement and selection resize,
  canvas-free · `js/main.js` UI wiring · `js/midi.js` realtime engine
- `js/elektron/` protocol + pattern structs · `safe-write.js` the write flow ·
  `copy-track.js` cross-device copy · `pattern-settings.js` pattern-level bytes
  (swing) · `plocks.js` the p-lock lane pool · `params.js` + `param-tables.js` +
  `dt2|dn2/params.js` the curated p-lock parameter tables ·
  `js/roll-bridge.js` roll ↔ device notes and lanes
- `js/plocklane.js` the p-lock automation strip · `js/triglane.js` the trig strip
- `js/bank.js` named saves · `js/labs/` device console + diffing lab pages
- `docs/elektron-sysex-protocol.md`, `docs/dt2-pattern-format.md`,
  `docs/dn2-pattern-format.md` — the byte-level truth, including the first
  public documentation of the DN2 pattern format
- Protocol work is ported from [elk-herd](https://github.com/mzero/elk-herd)
  (BSD-2-Clause, by mzero) — keep the attribution.

`PLAN.md` is the roadmap — what's shipped and what's next.

**P-lock lanes: a parameter has two independent mappings, and the split is the
whole design** (built 2026-08-04; Phase 0 measured the same day; **write path
hardware-verified the same day on both boxes** — lanes drawn in digi-roll,
sent, byte-identical verify, right values on the box UI. Not yet exercised on
hardware: emptying an existing lane via a send, and cross-device lane
translation).

- `midi` — CC and NRPN numbers, from the boxes' own published charts (DT2
  Appendix B, DN2 Appendix C). This is what lets a lane be *heard*.
- `plock` — the `paramId` byte and its uint16 scaling, **measured 2026-08-04**
  by the Phase 0 captures (logs in both format docs, fixtures in
  `dumps/fixtures/`). All 22 entries are `scaledPlock(id, 256)`: the stored
  word is the MIDI display value × 256, one law on both boxes.

Facts the captures fixed, worth not re-deriving: paramId is each box's internal
page-ordered index, **not** the NRPN LSB and **not shared between boxes** — 74
is overdrive on a DT2 and filter frequency on a DN2, so lanes translate by
canonical name only. The box frees a lane in place (`FF FF` + 256 zeros, no
compaction), claims the lowest free lane including holes, keys lanes by
(paramId, track), and stores one value per step even under a chord — all
matching what `applyTrackPLocks` already did. The old "first real lane"
mystery (DN2 paramId 74 = 16169) is identified: FLTR FREQ ≈ 63.16 — the box
keeps sub-MIDI fine resolution in the low byte, which digi-roll's integer
display axis quantises if such a lane is re-sent.

Layers: `js/elektron/plocks.js` the byte-level 80-lane pool · `params.js` the
descriptor + scaling · `dt2|dn2/params.js` the eleven curated parameters ·
`roll-bridge.js` the seam (display axis ↔ uint16, and the audition messages) ·
`js/plocklane.js` the strip. A lane is keyed by canonical **name** when digi-roll
authored it and by raw **paramId** when it came off a box; values live on the
parameter's **display axis** rather than the lane's uint16, so a lane works before
any scaling is known (MIDI 0–127 for a curated parameter; for a lane whose
parameter we can't identify the axis *is* the raw word, via an identity mapping,
which is what keeps it byte-exact on the way back out).

(The "leading hypothesis" this paragraph used to carry — paramId == NRPN LSB —
was tested by Phase 0's first capture and is **wrong**; the facts above
replaced it.)

Auditioning sends real parameter changes and nothing puts them back — accepted
deliberately, and said in the panel, on Play and in the help page.

Two things to know before touching it:

- **Sending replaces the destination track's lanes**, freeing any the roll
  doesn't carry — the same bargain `applyTrackTrigSettings` already strikes with
  the condition lanes. `plocks: null` means "I have no opinion", `[]` means "this
  track has no lanes". The send confirmation names the change.
- Both format docs used to claim `FFFF` marked an unused lane value. The
  fixtures say a free lane is `FF FF` + **256 zero bytes** (160 FFs and 20,480
  zeros across the region, every pattern, both boxes); the docs are corrected and
  `applyTrackPLocks` writes what was measured. The per-step `FFFF` sentinel
  *inside* an allocated lane is still an inference, flagged as such in the code.

Per-trig conditions shipped 2026-08-02: `js/elektron/conditions.js` is the
canonical PROB/FILL/COND table, `js/elektron/trig-cond.js` reads and writes the
three per-step lanes, and `js/triglane.js` is the step-aligned editing strip
under the roll. They are **not** p-lock pool entries — the pool is still
untouched by anything, which is the p-lock feature's actual work. Byte mapping
and write path are both hardware-verified (mapping 2026-08-02, write
2026-08-03).

The user-feedback round landed 2026-08-03 (paste at the caret + alt-drag-copy,
track-level PROB, fine note lengths), verified on hardware the same day. Two
things to know before touching them:

- **Track-level PROB is a second write surface, hardware-verified 2026-08-03.**
  `readTrackProb`/`applyTrackProb` live in `trig-cond.js` alongside the lane
  functions; the byte is `SPEC.track.trackProb`. It's the *default* an unlocked
  trig runs at, not a bulk stamp — a per-trig PROB lock overrides it, including
  an explicit 100.
- **Note lengths are fractional now.** The roll no longer rounds to whole
  steps: `snapLenFine` in `roll-bridge.js` snaps to the boxes' own LEN scale
  and is injected into the roll as `snapLen`, so `pianoroll.js` stays
  device-agnostic. Anything new that touches `n.len` has to tolerate 0.125.

**Swing transfers now, and it is the one per-pattern write surface** (mapped
2026-08-04). One byte at `nameOffset + 24` — DT2 88764, DN2 88812 — holding the
offset from straight, not the percentage: `0` = 50%, `30` = 80%. Both format
docs had it marked as an unknown pattern setting. `js/elektron/pattern-settings.js`
owns `readSwing`/`applySwing`, composed onto the payload like `applyTrackProb`,
so no protected file changed. Because it re-times **all sixteen tracks** in the
destination slot, the send confirmation names it whenever it would change what
the box holds, and cross-device track copy deliberately doesn't carry it. Byte
mapping and write path are both hardware-verified on a DN2 (mapping by
controlled experiment, write by write-back, 2026-08-04). **Never written to a
DT2** — the byte sits at the sibling offset and the fixtures corroborate it,
but that write is untested.

**Velocity, length and micro are per note, not per trig** (fixed 2026-08-04,
the one approved edit to `encodeTrackNotes` so far). They used to be read from
a step's first note and mirrored across the trig, so every chord reached the
box flattened to the *lowest* note's values — the encoder groups by pitch.
Strum and velocity taper from the chord tool were lost, and a box-authored
chord imported and written back was destroyed. A lone note still mirrors its
values across a DT2 quad, which is why the change is byte-identical for every
single-note trig. Ground truth is `dumps/digitone2-pernote-chords-2026-08-04.syx`
— chords entered on a DN2 through its own NOTE EDIT menu, one variable per
step — pinned by `test/roundtrip.test.js`. Verified per-note on DN2 hardware
(read side, 2026-08-04); **the DT2 write of a per-slot chord is not hardware-
verified**, and whether a DT2 MIDI track plays each slot's own values is still
unknown.
