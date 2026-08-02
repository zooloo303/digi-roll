# digi-roll roadmap — from piano roll to Elektron pattern utility

Target devices: **Digitakt 2** and **Digitone 2**. The Octatrack keeps working
via the live-record path but is out of scope for direct pattern write (no
pattern SysEx exists for it).

The endgame: a **"Write to pattern"** button — draw notes in the browser and
they appear directly in a pattern slot on the box, exact lengths, velocities
and micro-timing, no live recording, no clock dance.

Guiding principles:

- **Every phase ships something usable on its own.** If a later phase stalls,
  the tool is still better than it was.
- **Read before write.** Each device milestone starts with the read-only
  direction (import from box), which is zero-risk and proves the decode works
  before we ever write a byte back.
- **Never write without a backup.** Auto-fetch and stash the target pattern
  (or whole project) before any write; verify-after-write by reading back.
- **The live-record path stays.** It's the fallback for anything the SysEx
  path can't do yet, and the only path for the Octatrack.

---

## Phase 0 — Editor quality of life (no new device work)

Make the piano roll genuinely nice to compose in before the plumbing work.
Each item is independent; pick by mood.

- [x] Undo/redo (in-memory edit history; Cmd+Z / Shift+Cmd+Z)
- [x] Multi-select (drag-marquee + shift-click), move/delete/velocity as a group
- [x] Copy/paste + "duplicate bar" (fastest way to build 4-bar variations)
- [x] Scale highlight: pick key/scale, tint in-scale rows (breaks/DnB basslines
      live in a scale; this speeds everything up)
- [x] Swing / per-note micro-timing (matters for the SysEx path later —
      Elektron trigs store micro-timing, so the model should carry it now)
- [x] MIDI file export/import (escape hatch + lets you pull patterns from
      elsewhere)
- [ ] Pattern chaining preview (play slots A→B→C to hear a sequence)

**Model change to do early:** note `step` gains a fractional `micro` offset,
and the pattern gains a `swing` value — so nothing downstream has to migrate.

## Phase 1 — Elektron SysEx transport (talk the protocol)

Goal: digi-roll can hold a conversation with both boxes over SysEx — the
foundation everything else stands on. elk-herd's source is the de-facto
protocol documentation (its `Drive`/`Path`/`Struct` modules); Elektron's
Transfer app uses the same protocol against both DT2 and DN2, so one
implementation should cover both.

- [x] Request `sysex: true` MIDI access; add a device console page (hex log of
      every SysEx exchange — this is the debugging window for all later work)
      → `console.html` + `js/labs/console.js`
- [x] 7-bit ↔ 8-bit payload packing/unpacking + message framing + checksums
      → `js/elektron/sevenbit.js`, `js/elektron/protocol.js`
- [x] Handshake: device identity request → know which box and OS version we're
      talking to (version gating starts here) → `js/elektron/device.js`
      (Elektron API 0x01/0x02, not the universal identity request)
- [x] Fetch a whole-project dump from the DT2 (0x6F request → dump stream).
      ✓ Verified on real hardware 2026-08-01: DT2 OS 1.15B, 16.3 MB project
      dump in 17 s, all checksums good.
      *DN2: identity handshake works (productId 43, OS 1.10D — captured, in
      `docs/elektron-sysex-protocol.md`), and its dump family byte is
      **0x15** — discovered 2026-08-01 by exactly the planned experiment
      (0x60 probes across candidate bytes; only 0x15 answered). Whole-project
      backup verified against the real DN2: 14.6 MB in 18 s.*
- [x] **Ship: "Backup project" button** — download the dump as a file. Already
      a genuinely useful utility (browser-based project backup, no Transfer
      app), and it produces the raw material for Phase 3's diffing lab.
      ✓ Working against the real DT2.

**Tooling decision:** runtime stays zero-dependency vanilla JS, but the
protocol/struct code gets **dev-only unit tests (Vitest)** — binary
encode/decode work without round-trip tests is how projects corrupt.
Fixtures = real dumps captured from the boxes, committed to the repo
(they contain no personal data beyond your patterns — keep a sanitized set).

**License note:** ~~check elk-herd's license before porting code directly~~
— checked: **BSD-2-Clause**, porting allowed with attribution. Credited in
README and `docs/elektron-sysex-protocol.md`.

## Phase 2 — Digitakt 2 pattern read/write (known territory)

The DT2 format is already reverse-engineered (elk-herd `CppStructs` /
`Dump` / `HighLevel` for Digitakt II). This phase is translation, not
research.

- [x] Decode DT2 project dump → locate patterns → parse note trigs
      (trig bits, note, velocity, length, micro-timing)
      → `js/elektron/dt2/pattern.js` + `docs/dt2-pattern-format.md`.
      *Discovered along the way: elk-herd never decodes note trigs (it's a
      librarian, not an editor), so this needed real reverse engineering.
      Per-trig note/velocity/length/micro live in a pattern-level pool of
      6-byte records (offset 18948), four note-slot records per trig —
      **hardware-verified 2026-08-01** with a controlled experiment (known
      NOTE/VEL/LEN/micro edits on a throwaway pattern, dump diffed). The
      verification capture is a second test fixture.*
- [x] **Ship: "Import from box"** — pick a DT2 pattern + track, its notes
      appear in the piano roll. Read-only, zero risk, proves the decode.
      → console page: fetch one pattern (0x60 request) or open a .syx
      backup, pick track + piano-roll slot. ✓ Verified against the real
      DT2 (fetched A01 live, 8 trigs landed in the roll).
- [x] Encode: read-modify-write — replace the note trigs on one track inside
      a fetched pattern, leave every other byte untouched, fix checksums
      → `encodeTrackNotes()` in `js/elektron/dt2/pattern.js` (clears the
      track's trig bits + record-pool quads, writes fresh quads, only
      touches hardware-verified bytes; unit-tested minimal-diff property)
- [x] Verify layer: re-read after write, byte-compare → `diffPayloads()`,
      loud mismatch report in the console page
- [x] **Ship: "Write to pattern" for DT2** — with automatic pre-write backup
      (auto-downloaded .syx + in-session "Restore backup" button) and a
      firmware-version allowlist (build 0070 / OS 1.15B; refuses politely
      on unknown OS)

Milestone test: draw a bassline → write to DT2 pattern A16 → notes play on
the box, lengths and velocities exact.
✓ Ran 2026-08-01 against the real DT2: 7-note bassline (velocities,
lengths, ± micro-timing) written to A16 T1, box stored it byte-identical,
and importing it back reproduced every field exactly. (There is no "write
pattern" request in the protocol — you send an unsolicited 0x50 dump
response and the box stores it; confirmed working.)

## Phase 3 — Digitone 2 reverse engineering (the research phase)

Nobody has published the DN2 pattern format. This phase produces it — and
the repo becomes the public documentation (good Elektronauts citizenship;
search existing threads first, someone may have partial work).

Strong tailwind: the DT2 and DN2 are sibling boxes on the same OS
generation, so the *sequencer* block of a pattern (the only part we need)
is plausibly near-identical to DT2's. First experiment is cheap: scan a DN2
dump for DT2-shaped trig structures.

- [x] **Build the diffing lab into the app**: `difflab.html` +
      `js/labs/difflab.js` — capture baseline → one edit on the box →
      capture + annotated diff (every byte named by struct region via the
      device specs), lab notebook in localStorage, Markdown export.
- [x] Map the note-trig record: trig enable bits, note, velocity, length,
      micro-timing. *Turned out to be the DT2 sequencer block with a
      1187-byte track struct (+3) and everything after the tracks shifted
      +48; mapped by diffing a real DN2 dump against the DT2 layout, then
      **[V]-verified field-by-field 2026-08-01** with the diffing lab on a
      throwaway project (experiment log in the format doc). One real
      difference: trigs store one pool record per sounding note — chords are
      consecutive records sharing (track, step), not DT2-style quads.*
- [ ] Confirm stability across a firmware update cycle (pin versions)
- [x] Publish findings as `docs/dn2-pattern-format.md`
- [x] **Import from box for DN2** — same console flow as the DT2, decoder
      generalised into `js/elektron/pattern-core.js` + per-device specs.
      ✓ Verified against the real DN2 2026-08-01 (live-fetched A01, exact
      velocities/lengths in the roll).
- [x] **Write to pattern for DN2** — ✓ smoke test passed 2026-08-01: 11
      notes (mixed vel/len, ± micro, 3- and 4-note chords) written to A02,
      stored byte-identical, box played them. First known SysEx pattern
      write to a Digitone II. Console gate: per-device build allowlist
      (DN2: 0049).

Risk & fallback: if the DN2 sequencer block turns out deeply different, the
diffing lab still works — it just takes more evenings. Worst case, DN2 stays
on the live-record path while DT2 enjoys direct write; the tool is still
excellent.

## Phase 4 — The amazing little utility

With read+write for both boxes, features compose:

- [ ] **Cross-device copy**: read a pattern's notes from the DT2, write them
      to the DN2 (or between projects/slots on one box) — pattern librarian
- [ ] Full round-trip editing: import → edit in piano roll → write back
- [ ] Pattern bank in the browser: named saves, undo history, export/share
- [ ] p-lock lanes in the roll (filter, pitch, etc. as automation lanes) —
      stretch goal, needs more struct mapping
- [ ] Sync-to-external-clock (Octatrack as master) for the live path, if the
      OT's clock can reach the computer (needs a MIDI interface on its DIN out)

---

## Architecture as it grows

```
js/
  state.js        pattern model (+ micro-timing, swing)
  pianoroll.js    canvas editor — knows nothing about devices
  midi.js         real-time engine (notes/clock) — unchanged role
  elektron/
    sevenbit.js   7↔8-bit packing (pure, heavily unit-tested)
    protocol.js   framing, handshake, request/response state machine
    device.js     identity, version gating, backup/fetch/write API
    dt2/          structs + encode/decode for Digitakt 2
    dn2/          structs + encode/decode for Digitone 2 (Phase 3 output)
  labs/
    console.js    SysEx hex console
    difflab.js    dump-diffing workbench (Phase 3)
test/             Vitest round-trip tests over committed dump fixtures
docs/             protocol notes + the DN2 format doc as it emerges
```

## Safety rules (non-negotiable, enforced in code)

1. Any write is preceded by an automatic backup of the target (stored in the
   browser + offered as download).
2. Writes only touch bytes the decoder understands; everything else is
   byte-identical round-trip.
3. Firmware allowlist — unknown OS version ⇒ read-only mode.
4. Verify-after-write, with a loud diff display if anything mismatches.
5. All research happens on throwaway projects, never your live sets.

## Suggested order of attack

1. Phase 1 through **"Backup project"** — biggest unlock per hour spent, and
   the first "whoa, the browser just talked to my Digitakt" moment.
2. Phase 2 through **"Import from box"** — motivating and risk-free.
3. A couple of Phase 0 items (undo, multi-select) as palate cleansers.
4. Phase 2 write path → **DT2 "Write to pattern"** 🎉
5. Phase 3 whenever the research itch strikes — the diffing lab makes it a
   game, not a chore.
