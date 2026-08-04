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
  provenance) · `js/pianoroll.js` canvas editor, knows nothing about devices ·
  `js/edit-ops.js` paste placement and selection resize, canvas-free ·
  `js/main.js` UI wiring ·
  `js/midi.js` realtime engine
- `js/elektron/` protocol + pattern structs · `safe-write.js` the write flow ·
  `copy-track.js` cross-device copy · `pattern-settings.js` pattern-level bytes
  (swing) · `js/roll-bridge.js` roll ↔ device notes
- `js/bank.js` named saves · `js/labs/` device console + diffing lab pages
- `docs/elektron-sysex-protocol.md`, `docs/dt2-pattern-format.md`,
  `docs/dn2-pattern-format.md` — the byte-level truth, including the first
  public documentation of the DN2 pattern format
- Protocol work is ported from [elk-herd](https://github.com/mzero/elk-herd)
  (BSD-2-Clause, by mzero) — keep the attribution.

`PLAN.md` is the roadmap — what's shipped and what's next. Next up is p-lock
lanes, planned there in detail.

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
