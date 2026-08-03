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

Chord policy, DN2 → DT2: a DT2 trig holds 4 note slots, the DN2 is unlimited.
Fat chords keep the 4 highest-velocity notes (ties → lower pitches) and warn,
listing what was dropped. Decided and implemented.

## Next — probability / fill / trig conditions

Per-trig conditions (`COND`) are the missing half of what makes an Elektron
pattern feel alive: `50%`, `FILL`, `1ST`, `PRE`, `NEI`, the `A:B` ratios. Being
able to draw those in the browser is a bigger musical win than any p-lock.

Why this is the right next step: it's **read-modify-write on a region we already
own**, not a new subsystem. The trigs, the pool, the write flow and the verify
step all exist — this adds fields to a decode we've already proven.

Prime suspect, already documented: the six per-step byte arrays at **track
struct offset 256** (`docs/dt2-pattern-format.md`), 128 bytes each, `FF`-filled,
and hardware-verified **not** to hold note/velocity/length/micro. One byte per
step with `FF` = none is precisely the shape of the sound p-lock lane at offset
1024, so a per-step condition byte very plausibly lives in one of those six
lanes. The DN2 has the same six arrays at the same place — so one experiment
likely answers it for both boxes.

The method that cracked the DN2 sequencer block, applied here:

1. Throwaway project, `difflab.html` baseline capture
2. Set **one** trig to `50%` on the box → capture + annotated diff
3. Walk the condition list one value at a time (`FILL`, `1ST`, `PRE`, each
   `A:B`) logging every byte into the lab notebook
4. Confirm the same offsets on the DN2 before touching its encoder

Then: extend the note model in `js/state.js` with a per-note condition, show it
in the roll, and carry it through `roll-bridge.js` → `encodeTrackNotes`. Cross-
device copy needs a policy for conditions the target box doesn't have, in the
same spirit as the chord rule — degrade loudly, never silently.

Ships in stages, as ever: decode + display first (read-only, zero risk), write
only once the diff is verified field-by-field.

## After — other p-locks

p-lock lanes in the roll (filter, pitch, amp, …) as automation lanes. Bigger and
messier than conditions: it's a per-step **parameter pool** rather than a handful
of per-step bytes, the parameter numbering differs between the DT2 and the DN2,
and the roll needs a real automation-lane UI rather than one badge per trig.

Conditions first is deliberate — that work maps the per-step lane region and
sharpens the difflab workflow, both of which this then builds on. The DT2's
sound-pool p-lock at track offset 1024 is already decoded and is the worked
example of a per-step lane; the DN2 has no sound pool and leaves that region
unmapped.

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
