# Adding Digitone 1 support to digi-roll — plan

Written 2026-08-13. The byte map comes from the sibling project
[DNX](../../DNX) (`docs/dn1-project-format.md`), which reverse-engineered the
DN1 from 53 `.dnprj` project files. Everything marked **[measured today]** was
checked in this session against real DN1 SysEx captures in
`C:\ZZ_Code\ZZ_Personal\dn_sysex\99_HardwareTest\` — the same evidence standard
the DT2/DN2 docs hold to. Nothing here has been run on a DN1 by digi-roll.

## Status — 2026-08-14

All work happens on `feat/dn1_support` off `main`; feature branches branch
from there and merge back into it, with `main` getting the first working POC.

**Phase 1 (read-only) is code-complete and unit-tested, not yet exercised on
hardware** — no DN1 has been on this desk since this plan was written. Landed:

- `js/elektron/dn1/pattern.js` — its own decode/encode (not bound to
  `pattern-core.js`; see §2a for why), reusing only the length/micro scale,
  `bankName` and `diffPayloads`.
- Registration: `protocol.js` (`FAMILY.DIGITONE = 0x0d`), `device.js`
  (product id 20), `safe-write.js` (`DECODERS.digitone`, `PRODUCT_BY_FAMILY`,
  **no** `WRITE_ALLOWED_BUILDS` entry — writes stay refused), `difflab.js` and
  `console.js`.
- `trig-cond.js`'s four public functions now degrade to "nothing to report /
  nothing to do" for a spec missing `trigCond`/`trackProb` offsets, instead of
  throwing — the one shared-seam change §2c called for, and it needed no
  changes anywhere it's called from.
- `test/dn1.test.js` — 17 tests against five real pattern-kit fixtures (see
  below), covering decode, chord expansion, the p-lock free-lane form, the
  minimal-diff property on `encodeTrackNotes`, and `describeOffset`.
- `Test_To_Run.html` — the Phase 0/2 capture-pair checklist for whoever has
  the box next, in the same format as DNX's `Tests_To_Run.html`. Every card
  marks which steps are a physical edit on the DN1's own panel (nobody else
  can do that) versus a `difflab.html` click Claude can drive directly over
  the Chrome extension once a session is live.

**Fixture provenance.** `dumps/fixtures/digitone1-presets-*.syx` — five real
pattern-kit dumps sliced out of Elektron's own **"001 PRESETS"** demo project
(shipped with the DN1) using DNX's own LZ4 decoder, then wrapped as `0x50`
SysEx messages with digi-roll's own `protocol.js` and verified to round-trip
through digi-roll's own parser before being trusted as a test corpus. Chosen
by scanning all 128 patterns in that project for the richest trig/chord/lock
content. **Nothing from the corpus's real user projects went into this repo**
— only Elektron's own demo content, which is the one thing in
`C:\ZZ_Code\ZZ_Personal\dn_sysex\` cleared for that.

**Not started:** Phase 0 hardware captures (blocking trig conditions
specifically; everything else in Phase 1 already ships without them), and
anything in Phase 2 (writes).

## The headline

**A DN1 is not another `SPEC` for `pattern-core.js`. It is a second struct
family**, and it needs its own decoder module beside `dt2/` and `dn2/`. But it
is a *closer* sibling than it looks: the p-lock pool, the length scale, the
micro-timing scale and the dump protocol are all shared, so most of the layered
work built since Phase 4 carries over untouched.

No protected file changes. `pattern-core.js`, `protocol.js`, `sevenbit.js` and
the two existing device modules are all composed onto, never edited.

---

## 1. What was established today

### The dump protocol is the one digi-roll already speaks

**[measured today]** Parsing `Digitone_PatternKit_1x_2355.syx` and
`Digitone_Project_133msg_2231.syx` with digi-roll's own `parseSysEx`:

| Fact | Value |
|---|---|
| Dump family byte | **`0x0d`** |
| API `Device` product id | **20** (DNX `dumprequest.ts`) |
| `0x50` pattern-kit payload | **20,992 bytes** |
| `0x51` pattern | 18,432 · `0x52` kit | 2,560 |
| `0x53` sound | 302 · `0x54` project settings | 11,776 |
| Whole project (`0x6f`) | 128 × `0x50`, 4 × `0x53`, 1 × `0x54` — **ends on `0x54`** |
| Checksum / length / 8-in-7 | verify unchanged |

So `fetchDump`, `fetchPatternKit`, `fetchProjectDump`, `probeDumpRequests`,
`splitSysExStream` and `buildDumpMessage` all work on a DN1 as they stand. The
whole-project backup works the moment the family byte is registered, because
`fetchProjectDump`'s end-of-stream marker is `0x54` and a DN1 sends one.

### The `0x50` payload *is* the project image's pattern record + kit record

**[measured today]** — and this answers the question DNX's
`dn1-project-format.md` §10.8 left open. In a real dump:

```
payload[0x0000]  u32be 10        pattern record version
payload[0x4724]  "UNTITLED"      pattern name, exactly where the .dnprj has it
payload[0x4736]  u16be 15720     tempo × 120  → 131.0 BPM
payload[0x4800]  u32be 10        kit record version   (18,432 = 0x4800)
payload[0x481C]  BE EF BA CE     first kit sound object, version 5
```

18,432 + 2,560 = 20,992. **Every offset in DNX's `src/project/dn1.ts` applies
directly to a digi-roll payload.** That is the single largest saving in this
plan — the struct map is done and it is evidence-backed over 6,784 patterns.

Note the kit record has **no `BEEFBACE` magic** of its own (it opens at its
version field), which is one reason `decodePatternKit` in `pattern-core.js`
cannot be reused: it asserts that magic at `P.size`.

### What carries over unchanged

- **The p-lock pool.** 80 lanes × 130 bytes at `0x1E84`, header `(paramId,
  track)`, values `u16be`, region ending exactly on `nameOffset` — the same
  shape as DT2/DN2 at a different size. **[measured today]** across 128
  patterns: 161 lanes in use, and **all 10,079 free lanes are `FF FF` + 256
  zero bytes**, with zero half-free headers. That is the same measured free-lane
  form `plocks.js` already writes. (DNX's doc says unused records hold "stale
  garbage"; in a device dump they do not — worth feeding back.)
- **The p-lock value law.** **[measured today]** lane values land on `× 256`:
  paramId 19 on track 4 holds 7936, 7680, 7424 = 31, 30, 29 × 256, and a swept
  lane (paramId 20) shows the fine low byte in use (241, 257, 279, 295…).
  Identical to the `scaledPlock(id, 256)` law measured on DT2 and DN2.
  So `plocks.js`, `params.js` and the display-axis seam in `roll-bridge.js`
  need **no changes at all** — they are already generic over `numSteps` and
  `pLockSize`.
- **Length bytes and micro-timing.** **[measured today]** length bytes span
  12–126 with the default `0x0E`, and micro values are confined to −23…+23.
  Both are the existing Elektron scales, so `lengthByteToSteps`,
  `stepsToLengthByte`, `snapLenFine` and the `/24` micro conversion are reusable
  verbatim.
- **`bankName`** — the DN1 also has 128 patterns as A01–H16.

### What is genuinely different

| | DT2 / DN2 | **DN1** |
|---|---|---|
| Tracks | 16, kind by mask | **8** — 0–3 synth, 4–7 MIDI, **positional, no flag** |
| Steps | 128 | **64** |
| Notes | shared 6-byte trig-record pool | **inline in the track record**, 8 bytes per step |
| Chords | one record per note (DN2) / quad (DT2) | root note + **7 signed semitone offsets** |
| Velocity / length / micro | per note, in the pool record | **per step**, in four parallel 64-byte lanes |
| Conditions | three lanes: COND / FILL / PROB | **one byte**, one combined menu |
| Track PROB default | one byte in the defaults tail | **does not exist** |
| Sound locks | per-step lane | per-step lane into a **128-slot project pool** |
| Trig flag bits | `0x0381` group set on a live trig | **`0x0001` only**, plus a `0x0010` odd-step parity bit |

Two consequences worth stating plainly:

- **A DN1 chord is stored as offsets from its root**, so a unison doubling is
  not representable (zero terminates the list) and the maximum is 8 notes.
  Encoding a roll chord means sorting, taking the lowest pitch as root, and
  dropping duplicates — a new drop reason for the write path to report.
- **Velocity, length and micro are per *step*, not per note.** This is the
  mirror image of the 2026-08-04 fix: on a DN1 a chord genuinely *does* flatten
  to one set of values, because the format has nowhere else to put them. The
  encoder must take them from the trig's first note (the same rule
  `trigSettingsFromNotes` already uses for conditions) and say so.

### Trig conditions are the one real unknown

**[measured today]** across 8 captures / 1,895 note trigs, the condition byte
takes 11 distinct values in 7…38. DNX's corpus saw 35 distinct codes in 5…64.

digi-roll's `conditions.js` — 76 entries, PRE/!PRE/NEI/… then ratios, with FILL
and PROB in *separate lanes* — is a Digitakt II-generation model. The DN1 puts
probability percentages and FILL in the **same** menu as the ratios, so the byte
is a different encoding of a different list. **The existing table cannot be
reused and must not be guessed at**: a wrong index writes `!3:7` where the user
asked for `50%`.

This is a capture-pair job (§3, Phase 0) and it is the only piece of the format
that blocks a complete feature.

### Swing has a strong candidate, not a fact

**[measured today]** `nameOffset + 24` (`0x473C`) — the *same relative offset*
as the verified DT2/DN2 swing byte — holds `0` in 504 of 516 captured patterns
and `4` in the other 12. That is exactly the distribution of a swing byte
(0 = 50%, 4 = 54%). DNX independently found this byte is copied to DN2 pattern
metadata `+0x18` by Elektron's own importer, across 1,152 matched pairs.

Strong, corroborated, and still **a hypothesis** — one capture pair settles it
(§3). `pattern-settings.js` derives the offset from `spec.pattern.nameOffset`
already, so if it confirms, swing costs zero lines of code.

---

## 2. The shape of the work

### 2a. New: `js/elektron/dn1/pattern.js`

A sibling of `dt2/pattern.js` and `dn2/pattern.js` that exports the same
surface — `SPEC`, `decodePatternKit`, `encodeTrackNotes`, `trackNotes`,
`trackTrigCount`, `describeOffset`, `bankName`, the length helpers — but
implements decode/encode itself against the inline-note layout, re-exporting
from `pattern-core.js` only the parts that are genuinely shared (the length and
micro scales, `bankName`, `diffPayloads`).

This is the honest reading of CLAUDE.md's "compose them instead". Bending
`pattern-core.js` to cover a pool-less, 8-byte-per-step layout would mean
editing a hardware-verified file to serve a box nobody has verified.

`SPEC` still carries the shared fields the layered modules read
(`pattern.pLocksIndex/numPLocks/pLockSize`, `track.size`, `track.numSteps`,
`pattern.tracksOffset`, `pattern.numTracks`, `pattern.nameOffset`), so
`plocks.js` and `pattern-settings.js` bind to it with no changes. It omits
`track.trigCond/trigFill/trigProb` and `track.trackProb`, which both existing
modules already treat as "this device has none" by throwing a named error —
callers need a null check instead of a throw (§2c).

`encodeTrackNotes` for the DN1 must:
- clear the track's `0x0001` bits, preserving `0x0010` parity and every other
  bit (the box's own delete behaviour);
- blank the four per-step lanes and the 8-byte note records for that track;
- write root + offsets per step, velocity/length/micro from the first note;
- leave the `0x0002` trigless-lock bit and its p-lock values alone — those are
  a real DN1 feature digi-roll doesn't model, and a write that wiped them would
  be silent data loss.

It gets the same minimal-diff property test `encodeTrackNotes` has: encode a
track, prove every byte outside that track's record is byte-identical.

### 2b. Registration — small, mechanical, five files

| File | Change |
|---|---|
| `protocol.js` | `FAMILY.DIGITONE = 0x0d` **[measured today]** |
| `device.js` | `PRODUCTS[20] = { name: 'Digitone', slug: 'digitone', family: 0x0d }`. `slugFromPortName`'s longest-name-first sort already keeps "Digitone II" from being claimed by "Digitone" — worth an explicit test |
| `safe-write.js` | `DECODERS.digitone`, `PRODUCT_BY_FAMILY[0x0d]`; **no `WRITE_ALLOWED_BUILDS` entry yet** |
| `param-tables.js` | nothing — `paramTableFor('DN1')` returning `[]` is already the correct "nothing curated" behaviour, and lanes round-trip byte-exact through the raw identity mapping |
| `labs/difflab.js`, `labs/console.js` | add the DN1 describer / spec entries |

### 2c. Generalisations at three shared seams

1. **`sendPatternKit` pacing.** It hardcodes `msg.length / 800`. DNX found on
   hardware that a **DN1 needs 200 bytes/ms** (elk-herd's gen-1 figure), and
   that under-pacing a write makes the box drop the read-back request — a write
   that worked and a UI that hangs. Make the rate a per-family constant.
2. **Track count.** `NUM_DEVICE_TRACKS = 16` in `main.js` and the destination
   pickers in `console.js` must come from the resolved decoder's
   `SPEC.pattern.numTracks`, falling back to 16 when no box is known.
3. **Absent write surfaces.** `applyTrackProb` and `applyTrackTrigSettings`
   throw when a spec has no offsets. `safeWriteTrack` should skip them when the
   spec doesn't declare them, rather than a caller learning not to pass
   `trackProb`. One guard, in the one function every write path runs.

Also: **`trackKindLabel`** needs a DN1 answer. There is no mask — kind is
positional — so `SPEC` carries `midiTracksFrom: 4` and `decodePatternKit`
synthesises `midiMask = 0xF0`. That keeps `main.js:964` and `console.js:189`
unchanged.

### 2d. The generator, the roll and the bank

Mostly free, with two clamps:

- `js/gen/` resolves lanes per box by canonical name. With no curated DN1
  parameter table, the existing **"no box resolvable ⇒ no lanes, and say so"**
  rule fires correctly on its own. Motion sliders will be inert on a DN1 until
  someone maps its paramIds; the panel should say which box that applies to.
- The roll draws up to 128 steps; a DN1 track maxes at 64. `rollLengthForTrack`
  clamps to `min(128, …)` — it needs the device's own maximum, or a 128-step
  pattern silently loses its second half on send. The confirm dialog already
  warns when a pattern is longer than the destination track; that warning must
  become a hard drop count for steps ≥ 64.

---

## 3. Phasing, and what needs hardware

### Phase 0 — capture pairs (needs a DN1, no code)

Run through `difflab.html` once the family byte is registered — the lab is
read-only by construction, so this is safe on any project. One pair per fact:

1. **Trig conditions.** Walk the DN1's TRC menu one entry at a time on one trig,
   capturing after each. This is the only blocking unknown; expect ~20 pairs and
   a new `dn1/conditions.js` table. Everything else in the feature ships without it.
2. **Swing** — set a pattern to 54%, then 80%. Confirms or kills `0x473C`.
3. **Note length** — confirm the shared byte scale at three anchors (0.125, 1, INF).
4. **Chord entry** — a 4-note chord on one step, to confirm the offset encoding
   and how the box orders offsets.
5. **Track length** — confirm `settings + 0x0C`, which DNX has as INFERRED.
6. **Flag bits** `0x0080` / `0x0200` / `0x0400` — retrig is the likely candidate
   and digi-roll must not disturb them.

### Phase 1 — read-only support (no hardware needed)

Everything in §2 except the write allowlist. Testable today against fixtures:
copy `Digitone_PatternKit_1x_2355.syx` and one project dump into
`dumps/fixtures/` (they are throwaway hardware-test captures, but **your call**
— the corpus is deliberately gitignored, and `!dumps/fixtures/` means anything
put there gets committed). That gives `dn1.test.js` the same footing
`dn2.test.js` has: decode 128 real patterns, round-trip byte-identical, check
the lock pool census.

Ships: whole-project backup, pattern import, the roll, the bank, MIDI export,
cross-device copy **into** a DT2/DN2 from a DN1 slot. All read paths.

### Phase 2 — write support (needs a DN1, gated)

Only after Phase 1's tests are green and Phase 0's conditions table exists.
`WRITE_ALLOWED_BUILDS.digitone = ['0097']` (OS 1.42A) goes in **last**, after
the verify cycle passes on that exact build.

Three DN1-specific hazards, all from DNX's hardware log, all to be re-tested here:

- **A write to an occupied slot was silently refused** — observed twice on
  2026-08-01 (A1 → H16, H16 unchanged, no error). If that reproduces, digi-roll's
  verify reports "the box did not store what we sent", which is true but reads as
  corruption. `writeResultMessage` should learn DNX's three-way comparison:
  against what was sent (overwritten), against what the slot held before
  (**refused, nothing lost**), and against neither (something else). This is a
  genuine improvement for all three boxes, not DN1 scaffolding.
- **A write lands in the active project in RAM, not the +Drive.** It survives a
  power cycle and is lost when another project is loaded without saving — so on
  a DN1 the box's own SAVE PROJECT is the commit step, and a write is reversible
  until then. That is a *stronger* undo than anything digi-roll has, and the
  confirm dialog should say so.
- **Never send `0x53` to a DN1.** Its sound dump is ambiguous even when reading
  (kit track sound or pool slot), so its write direction is unproven. digi-roll
  has no sound write path today; the point is not to add one here.

### Phase 3 — optional, later

Curated DN1 p-lock parameters (a `dn1/params.js` mapping paramIds to names +
CC/NRPN from the DN1 manual), which switches on Motion in the generator and the
p-lock strip. Pure addition; nothing else waits on it.

---

## 4. Effort and risk

| Phase | Work | Blocked on |
|---|---|---|
| 0 | one session with the box + diff lab | a DN1 |
| 1 | ~a day: one new module, five registrations, three seams, a test file | fixtures (available) |
| 2 | ~half a day of code, one hardware verify session | Phase 0 conditions + a DN1 |
| 3 | ~half a day per parameter batch | manual + capture pairs |

**The risk that matters** is not the struct map — that is unusually well
evidenced for a box nobody here has mapped. It is that DN1 support is the first
time digi-roll writes to a **second struct family**, so every layered module
gets exercised against a spec shaped differently from the two it was written
for. Phase 1's fixture tests are what catch that before any byte reaches
hardware.

**Nothing in this plan has been verified on a DN1 by digi-roll.** The claims
tagged *[measured today]* were measured from DN1 captures taken by DNX on real
hardware; the rest is DNX's corpus analysis, carried across with its own
confidence tags intact.
