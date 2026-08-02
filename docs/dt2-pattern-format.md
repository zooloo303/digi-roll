# Digitakt II pattern dump format

What digi-roll knows about the inside of a DT2 **pattern-kit dump payload**
(the decoded 8-bit body of a `0x50` dump message — see
`elektron-sysex-protocol.md` for the wire framing). Decoder:
`js/elektron/dt2/pattern.js`; tests over a real dump fixture:
`test/dt2.test.js`.

Provenance key — every field below is tagged:

- **[E]** from elk-herd's `Elektron/Digitakt/{Dump,CppStructs}.elm`
  (BSD-2-Clause, © mzero), generated from Elektron's own headers — trustworthy.
- **[F]** confirmed by direct analysis of our hardware fixture
  (`dumps/digitakt2-project-2026-08-01T23-37-04.syx`, DT2 OS 1.15B,
  pattern struct v4, kit v4).
- **[AR]** inferred from the Analog Rytm's publicly documented layout
  (libanalogrytm `pattern.h`, © bsp) — Elektron reuses these shapes across
  device generations.
- **PROVISIONAL** — plausible on [AR]+[F] grounds but not yet verified with a
  controlled hardware capture. Do not write these fields until verified.

Applies to **pattern struct versions 3 and 4** (they share all pattern-level
offsets [E]; v4 is what OS 1.15B emits [F]). Struct version 0 (early DT2 OS)
has a completely different track size and is not decoded.

## Pattern-kit payload, top level

| offset | size | field |
|--------|------|-------|
| 0 | 89088 | pattern struct [E] |
| 89088 | 22528 (kit v4) / 10240 (kit v3) | kit struct, starts with magic `BEEFBACE` [E][F] |

## Pattern struct

| offset | size | field |
|--------|------|-------|
| 0 | 4 | struct version, uint32be (3 or 4) [E][F] |
| 4 | 16 × 1184 | tracks 1–16 (track struct below) [E] |
| 18948 | 49152 | unknown; NOT per-step trig data (trigs never touch it [F]); some parameter table, 6-byte records [F]. Round-trip untouched |
| 68100 | 80 × 258 | p-locks: paramId u8, track u8, 128 × uint16be per-step values, `FFFF`/paramId `FF` = unused [E][F] |
| 88740 | 16 | pattern name, NUL-padded [E][F] |
| 88756 | 4 | pattern tempo, uint32be, **BPM × 120** (14400 = 120 BPM default; 20040 = 167.0 [F]) |
| 88760 | 2 | uint16be `0x0010` = 16 — likely master pattern length in steps (matches, unconfirmed against other lengths) |
| 88762 | 6 | unknown pattern settings (byte 88764 changed 0→5 in the one edited pattern [F]) |
| 88768 | 1 | kit index — which kit this pattern uses; equals the pattern slot by default [E][F] |
| 88769 | 319 | unknown, zeros in fixture |

## Track struct (1184 bytes, track struct v2)

| offset | size | field |
|--------|------|-------|
| 0 | 128 × 2 | step words, uint16be per step (bits below) [E][F] |
| 256 | 128 | per-step **micro-timing** [F]: `FF` = on the grid, else signed 6-bit in the low bits, −23…+23 ticks of 1/24 step (live-recorded trigs showed +8, +9 [F]; format per [AR]) |
| 384 | 128 | per-step **note** — PROVISIONAL: MIDI note, `FF` = track default [AR] |
| 512 | 128 | per-step **velocity** — PROVISIONAL: 0–127, `FF` = track default [AR] |
| 640 | 128 | per-step **length byte** — PROVISIONAL: scale below, `FF` = track default [AR] |
| 768 | 128 | per-step unknown (retrig / trig condition candidates [AR]) |
| 896 | 128 | per-step unknown (ditto) |
| 1024 | 128 | per-step sound p-lock (sound-pool slot), `FF` = none [E] |
| 1152 | 32 | track defaults + settings [F]: `+0` default note (0x3C), `+1` default velocity (0x64), `+2` default length byte (0x0E = one step) — order mirrors [AR]'s tail; `+12` uint16be **track length in steps** (0x0010) [F]; rest unmapped (`3c 64 0e 07 80 00 40 40 40 0e 0c 40 00 10 00 02 64 05 ff …`) |

The note/velocity/length array *order* is the open question: the arrays exist
(6 × 128 bytes of per-step `FF`-defaulted data, exactly the [AR] family shape),
micro-timing is pinned to offset 256 by live-recorded trigs, and note/vel/len
are assigned to 384/512/640 because that mirrors both the [AR] ordering and
the track-defaults tail order. **Verification protocol** (2 minutes at the
box, on a throwaway project):

1. On a blank pattern, place trigs on steps 1–4 of track 1.
2. Give step 1 NOTE +3 semitones, step 2 VEL 37, step 3 LEN 1/4,
   step 4 micro-nudge left (negative micro).
3. Console page → Backup project (or just note what Import shows).
4. Each edited step lights up exactly one array byte: whichever array holds
   `0x3F` (63 = 60+3) is notes, `0x25` (37) is velocities, `0x2E` (46 = 1/4)
   is lengths, and step 4's byte pins the negative micro encoding.

## Step word bits

| bit | meaning |
|-----|---------|
| `0x0001` | trig enabled [E][F] |
| `0x0380` | set on every trig the box creates; exact meaning unmapped (likely trig-type/enable flags à la AR's SYN/SMP/ENV) [F] |
| `0x0010` | present on scattered steps even in blank factory patterns — not trig-related; masked out and unmapped [F] |

Deleting a trig clears bit 0 but leaves the other flag bits behind [F], so
only bit 0 may be used to detect notes.

## Length byte scale

Piecewise-linear, doubling every 16 values ([AR], default value confirmed [F]):
`0` = 0.125 steps, `14` = 1 step (the default), `30` = 2, `46` = 4, `62` = 8,
`78` = 16, `94` = 32, `110` = 64, `126` = 128, `127` = infinite. Between
landmarks each increment adds 1/16 of the current base. A step = one 16th.

## Kit struct (relative to kit start)

| offset | size | field |
|--------|------|-------|
| 0 | 4 | magic `BEEFBACE` [E][F] |
| 4 | 4 | kit struct version, uint32be [E][F] |
| 8 | 16 | kit name [E][F] |
| 60 | 16 × 1109 (kit v4) / 341 (v3) | sound structs: magic, version u32, tagMask u32, name 16 chars at `+12` [E][F] |
| 22260 (v4) / 9972 (v3) | 2 | midiMask uint16be — bit *t* set = track *t*+1 is a MIDI track [E][F] |

## What digi-roll does with all this

Import ("Import from box", console page): trig steps (bit 0) + micro +
note/vel/length with `FF`→default fallback → piano-roll notes. Fields marked
PROVISIONAL trigger a warning in the status line when they actually carry
data. Everything unknown is never interpreted — and the future write path
(read-modify-write) will only touch bytes documented here as confirmed.
