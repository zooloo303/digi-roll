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

**Per-trig conditions — PROB / FILL / COND** (2026-08-02). The byte mapping is
hardware-verified on both boxes; **the write path is not yet hardware-verified**
(see the smoke-test checklist below). All three turned out to be plain per-step
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

Smoke test to run on hardware before calling this done:

1. Throwaway project. Draw a pattern with a PROB lock, a FILL trig, a ratio and
   a negated ratio, and one locked chord. Send to box.
2. Box UI shows the right PROB/FILL/COND on each trig; playback behaves.
3. Re-read — the verify step should report byte-identical.
4. Import the same track back; all three fields round-trip exactly.
5. Cross-device copy DT2 ↔ DN2 with locks, then repeat checks 2–4.

Chord policy, DN2 → DT2: a DT2 trig holds 4 note slots, the DN2 is unlimited.
Fat chords keep the 4 highest-velocity notes (ties → lower pitches) and warn,
listing what was dropped. Decided and implemented.

## Next — other p-locks

p-lock lanes in the roll (filter, pitch, amp, …) as automation lanes. Bigger and
messier than conditions: it's a per-step **parameter pool** rather than a handful
of per-step bytes, the parameter numbering differs between the DT2 and the DN2,
and the roll needs a real automation-lane UI.

Conditions first was deliberate, and it paid off in two ways the p-lock work now
inherits:

- **The trig lane is the UI skeleton.** `js/triglane.js` is already a
  step-aligned editing surface with hit-testing, drag-painting across steps and
  a popover picker; automation lanes are more rows in that idiom rather than a
  new interaction model.
- **The write discipline is established.** `js/elektron/trig-cond.js` shows the
  shape: pure read/apply functions over a payload, composed *after*
  `encodeTrackNotes` instead of inside it, with a minimal-diff property test
  proving nothing else moved.

What conditions did **not** teach us is the pool itself — they turned out not to
live there, so the 80 × 258 p-lock lane region is still unexercised. Expect that
to be the real work: finding or freeing a `(paramId, track)` lane, and matching
whatever the box does when a lane empties out. The DT2's sound-pool p-lock at
track offset 1024 remains the worked example of a per-step lane; the DN2 has no
sound pool and leaves that region unmapped.

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
