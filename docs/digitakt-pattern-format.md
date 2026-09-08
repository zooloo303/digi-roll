# Digitakt Mk1 — partial read map (2026-09-08)

Evidence: the eight original pairs in
[`dumps/fixtures/issue-8-2026-09-08/digitakt/`](../dumps/fixtures/issue-8-2026-09-08/digitakt/).
OS 1.52, build 0095; family `0x0a`, request `0x60`, response `0x50`,
A01. All 16 snapshots contain 27,648 unpacked bytes and a big-endian
struct version of 9 at offset 0. All offsets below are unpacked, decimal.

`node scripts/analyse-legacy-captures.mjs` verifies donated file hashes,
parser integrity and the intake diff list, then prints derived comparisons
and raw reads. It never rewrites the evidence. The tests pin those results.

## Measured fields

| Offset | Observation | Read support |
|---|---|---|
| 4–5 | `02 81` persists throughout all captures | Raw bytes only; no clean trig creation pair |
| 132 | Pitch edit `ff → 3e` | Track 1 step 1 pitch raw byte |
| 196 | Velocity edit `ff → 33` | Track 1 step 1 velocity raw byte |
| 260 | Length edit `ff → 1c` | Track 1 step 1 length raw byte |
| 324 | Micro edit `00 → 01` | Track 1 step 1 micro raw byte |
| 900–902 | Stable `3c 68 0e` | Candidate defaults, never resolved into notes |
| 25001 | Pattern expansion `10 → 20` | Raw length byte |
| 24998–24999 | Tempo edit `3c 00 → 3a 20` | Changed bytes only, no BPM conversion |
| 25004 | Swing edit `14 → 04` | Raw byte, no percentage conversion |

The “add trig” pair resets pitch/velocity/length to `ff` and micro to zero;
it does not change the step word. `ff` resembles an inheritance sentinel,
but a default-edit experiment is needed before resolving it.

Every adjacent after → next baseline comparison is byte-identical except
velocity → length: offset 196 reverts `33 → ff`. Comparing the **velocity
after** to **length after** instead isolates just offset 260, `ff → 1c`.
This is a derived comparison; the original length pair still has two edits.

## Candidate structure, not a complete decoder

- Track-like area begins at 4, with 16 blocks of 911 bytes, ending at 14580.
  Expansion changes offset 909 plus multiples of 911 in all 16 blocks.
  Shared first-step fields suggest 64-byte lanes after 128 step-word bytes.
  Other steps and tracks have no controlled parameter edits yet.
- At 14580 are 80 consecutive 130-byte records: `ff ff` followed by 128
  zero bytes, in every snapshot. They fit a 64-step p-lock pool, ending at
  24980. Allocation, IDs, values and sentinel semantics are unverified.
- The next 16 zero bytes could hold a name. A candidate 32-bit BE tempo
  at 24996 changes 15360 → 14880. Dividing by 120 would give 128 → 124 BPM,
  but no displayed values were supplied, so that conversion is not exposed.
- A candidate kit header starts at 25088 (`00 00 00 09`), matching the
  standalone pattern size in the probe. Eight `be ef ba ce` sound headers
  start at 25124 + 160 × n. This corroborates a pattern/kit split at 25088
  much more strongly than size alone. Kit contents are still opaque.

The raw reader accepts only this family, request, size and struct version.
Lab descriptions label only controlled fields; surrounding offsets remain
`unknown`. No Studio import, encoder, condition, p-lock, or write capability
is enabled. Protected DT2/DN2 code and firmware write allowlists are unchanged.

## Next evidence needed

A clean empty → one trig pair, then one non-first-step/non-first-track pitch
edit would test trig bits and stride. A default-note edit with an unlocked
trig would test inheritance. Record displayed length, signed micro, tempo
and swing values in small targeted pairs before implementing conversions.
No new request has been posted. This read implementation has not been tested
against connected hardware.
