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
- **[V2]** confirmed by the **trig-conditions experiment** (2026-08-02, OS
  1.15B build 0070): 16 trigs on track 1 of a blank A01, walked through PROB,
  FILL and COND with one variable per capture — the log is at the end of this
  file and the end state is the fixture
  `dumps/fixtures/digitakt2-A01-conditions-2026-08-02.syx`.
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
| 256 | 128 | **per-step COND** (trig condition), `FF` = none [V2] |
| 384 | 128 | **per-step FILL**, `FF` = no lock, `00` = OFF, `01` = ON [V2] |
| 512 | 128 | **per-step PROB** (probability %), `FF` = no lock [V2] |
| 640 | 3 × 128 | three further per-step byte arrays, still **unknown** — `FF` throughout every capture taken so far [V2] |
| 1024 | 128 | per-step sound p-lock (sound-pool slot), `FF` = none [E] |
| 1152 | 32 | track defaults + settings [F][V]: `+0` default note (0x3C), `+1` default velocity (0x64), `+2` default length byte (0x0E = one step); `+12` uint16be **track length in steps** (0x0010) [F]; `+16` **track-level PROB** as a percentage, default `0x64` = 100 [V2]; rest unmapped (`3c 64 0e 07 80 00 40 40 40 0e 0c 40 00 10 00 02 64 05 ff …`) |

The first three of the six arrays at 256 are the trig-condition lanes — see
below. This supersedes the earlier note that all six were unknown.

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
| +5 | micro-timing — **signed byte**, ticks of 1/24 step; resting value 0, not `FF` (the verification capture shows 0xFE = −2 ticks, from two left nudges — the DN2 experiment later confirmed one nudge = one tick [V]) |

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

## Trig conditions: PROB / FILL / COND (track offsets 256, 384, 512) [V2]

The three "conditional locks" on TRIG page 1 are **three independent
per-step byte lanes** in the track struct — not entries in the p-lock pool,
which stayed completely empty (`paramId FF`, no lane allocated) through every
capture of this experiment. One byte per step, 128 steps, `FF` = nothing
stored.

| lane | track offset | field | encoding |
|------|--------------|-------|----------|
| 0 | 256 | **COND** | index into the menu list below (0–75); `FF` = none |
| 1 | 384 | **FILL** | `01` = ON, `00` = OFF, `FF` = no lock — a **tri-state** |
| 2 | 512 | **PROB** | the percentage itself, `00`–`64` (0–100); `FF` = no lock |

Verified independent: setting COND on 16 trigs that already carried PROB and
FILL locks changed exactly 16 bytes, all in lane 0 [V2].

**PROB** is the only one of the three with a track-level default, at track
offset **1168** (`defaults +16`), also stored as a plain percentage (`0x64` =
100). FILL and COND have **no track-level value at all** — the box shows them
padlocked when no trig is held, meaning "per trig only".

**PROB `0x64` is a real stored value**, distinct from `FF`: dialling a trig's
PROB to 100 stores `64` rather than clearing the lock. Both behave the same
musically (always plays), but they are different bytes and digi-roll
round-trips them faithfully.

### The COND menu (76 values, in the box's own order)

The stored byte is the zero-based index. The order is: the four logic pairs
with each negation immediately after its positive, then the ratios grouped by
denominator, again with each negation interleaved. The `:2` group has **no
negations** — `!1:2` would just be `2:2`.

| | | | | | | | |
|---|---|---|---|---|---|---|---|
| 0=`PRE` | 1=`!PRE` | 2=`NEI` | 3=`!NEI` | 4=`1ST` | 5=`!1ST` | 6=`LST` | 7=`!LST` |
| 8=`1:2` | 9=`2:2` | 10=`1:3` | 11=`!1:3` | 12=`2:3` | 13=`!2:3` | 14=`3:3` | 15=`!3:3` |
| 16=`1:4` | 17=`!1:4` | 18=`2:4` | 19=`!2:4` | 20=`3:4` | 21=`!3:4` | 22=`4:4` | 23=`!4:4` |
| 24=`1:5` | 25=`!1:5` | 26=`2:5` | 27=`!2:5` | 28=`3:5` | 29=`!3:5` | 30=`4:5` | 31=`!4:5` |
| 32=`5:5` | 33=`!5:5` | 34=`1:6` | 35=`!1:6` | 36=`2:6` | 37=`!2:6` | 38=`3:6` | 39=`!3:6` |
| 40=`4:6` | 41=`!4:6` | 42=`5:6` | 43=`!5:6` | 44=`6:6` | 45=`!6:6` | 46=`1:7` | 47=`!1:7` |
| 48=`2:7` | 49=`!2:7` | 50=`3:7` | 51=`!3:7` | 52=`4:7` | 53=`!4:7` | 54=`5:7` | 55=`!5:7` |
| 56=`6:7` | 57=`!6:7` | 58=`7:7` | 59=`!7:7` | 60=`1:8` | 61=`!1:8` | 62=`2:8` | 63=`!2:8` |
| 64=`3:8` | 65=`!3:8` | 66=`4:8` | 67=`!4:8` | 68=`5:8` | 69=`!5:8` | 70=`6:8` | 71=`!6:8` |
| 72=`7:8` | 73=`!7:8` | 74=`8:8` | 75=`!8:8` | | | | |

Indices 0–15 were walked one value at a time on 16 trigs; the rest is
extrapolated from that ordering rule and **spot-checked at five anchors** —
`1:4`=16, `!2:5`=27, `6:6`=44, `4:7`=52, `!8:8`=75 — all of which matched, with
`!8:8` confirmed on the box as the final menu entry [V2]. The box prints
negations with an overline; digi-roll writes them `!X` everywhere.

The DN2 uses this same list, same order, same indices [V2] — see
`dn2-pattern-format.md`.

An independent check on all of the above: the whole-project dump captured a day
*before* this experiment (`dumps/digitakt2-project-2026-08-01T23-37-04.syx`)
contains two trigs carrying "a single small value in the first per-step array",
which this doc previously recorded as unexplained. They decode as COND `2:2` on
A01 track 3 step 7 and COND `1:2` on A01 track 11 step 8 — both on live trigs,
both plausible musical settings, and neither was known about when the dump was
taken. `test/conditions.test.js` asserts exactly this.

### Lifecycle (matters for any write path) [V2]

- **Creating a trig scrubs all three lanes for that step** to `FF`. This is
  why the box never surfaces a stale value.
- **Deleting a trig clears the trig bit and the COND byte, but leaves FILL
  and PROB behind.** Observed twice, on two different steps. So a step whose
  trig bit is clear can still carry `00`/`64`-style leftovers, and those
  bytes must not be read as live settings.
- Nothing else moves: no trig-record pool changes, and the step word only
  ever changes by its documented trig bit.

Because a write path replaces trigs without going through the box's own
trig-creation, **it has to do that scrub itself** — clear all three lanes
across all 128 steps of the track before writing the new values, or a fresh
trig inherits a dead one's probability.

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

**Import** ("Import from box", console page): live trig steps (step-word
bit 0) joined with their record-pool quads — note/velocity/length with
`FF`→default fallback, micro as a signed fraction of a step, one piano-roll
note per filled note slot.

**Write** ("Write to pattern", console page): read-modify-write. Fetch the
target pattern-kit, clear the chosen track's trig-enable bits and free its
record-pool quads, write one fresh quad per trigged step (explicit note/
velocity/length, micro rounded to ±23 ticks; chords fill extra note slots),
set `0x0381` on trigged step words — and leave every other byte, including
the whole kit, byte-identical. The result goes back as an unsolicited `0x50`
dump response (there is no "write request" in the protocol — the box just
stores what it's sent [V]) after an automatic backup, then is re-read and
byte-compared.

Hardware-verified 2026-08-01 [V]: a 7-note bassline with mixed velocities,
lengths and ± micro-timing written to A16 track 1 came back byte-identical
on re-read, and importing it reproduced every field exactly.

**Trig conditions**: read on import straight from the three lanes and stamped
onto every note of their step (`js/elektron/trig-cond.js`); edited in the roll's
trig lane; written by the same `safeWriteTrack` flow, applied to the payload
`encodeTrackNotes` returns. The write **scrubs all 128 steps of the track's
three lanes first**, mirroring what the box does when it creates a trig — the
one place digi-roll deliberately differs from the hardware is that this also
clears leftovers on dead steps of the track being written, which the box would
have kept. An explicit `0x64` PROB lock round-trips as itself; only dragging the
lane's PROB control to the top converts it to "no lock". Nothing outside those
three lanes, the track's step words and the trig-record pool is touched — the
property test in `test/trig-write.test.js` asserts exactly that.

**Not yet hardware-verified** as of 2026-08-02: conditions have only been
*read* from hardware. No pattern carrying them has been written to a box.

Everything documented as unknown is never interpreted or modified.

## The [V2] trig-conditions experiment log (2026-08-02, OS 1.15B build 0070)

Blank throwaway project, pattern A01, all read-only captures via the diffing
lab's fetch path. Every diff was surgical — only the predicted region moved.

1. **Baseline**: 16 plain trigs on track 1 steps 1–16 → 16 step words
   `0000`/`0010` → `0381`/`0391`, 16 quads in the record pool, **all six
   per-step arrays still `FF`** and **no p-lock lane allocated**.
2. **PROB p-locks** on all 16 trigs (0, 5, 10 … 75) → exactly 16 bytes, all
   in the lane at track offset **512**, each byte equal to the percentage
   (`0`→`00`, `75`→`4b`). Nothing else in the 111616-byte payload changed.
   (First attempt set only 15 — the missing trig read `FF`, which is how we
   learned `FF` and `00` are distinct.)
3. **Track-level PROB** 100 → 80, no trig held → one byte: track defaults
   `+16`, `64`→`50`. Restoring it to 100 put `64` back, as predicted.
4. **FILL ON** p-locked on trigs 1–8 → 8 bytes in the lane at offset **384**,
   all `01`. **FILL OFF** on trigs 9–16 → 8 bytes, all `00`. So FILL is a
   tri-state, not a boolean: `FF` unlocked / `00` OFF / `01` ON.
5. **COND** on trigs 1–16, the first 16 menu values in order → 16 bytes in
   the lane at offset **256**, values `00`–`0f`: the byte is the menu index.
   The PROB and FILL bytes on those same trigs did not move — the three
   fields are independent.
6. **COND anchors**: trigs 1–5 set to `1:4`, `!2:5`, `6:6`, `4:7`, `!8:8` →
   `10 1b 2c 34 4b` = 16, 27, 44, 52, 75, matching the extrapolated ordering
   exactly; `!8:8` confirmed as the last menu entry.
7. **Negative probes**, one capture: clearing a COND, a PROB and a FILL lock
   each wrote `FF`; PROB dialled to 100 wrote `64`, **not** `FF`; deleting
   trig 16 cleared its trig bit (`391`→`390`) and its COND byte but **left
   FILL `00` and PROB `4b` in place**.
8. **Re-adding a trig on step 16** scrubbed FILL and PROB back to `FF` — the
   box cleans on creation, not deletion (the box UI shows `---` accordingly).
9. **Delete re-test** on trig 15 reproduced step 7 exactly: COND cleared,
   FILL `00` and PROB `46` left behind.

End state saved as `dumps/fixtures/digitakt2-A01-conditions-2026-08-02.syx` —
15 live trigs, all three fields in varied combinations, all three "none"
cases, an explicit `0x64`, and a dead step 16 still holding leftovers.
