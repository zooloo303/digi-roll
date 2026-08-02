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
- **[V]** confirmed by a controlled hardware experiment. **None yet for the
  DN2** — the section at the end lists the experiments still owed. The write
  path stays disabled until they pass.

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
| 88810 | 6 | unknown pattern settings (byte 88812 is 5 in the box-edited pattern, 0 in blanks — mirrors DT2's byte 88764 exactly) [F] |
| 88816 | 1 | kit index — equals the pattern slot by default [F — differs per slot across all 128 blank patterns] |
| 88817 | 271 | unknown, zeros in fixture |

Every field sits at its DT2 offset + 48.

## Track struct (1187 bytes)

| offset | size | field |
|--------|------|-------|
| 0 | 128 × 2 | step words, uint16be per step (bits below) [F] |
| 256 | 6 × 128 | six per-step byte arrays of unknown purpose, `FF`-filled — never interpreted (on the DT2 these are hardware-verified NOT to hold note data) [S] |
| 1024 | 128 | per-step byte array, `FF`-filled (the DT2 has its sound-pool p-locks here; the DN2 has no sound pool — unmapped) [S] |
| 1152 | 35 | track defaults + settings [F]: `+0` default note, `+1` default velocity (0x64), `+2` default length byte (0x0E = one step); `+12` uint16be **track length in steps** (0x0010); bytes `+1152..+1169` match the DT2 tail byte-for-byte, then the DN2 inserts **3 extra bytes** (`40 00 00` in blanks) around `+1173` before rejoining the DT2 tail pattern (`… 7f 00 7f 00 7f`) |

## Trig-record pool (pattern offset 18996 = 4 + 16 × 1187)

Same record layout as the DT2's hardware-verified pool, same pool size
(49152 bytes), same formula for its offset. Six-byte records:

| byte | field |
|------|-------|
| +0 | track (0–15) [F] |
| +1 | step (0–127) [F] |
| +2 | note — absolute MIDI note (observed values matched the imported pitches) [F] |
| +3 | velocity — 0–127; `FF` = track default (observed 105/96/113 alongside `FF`s) [F] |
| +4 | length byte — same scale as DT2 assumed (below); `FF` = track default [F location, S scale] |
| +5 | micro-timing — signed byte, ticks of 1/24 step on the DT2; resting value 0 observed [F location, S scale] |

Differences from the DT2 observed so far [F]:

- **One record per trig, not the DT2's quad-aligned four.** Seven live trigs
  in the fixture pattern → exactly seven consecutive records. How the DN2
  stores chords (several notes on one trig) is unknown — see experiments
  below. Until then digi-roll treats DN2 trigs as single-note.
- Deleted-trig residue looks different: the fixture pool has records with
  track and step **both `FF`** but leftover length/micro values, where DT2
  leftovers keep their track/step. Either way, only steps whose trig bit is
  set in the track's step words are live — residue is ignored.
- Free pool space is all-`FF`, records append in creation order, same as DT2.

## Step word bits

Identical to the DT2 [F]:

| bit | meaning |
|-----|---------|
| `0x0001` | trig enabled (the box writes `0x0381` on a live trig) |
| `0x0380` | flag group set on every box-created trig; left behind on delete (`0x0380` words with bit 0 clear appear in the fixture) |
| `0x0010` | scattered on steps even in blank patterns — not trig-related, masked out |

## Length byte scale

Assumed identical to the DT2 / Analog Rytm piecewise-linear scale
(`0` = 0.125 steps, `14` = 1, `30` = 2, `46` = 4, …, `127` = infinite) [S].
The fixture is consistent: default `0x0E` = one step, and the one explicit
length byte (49 → 4.75 steps) round-trips plausibly. Needs a [V] landmark
check (set LEN 1/4 on the box, expect 46).

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

**Write**: `encodeTrackNotes` exists (shared core, DN2 spec) and round-trips
in tests, but the console keeps the DN2 **read-only** — no write is sent
until the [V] experiments below pass on a throwaway project (PLAN.md safety
rule 3).

## Controlled experiments still owed ([V] pass)

Run these with the diffing lab (`difflab.html`) on a throwaway DN2 project,
one edit per capture:

1. **NOTE**: set a trig's note to a known value → pins the note byte and
   confirms absolute-MIDI encoding.
2. **VEL / LEN landmarks**: VEL 37 → `0x25`; LEN 1/4 → length byte 46.
3. **Micro-nudge**: one left nudge → `0xFE` at record byte +5.
4. **Chord**: put several notes on one trig (if the DN2 allows it) → how do
   extra note slots appear in the pool?
5. **Write smoke test**: after 1–4 pass, `encodeTrackNotes` → send → re-read
   → byte-compare, then flip the console's DN2 write gate with an OS-build
   allowlist (`0049`).
6. **Firmware drift**: re-run the fixture assertions after any OS update
   before allowing writes on the new build.
