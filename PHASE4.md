# Phase 4 handoff brief

You are implementing Phase 4 of digi-roll (see `PLAN.md` for the roadmap and
history). Phases 1–3 are complete and **hardware-verified**: the browser can
back up, read, and write patterns on both a Digitakt 2 and a Digitone 2 over
SysEx. Phase 4 composes those verified primitives into user-facing features.
It is composition and UI work — **no new protocol or byte-format research**.

## Read these before writing any code

- `PLAN.md` — roadmap, safety rules, architecture sketch
- `js/elektron/pattern-core.js` — device-neutral decode/encode
  (`decodePatternKit`, `trackNotes`, `encodeTrackNotes`, `diffPayloads`)
- `js/elektron/dt2/pattern.js`, `js/elektron/dn2/pattern.js` — per-device specs
- `js/elektron/device.js` — `ElektronDevice` (identity, fetch, backup)
- `js/labs/console.js` — the existing import/write UI; this is the **reference
  implementation of the safe write flow** (pre-write backup, firmware
  allowlist, verify-after-write). Every new write path must reuse this flow.
- `docs/dt2-pattern-format.md`, `docs/dn2-pattern-format.md` — byte layouts
- `test/` + `dumps/` — Vitest round-trip tests over real hardware fixtures

## Hard rules (violating any of these fails the task)

1. **Do not modify** the hardware-verified encode/decode internals:
   `sevenbit.js`, `protocol.js`, `pattern-core.js` decode/encode paths,
   `dt2/pattern.js`, `dn2/pattern.js`. Compose them. If a task genuinely
   seems to require changing one, **stop and report why** instead of editing.
2. Runtime stays **zero-dependency vanilla JS** (ES modules, no bundler, no
   framework). Vitest is dev-only.
3. All five safety rules in `PLAN.md` §"Safety rules" apply to every new
   write path: auto-backup before write, minimal-diff writes, firmware
   allowlist, verify-after-write with loud mismatch, throwaway projects only.
4. **No writes to hardware during development.** Develop and test against the
   committed fixtures in `dumps/` and the Vitest suite. Hardware smoke tests
   are a separate final step run by Neil. (Read-only hardware checks —
   identity, fetch — are fine if a box is connected.)
5. Every feature gets unit tests. The existing minimal-diff property test for
   `encodeTrackNotes` is the model: prove that untouched bytes stay
   byte-identical.

## In scope — three features, in this order

### 1. Full round-trip editing (import → edit in piano roll → write back)

Today import and write both exist in `console.html` but the loop has a seam:
you import into a roll slot, edit in `index.html`, then go back to the console
to write. Close the loop:

- The pattern model (`js/state.js`) gains provenance: which device, pattern
  index, and track a slot was imported from (nullable — locally drawn
  patterns have none).
- "Write back" action in the main UI: enabled only when provenance exists and
  a matching device (same product id **and** allowlisted build) is connected.
  It re-fetches the current pattern from the box, replaces only the target
  track's notes via `encodeTrackNotes`, and runs the full safe write flow
  from `console.js` (backup, write, read back, `diffPayloads`).
- Re-fetching before write is mandatory — never write back a stale payload
  captured at import time.

**Acceptance:** unit test that decodes a fixture, converts to roll notes,
converts back, re-encodes, and gets a byte-identical payload when nothing was
edited; and a minimal-diff result when one note was moved.

### 2. Pattern bank in the browser

Named local saves of piano-roll patterns. Pure frontend, no device risk.

- Save/load/rename/delete named patterns (localStorage; key prefix
  `digiroll.bank.`). Stored shape: the `state.js` note model + swing +
  provenance, versioned with a schema number for future migration.
- Export/import as a JSON file (share/backup escape hatch).
- Keep it small: a list panel in `index.html`, not a new page.

**Acceptance:** save → reload page → load reproduces the pattern exactly
(including micro-timing, swing, provenance). Import of an exported file
round-trips. Unit-test the serialize/deserialize pair.

### 3. Cross-device copy (pattern librarian)

Copy one track's notes between any two of: DT2 pattern, DN2 pattern, or two
slots/patterns on the same box. The piano-roll note model is the interchange
format — decode source → `trackNotes()` → `encodeTrackNotes()` with the
target device's spec. Do not invent a bytes-level converter.

Decisions already made (do not re-open them):

- **Chords, DN2 → DT2:** a DT2 trig holds at most 4 note slots; the DN2 has
  no such limit. If a step has more than 4 notes, keep the 4 highest-velocity
  notes (ties: keep lower pitches) and show a warning listing dropped notes.
  Never fail silently.
- Only note data crosses over (trig bits, note, velocity, length,
  micro-timing). Sounds, p-locks, and pattern settings stay untouched on the
  target — the write is a read-modify-write of one track's notes, exactly as
  in Phase 2/3.
- The UI lives in `console.html` next to import/write (source device+pattern+
  track → target device+pattern+track), reusing the safe write flow.

**Acceptance:** unit test copying a track from the DN2 fixture into the DT2
fixture payload (and vice versa): target payload differs only in the target
track's trig region + pool records, chord truncation behaves as specified.

## Out of scope — do not attempt

- **p-lock lanes** — needs new byte-format reverse engineering with the
  diffing lab and hands on the boxes.
- **Sync-to-external-clock** — needs a physical MIDI interface on the
  Octatrack's DIN out.
- Octatrack anything, firmware-version expansion of the allowlists, protocol
  changes, refactors of working Phase 1–3 code.

## Definition of done

- `npx vitest run` passes: all existing tests green (zero regressions) plus
  new tests for each feature above.
- Each feature reachable in the UI as described.
- A short report: what was built, what the tests prove, and an explicit list
  of what has **not** been verified on hardware (that's the final manual
  step, not yours).
