# Digitone II pattern dump format

What digi-roll knows about the inside of a DN2 **pattern-kit dump payload**
(the decoded 8-bit body of a `0x50` dump message — see
`elektron-sysex-protocol.md` for the wire framing). As far as we know this is
the first public documentation of the DN2 pattern format — elk-herd does not
support the Digitone family at all. Decoder: `js/elektron/dn2/pattern.js`
(a spec over the shared `js/elektron/pattern-core.js`); tests over a real
dump fixture: `test/dn2.test.js`.

**How it was mapped (2026-08-01):** the dump family byte (`0x15`) was found
by probing a real DN2 with `0x60` pattern requests across candidate family
bytes; a whole-project dump was then diffed against the hardware-verified
DT2 layout (`dt2-pattern-format.md`) — the boxes are same-generation
siblings and the sequencer block turned out nearly identical — and a
populated pattern was diffed against the project's 127 blank ones to
classify every differing byte. The in-app diffing lab (`difflab.html`)
automates exactly this methodology for future experiments.

Provenance key:

- **[F]** confirmed by direct analysis of hardware dumps
  (`dumps/digitone2-project-*.syx`, DN2 OS 1.10D build 0049, pattern struct
  v3, kit v3): the field's location AND its value behaviour were observed.
- **[S]** sibling inference: the DT2 semantics at the corresponding offset,
  where the DN2 dump is consistent with them but no DN2-specific edit has
  pinned the field on its own.
- **[V]** confirmed by a **controlled hardware experiment** (2026-08-01,
  OS 1.10D build 0049): one edit per capture on a fresh throwaway project,
  each diff read with the diffing lab — the experiment log is at the end.
  The pass finished with a write smoke test (encode → send → re-read →
  byte-identical), so the write path is enabled for build 0049.
- **[V2]** confirmed by the **trig-conditions experiment** (2026-08-02, same
  OS build): the DT2's PROB/FILL/COND mapping checked against a DN2 on a
  blank A01 — log at the end of this file, fixture
  `dumps/fixtures/digitone2-A01-conditions-2026-08-02.syx`.
- **[V3]** confirmed by the **per-note chord capture** (2026-08-04, same OS
  build): chords entered on the box through its NOTE EDIT menu, one variable
  per step, read back read-only — fixture
  `dumps/digitone2-pernote-chords-2026-08-04.syx`. This is what established
  that velocity, length and micro are per note rather than per trig.
- **[V4]** confirmed by the **swing experiment** (2026-08-04, same OS build):
  in a **fresh project**, A01 set to swing 78% against an untouched A02 —
  which are otherwise byte-identical, so the diff had no noise at all — then
  the same A01 moved to 65%, changing that one byte from 28 to 15 and nothing
  else. Fixtures `dumps/dn2-fresh-A01.syx` (78), `dumps/dn2-fresh-A02.syx`
  (blank) and `dumps/dn2-swing-65.syx` (65); pinned by `test/swing.test.js`.
  The write was verified the same day by a write-back to the box, which landed
  and played — so swing is read *and* written against real DN2 hardware.

Applies to **pattern struct version 3** (what OS 1.10D emits [F]). Any other
version is refused rather than guessed at.

## The one-line summary

The DN2 pattern struct is the DT2 v3 struct with a track struct **3 bytes
larger (1187 vs 1184)**, which pushes the trig-record pool and everything
after the tracks up by 48 (= 16 tracks × 3); total struct size is identical
(89088). Step words, trig-record layout, defaults block and the pattern tail
all match the DT2 field-for-field at their shifted offsets [F]. The kit
struct is Digitone-specific (synth presets, no sample slots) and digi-roll
round-trips it untouched.

## Pattern-kit payload, top level

| offset | size | field |
|--------|------|-------|
| 0 | 89088 | pattern struct [F] |
| 89088 | 10752 | kit struct, starts with magic `BEEFBACE` [F] |

Whole payload: 99840 bytes; a project dump is 128 of these + one 512-byte
project-settings message, and **no sound-pool messages** (unlike the DT2 —
consistent with the DN2 having no sample pool) [F].

## Pattern struct

| offset | size | field |
|--------|------|-------|
| 0 | 4 | struct version, uint32be (3) [F] |
| 4 | 16 × 1187 | tracks 1–16 (track struct below) [F] |
| 18996 | 8192 × 6 | **trig-record pool** (below) — per-trig note/velocity/length/micro [F] |
| 68148 | 80 × 258 | p-locks: paramId u8, track u8, 128 × uint16be per-step values, `FF` = unused [S — all-`FF` in the fixture, layout inherited from DT2] |
| 88788 | 16 | pattern name, NUL-padded [F — blank in fixture, position implied by the +48 shift] |
| 88804 | 4 | pattern tempo, uint32be, **BPM × 120** (14400 = 120 BPM observed) [F] |
| 88808 | 2 | uint16be `0x0010` = 16 — likely master pattern length in steps [S] |
| 88810 | 6 | pattern settings: **88812 is SWING**, stored as the offset from straight (`0` = 50%, `30` = 80%), *not* the percentage the box displays [V4]. Same relative position as the DT2's 88764 (both = `nameOffset + 24`). Remaining 5 bytes unknown |
| 88816 | 1 | kit index — equals the pattern slot by default [F — differs per slot across all 128 blank patterns] |
| 88817 | 271 | unknown, zeros in fixture |

Every field sits at its DT2 offset + 48.

## Track struct (1187 bytes)

| offset | size | field |
|--------|------|-------|
| 0 | 128 × 2 | step words, uint16be per step (bits below) [F] |
| 256 | 128 | **per-step COND** (trig condition), `FF` = none [V2] |
| 384 | 128 | **per-step FILL**, `FF` = no lock, `00` = OFF, `01` = ON [V2] |
| 512 | 128 | **per-step PROB** (probability %), `FF` = no lock [V2] |
| 640 | 3 × 128 | three further per-step byte arrays, still unknown — `FF` in every capture [V2] |
| 1024 | 128 | per-step byte array, `FF`-filled (the DT2 has its sound-pool p-locks here; the DN2 has no sound pool — unmapped) [S] |
| 1152 | 35 | track defaults + settings [F]: `+0` default note, `+1` default velocity (0x64), `+2` default length byte (0x0E = one step); `+12` uint16be **track length in steps** (0x0010); `+16` **track-level PROB** as a percentage, default `0x64` = 100 [V2]; bytes `+1152..+1169` match the DT2 tail byte-for-byte, then the DN2 inserts **3 extra bytes** (`40 00 00` in blanks) around `+1173` before rejoining the DT2 tail pattern (`… 7f 00 7f 00 7f`) |

The trig-condition lanes sit at the **same track-relative offsets as the
DT2's** — the +48 pattern-level shift does not affect them, since it comes
from the track struct's tail, not its head.

## Trig-record pool (pattern offset 18996 = 4 + 16 × 1187)

Same record layout as the DT2's hardware-verified pool, same pool size
(49152 bytes), same formula for its offset. Six-byte records:

| byte | field |
|------|-------|
| +0 | track (0–15) [V] |
| +1 | step (0–127, 0-based) [V] |
| +2 | note — absolute MIDI note; stored **explicitly even on a plain trig** (a default-C trig writes `0x3C`, where the DT2 leaves `FF`); NOTE set to the box's "E5" stored `0x40` = MIDI 64, so Elektron's octave display is +1 vs the middle-C=C4 convention [V] |
| +3 | velocity — 0–127; `FF` = track default (VEL 37 → `0x25`) [V] |
| +4 | length byte — same scale as the DT2 (below); `FF` = track default (LEN 1/4 → `0x2E` = 46) [V] |
| +5 | micro-timing — **signed byte**, ticks of 1/24 step; resting value 0, one nudge = one tick (left nudge → `0xFF` = −1) [V] |

Differences from the DT2, all hardware-verified [V]:

- **One record per sounding note, not the DT2's quad-aligned four.** A plain
  trig is one record; a chord is several **consecutive records sharing
  (track, step)**, one note each (3-note chord → 3 records; a written
  4-note chord stores and plays correctly too). Decoders must accumulate
  records per (track, step), not take the last.
- **Deleting a trig blanks its records' track/step/note (and velocity) to
  `FF`** but can leave stray length/micro bytes behind (`ff ff ff ff ff 00`).
  DT2 leftovers keep their track/step intact instead. Consequences: a live
  (track, step) can never collide with stale records (accumulation is safe),
  and "record is free" must be judged by the track byte alone, not
  all-six-bytes-`FF`.
- Free pool space is all-`FF`, records append in creation order, same as DT2.
- **Velocity, length and micro are per note, not per trig** [V3]. Every record
  in a chord carries its own three values, and the box's own **NOTE EDIT**
  menu (`NOTE / TIME / LEN / VEL`, one row per note) is where they are set.
  Records sit in **entry order, not pitch order**. Captured read-only from a
  box-authored pattern on 2026-08-04 (`dumps/digitone2-pernote-chords-2026-08-04.syx`),
  one variable per step so nothing is ambiguous:

  | step | notes | velocity | length byte | micro |
  |------|-------|----------|-------------|-------|
  | 1 | 60, 63, 67 | **127 / 52 / 69** | 14, 14, 14 | 0, 0, 0 |
  | 5 | 62, 65, 69 | 40, 40, 40 | **40 / 34 / 30** (3.25 / 2.5 / 2 steps) | 0, 0, 0 |
  | 9 | 68, 64, 61 | 40, 40, 40 | 14, 14, 14 | **−14 / −9 / +2** |

## Trig conditions: PROB / FILL / COND [V2]

**Identical to the DT2 in every respect** — same three per-step lanes at the
same track-relative offsets (256 COND, 384 FILL, 512 PROB), same encodings,
same tri-state FILL, same track-level PROB at `defaults +16`, and the **same
76-value COND menu in the same order** (confirmed on the box, including that
the `:2` group carries no negations). The full value table lives in
`dt2-pattern-format.md` and is not duplicated here. The p-lock pool stayed
empty throughout, as on the DT2.

Because both boxes share one list, cross-device track copy needs no COND
translation — nothing can be dropped for lack of a target-side value.

Verified on the DN2 by predicting the bytes before capturing, then checking:
8 trigs on track 1 of a blank A01 with COND `PRE`/`!8:8`/`2:4`/`!2:4` on
trigs 1–4, PROB 45 on trig 5, FILL ON on trig 6, FILL OFF on trig 7, trig 8
left plain. Predicted `00 4b 12 13` / `2d` / `01 00` and got exactly that,
with the plain control trig all-`FF` [V2].

Lifecycle (creation scrubs the lanes, deletion clears COND but leaves FILL
and PROB) was mapped in detail on the DT2; the DN2's clear-a-lock behaviour
matches (all three go to `FF`).

## Step word bits

Identical to the DT2 [V]:

| bit | meaning |
|-----|---------|
| `0x0001` | trig enabled (the box writes `0x0381` on a live trig; deleting cleared exactly this bit, `0391` → `0390`) |
| `0x0380` | flag group set on every box-created trig; left behind on delete |
| `0x0010` | scattered on steps even in blank patterns — not trig-related, masked out (a trig on such a step read `0x0391`) |

## Length byte scale

Identical to the DT2 / Analog Rytm piecewise-linear scale
(`0` = 0.125 steps, `14` = 1, `30` = 2, `46` = 4, …, `127` = infinite):
the landmark check passed — LEN 1/4 set on the box stored exactly 46
(`0x2E`) [V] — and the default `0x0E` = one step matches [F].

## Kit struct (relative to kit start at 89088)

Digitone-specific — digi-roll only reads names and round-trips the rest.

| offset | size | field |
|--------|------|-------|
| 0 | 4 | magic `BEEFBACE` [F] |
| 4 | 4 | kit struct version, uint32be (3) [F] |
| 8 | 16 | kit name [F — "INTRO_1", "KIT 2", … in the fixture] |
| 60 | 16 × 359 | synth-preset structs per track: magic `BEEFBACE`, version u32 (2), tagMask u32, name 16 chars at `+12` [F — real preset names decode] |
| 5964 | 16 × 268 | per-track MIDI setup structs: magic `BEEFBACE`, version u32 (2), name at `+8` ("MIDI 1"…) [F] |
| 10252 | 500 | tail: repeating `81 20 00 00 00` groups then zeros; the per-track MIDI mask (which tracks are MIDI vs synth) presumably lives somewhere in the kit but is **unmapped** — digi-roll reports `midiMask 0` and labels tracks by preset name |

## What digi-roll does with all this

**Import** ("Import from box", console page): identical machinery to the
DT2 — live trig steps joined with their pool records, `FF` → track-default
fallback. Verified against real hardware 2026-08-01: a live-fetched pattern
imported with exact per-trig velocities and lengths.

**Write** ("Write to pattern", console page): same read-modify-write
contract as the DT2 — clear the track's trig bits, free its pool records,
write one record per note (consecutive per-note records for chords, **each
carrying its own velocity, length and micro** as the box does), touch
nothing else. Enabled for OS build 0049 via the console's per-device
allowlist.

Until 2026-08-04 the encoder took those three values from a step's first note
and mirrored them across the whole trig, so every chord reached the box as a
flat block at the *lowest* note's velocity, length and micro — the encoder
groups by pitch, so the bottom note won. Strum and velocity taper from the
chord tool were silently discarded, and importing a box-authored chord and
writing it back destroyed what the box had stored. Fixed in `encodeTrackNotes`;
records are written in pitch order rather than the box's entry order, which is
harmless now that each value travels with its own note.

**Swing** [V4]: read on import and written on send, as one byte in the pattern
settings tail. `js/elektron/pattern-settings.js` owns it — `readSwing` /
`applySwing`, composed onto the payload the way `applyTrackProb` is, so neither
`decodePatternKit` nor `encodeTrackNotes` needed changing. It is the one thing
digi-roll writes that is **per pattern rather than per track**, so it re-times
all sixteen tracks in the destination slot; the send confirmation spells that
out whenever it would change what the box currently holds. Cross-device track
copy deliberately does *not* carry it, since a one-track copy has no business
re-timing the fifteen tracks already in the target.

**Trig conditions**: handled by exactly the same code as the DT2 — the specs
differ only in the track size, and the lanes sit at the same track-relative
offsets. Read on import, edited in the roll's trig lane, written into the
payload `encodeTrackNotes` returns after scrubbing the track's three lanes.
Because both boxes share one COND list, a DT2 → DN2 copy (or the reverse)
carries every condition intact and never has to degrade one.

**Not yet hardware-verified** as of 2026-08-02: conditions have only been
*read* from a DN2. No pattern carrying them has been written to one.

## The [V] experiment log (2026-08-01, fresh throwaway project, OS 1.10D)

One edit per capture, diffed with the lab; every diff was surgical (only
the predicted bytes changed):

1. **Plain trig** t1 s1 → step word `0000`→`0381`; record `00 00 3c ff ff 00`
   (note stored explicitly, vel/len default, micro 0).
2. **NOTE → "E5"** on that trig → exactly one byte: note `3c`→`40` (MIDI 64).
3. **VEL 37** on a new trig s5 → velocity byte `25`; records allocate
   consecutively (#1 right after #0).
4. **LEN 1/4** on a new trig s9 → length byte `2e` (46) — scale landmark hit.
5. **Micro left ×1** on a new trig s13 → micro `00`→`ff` (−1 tick). (First
   attempt showed the nudge hadn't registered on the box — the lab's
   "no differences" answer caught it.)
6. **3-note chord** on s16 → three consecutive records, same (track, step),
   one note each. **Delete** of that chord → step word `0391`→`0390`,
   records blanked to `ff ff ff ff ff 00`.
7. **Write smoke test** to blank A02, track 1: 11 notes including mixed
   velocities/lengths, ± micro, a 3-note and a **4-note** chord →
   stored **byte-identical** on re-read, decoded back exactly, and the box
   played all chord notes. First known SysEx pattern write to a Digitone II.

Still open: re-verify on any new OS build before extending the write
allowlist (the fixture suite + this experiment list is the checklist).

## The [V2] trig-conditions log (2026-08-02, blank throwaway A01, OS 1.10D)

Abbreviated pass — the DT2 was walked exhaustively first, so this one was run
as a falsification test of "the DN2 is identical", with byte predictions
written down before each capture.

1. **Blank A01 probe**: no trigs on any track, all six per-step arrays `FF`,
   no p-lock lane allocated, and `defaults +16` already reading `64` (100).
2. **8 trigs + one setting each** (COND `PRE`, `!8:8`, `2:4`, `!2:4` on trigs
   1–4; PROB 45 on trig 5; FILL ON on 6; FILL OFF on 7; trig 8 plain) →
   predicted lane bytes `00 4b 12 13` / `01 00` / `2d` and got them exactly.
   Lanes 3–5 stayed `FF`; the pool took the DN2's usual one-record-per-note
   form; the p-lock pool stayed empty.
3. **Menu order** confirmed on the box as identical to the DT2's, including
   the `:2` group having no negations — and `!8:8` still index 75, so both
   boxes have the same 76 values in the same order.
4. **Clear probes**: removing trig 1's COND, trig 5's PROB and trig 6's FILL
   wrote `FF` in all three lanes — exactly 3 bytes changed.

End state saved as `dumps/fixtures/digitone2-A01-conditions-2026-08-02.syx`.
