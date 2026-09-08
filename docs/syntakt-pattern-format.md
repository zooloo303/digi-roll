# Syntakt — partial read map (2026-09-08)

Evidence: the eight original pairs in
[`dumps/fixtures/issue-8-2026-09-08/syntakt/`](../dumps/fixtures/issue-8-2026-09-08/syntakt/).
Device reports OS 1.40, build 0082; contributor calls it 1.40A. Product 30,
family `0x16`, request `0x60`, response `0x50`, A01. All 16 snapshots contain
31,744 unpacked bytes and a big-endian struct version of 11 at offset 0.
Original `product30` filenames and `elektron` metadata remain untouched.
Offsets below are unpacked, decimal.

`node scripts/analyse-legacy-captures.mjs` reproduces file hash checks,
parser validation, intake diffs, raw reads and derived state transitions.

## Measured fields

| Offset | Observation | Read support |
|---|---|---|
| 4–5 | Trig creation `00 00 → 03 81` | Raw bytes; individual bit meanings unresolved |
| 132 | Pitch edit `ff → 3b` | Track 1 step 1 pitch raw byte |
| 196 | Velocity edit `ff → 5f` | Track 1 step 1 velocity raw byte |
| 260 | Length edit `ff → 1a` | Track 1 step 1 length raw byte |
| 324 | Micro edit `00 → ff` | Raw unsigned byte; no signed scale assumed |
| 964–966 | Stable `3c 64 0e` | Candidate defaults, never resolved into notes |
| 23204 | Pattern expansion `10 → 20` | Raw length byte |
| 23202 | Tempo edit `40 → b8` | Changed byte only, no BPM conversion |
| 23207 | Swing edit `0e → 0f` | Raw byte, no percentage conversion |

After trig creation, pitch/velocity/length remain `ff`; inheritance from the
candidate defaults is plausible but not established by a default-edit pair.
Micro's `ff` must not be treated as the same sentinel as the other fields.
All adjacent after → next baseline comparisons are identical except tempo →
swing: offset 23207 changes `00 → 0e` before the donated `0e → 0f` edit.

## Candidate structure and boundary problem

- Track-like area begins at 4, with 13 blocks of 983 bytes, ending at 12783.
  Expansion changes offset 974 plus multiples of 983 in all 13 blocks.
  **This is not evidence of 13 ordinary instrument tracks.** The extra block's
  role is unresolved. First-step fields suggest 64-byte lanes after 128
  step-word bytes; other tracks/steps remain untested.
- At 12783 are 80 consecutive 130-byte records, each `ff ff` and 128 zeros
  in every snapshot. They fit a 64-step p-lock pool, ending at 23183. No
  allocation or parameter value has been observed.
- Sixteen zero bytes follow. Candidate BE tempo at 23199 changes 14400 →
  14520, consistent with 120 → 121 BPM if scaled by 120; display values are
  missing, so runtime does not expose this interpretation.
- At 23552 appears `00 00 00 0b`, followed at 23556 by `KIT 1`. Twelve
  `be ef ba ce` sound headers begin at 23598 + 263 × n. The 263-byte stride
  matches the standalone sound size. This strongly suggests kit content
  begins around 23552 within the combined dump.
- The probe reports standalone pattern 27136 and kit 5632 bytes, whose sum
  is 32768, **1024 larger than the combined dump**. Sound headers already
  occur before 27136, so concatenating standalone sizes cannot map this
  combined layout. Neither the precise semantic boundary nor the full kit
  extent is established; do not slice a kit using those probe sizes.

Product identity now recognises Syntakt and its observed family. The partial
raw reader accepts only the captured request/size/version; lab dispatch uses
capture bytes, not the connected identity or the donated fallback slug.
Only measured fields receive labels. Studio note import remains unavailable
because default resolution, note length and timing conversion are incomplete.
No encoder or firmware write allowlist entry is added.

## Next evidence needed

Preserve a same-state `0x60`, `0x61`, `0x62` dump trio to compare actual
contents and resolve the combined/standalone boundary. One later-track,
later-step pitch edit can test stride; a default-note edit can test
inheritance. Record displayed length, signed micro, tempo and swing values
with targeted pairs before exposing conversions. No broad eight-test rerun
is needed, and no request has been posted. The new read implementation has
not been tested against connected hardware.
