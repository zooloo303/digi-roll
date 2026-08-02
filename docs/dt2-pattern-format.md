# Digitakt II pattern dump format

What digi-roll knows about the inside of a DT2 **pattern-kit dump payload**
(the decoded 8-bit body of a `0x50` dump message — see
`elektron-sysex-protocol.md` for the wire framing). Decoder:
`js/elektron/dt2/pattern.js`; tests over a real dump fixture:
`test/dt2.test.js`.

Provenance key — every field below is tagged:

- **[E]** from elk-herd's `Elektron/Digitakt/{Dump,CppStructs}.elm`
  (BSD-2-Clause, © mzero), generated from Elektron's own headers — trustworthy.
- **[F]** confirmed by direct analysis of hardware dumps
  (`dumps/digitakt2-project-*.syx`, DT2 OS 1.15B, pattern struct v4, kit v4).
- **[V]** confirmed by a **controlled hardware experiment** (2026-08-01):
  on a throwaway project, four trigs on track 1 at steps 0/4/8/12 were given,
  respectively, NOTE +3, VEL 37, LEN 1/4, and a left micro-nudge; the dump
  diff (`dumps/digitakt2-verify-2026-08-01.syx`) pinned each field exactly.
- **[AR]** inferred from the Analog Rytm's publicly documented layout
  (libanalogrytm `pattern.h`, © bsp).

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
| 18948 | 8192 × 6 | **trig-record pool** (below) — where per-trig note/velocity/length/micro actually live [V] |
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
| 256 | 6 × 128 | six per-step byte arrays of **unknown purpose** — verified NOT to hold note/velocity/length/micro [V]. Almost always `FF`; two fixture trigs show a single small value in the first array (offsets 256+step), cause unknown |
| 1024 | 128 | per-step sound p-lock (sound-pool slot), `FF` = none [E] |
| 1152 | 32 | track defaults + settings [F][V]: `+0` default note (0x3C), `+1` default velocity (0x64), `+2` default length byte (0x0E = one step); `+12` uint16be **track length in steps** (0x0010) [F]; rest unmapped (`3c 64 0e 07 80 00 40 40 40 0e 0c 40 00 10 00 02 64 05 ff …`) |

## Trig-record pool (pattern offset 18948) — hardware-verified [V]

The per-trig data everyone actually wants lives here, not in the track
struct. The pool is 8192 six-byte records = 16 tracks × 128 steps × 4 note
slots, filling the space up to the p-locks exactly.

Record layout:

| byte | field |
|------|-------|
| +0 | track (0–15) |
| +1 | step (0–127) |
| +2 | note — absolute MIDI note; `FF` = track default / slot unused (NOTE +3 stored as 0x3F = 63 [V]) |
| +3 | velocity — 0–127; `FF` = track default (VEL 37 → 0x25 [V]) |
| +4 | length byte — scale below; `FF` = track default (LEN 1/4 → 0x2E = 46 [V]) |
| +5 | micro-timing — **signed byte**, ticks of 1/24 step; resting value 0, not `FF` (left nudge → 0xFE = −2 [V]) |

Behavior:

- Each trig the box creates appends **four consecutive, quad-aligned
  records** — one per note slot (chords on MIDI tracks). Velocity, length
  and micro are mirrored into all four; the note fills only the slots in
  use [V].
- Free pool space is all-`FF`. Records of **deleted trigs linger** — only
  steps whose trig bit is set in the track's step words are live [F].
- Records are appended in creation order; a surviving trig's quad can sit
  after another track's [F].
- Trigs entered with real velocities (pads / live recording) carry them at
  `+3` even when nothing was explicitly p-locked [F].

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

Import ("Import from box", console page): live trig steps (step-word bit 0)
joined with their record-pool quads — note/velocity/length with `FF`→default
fallback, micro as a signed fraction of a step, one piano-roll note per
filled note slot. Everything unknown is never interpreted — and the future
write path (read-modify-write) will only touch bytes documented here as
[E]/[V]-confirmed.
