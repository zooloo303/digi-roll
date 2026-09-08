# Digitakt Mk1 and Syntakt mapping handoff — 2026-09-08

## Read-mapping follow-up — 2026-09-08

The first offline read pass is now implemented. See
[Digitakt format notes](digitakt-pattern-format.md) and
[Syntakt format notes](syntakt-pattern-format.md) for measured fields,
candidate layouts and the remaining targeted evidence needs.
`node scripts/analyse-legacy-captures.mjs` reproduces hash/parser/diff checks
and derived comparisons without changing the original evidence.

`js/elektron/legacy-read.js` exposes raw measured fields, with family,
request, size and struct-version guards. The lab uses those guards to label
supported offsets. Syntakt product identity and both legacy family identities
are registered. Studio note import remains unavailable until defaults and
musical conversions can be established. No write gates changed, no contributor
message was sent, and no new implementation was tested on hardware. The full
suite passes: 34 files, 850 tests.

The intake record below describes the state before that implementation.

## Start here

XtremeSounds supplied the requested eight capture pairs for each box. Intake
and validation are complete; implementation starts next session. Work from
the local fixtures, with no hardware required. No read decoder, write support,
or firmware allowlist change was made during intake.

- [Digitakt issue #8 and ZIP upload](https://github.com/zooloo303/digi-roll/issues/8#issuecomment-5587771514)
- [Syntakt ZIP, also in #8](https://github.com/zooloo303/digi-roll/issues/8#issuecomment-5587813077)
- [Original Syntakt issue #7](https://github.com/zooloo303/digi-roll/issues/7)
- [Local evidence directory](../dumps/fixtures/issue-8-2026-09-08/)
- [Source URLs and hashes](../dumps/fixtures/issue-8-2026-09-08/manifest.json)
- [Validation and every changed payload byte](../dumps/fixtures/issue-8-2026-09-08/validation.json)

The files in `digitakt/` and `syntakt/` are extracted byte-for-byte from the
uploaded ZIPs, with their original filenames. Each directory has eight `.json`
pairs and one `.txt` probe report. The manifest records archive SHA-256 hashes
and each extracted file's size and SHA-256. ZIPs remain available at the source
URLs; the extracted evidence is sufficient to reproduce analysis locally.

## Validation performed

All 16 pairs were parsed with `parseCapturePair` from
`js/labs/capture-pair.js`. All 32 snapshots passed SysEx checksum and count
validation; both sides of every pair have matching family, response type and
slot. Every pair contains a nonempty payload diff. All use A01 (index 0),
request `0x60`, response `0x50`.

| Device | Product ID | Reported OS/build | Family | Payload bytes per snapshot |
|---|---|---|---|---|
| Digitakt Mk1 | 12 | 1.52 / 0095 | `0x0a` | 27,648 |
| Syntakt | 30 | 1.40 / 0082 | `0x16` | 31,744 |

The contributor entered “1.40A” for Syntakt in the issue; preserve that
distinction from the device-reported version. Syntakt exports are named
`product30` and carry slug `elektron`; this is the current generic identity
fallback, not evidence of an invalid capture.

Parser validation establishes intact messages, not the correctness of the
experiment labels or a complete format mapping.

## Observations and caveats

Offsets below are decimal offsets into the unpacked payload, not raw SysEx.
Byte values in the table are hexadecimal. Rows follow capture time; filenames
and original notes are in `validation.json`.

| Experiment | Digitakt Mk1 | Syntakt |
|---|---|---|
| Add track 1 step 1 trig | Four parameter changes: 132 `43→ff`, 196 `66→ff`, 260 `50→ff`, 324 `0a→00`; no trig-word change | 4 `00→03`, 5 `00→81` |
| Trig velocity | 196 `ff→33` | 196 `ff→5f` |
| Trig length | 260 `ff→1c`, **also** 196 `ff→33` | 260 `ff→1a` |
| Microtiming | 324 `00→01` | 324 `00→ff` |
| Note pitch | 132 `ff→3e` | 132 `ff→3b` |
| Pattern length | 23 changed bytes; includes repeated `10→20` length candidates and copied step data | 20 changed bytes; includes repeated `10→20` length candidates and copied step data |
| Tempo | 24998 `3c→3a`, 24999 `00→20` | 23202 `40→b8` |
| Swing | 25004 `14→04` | 23207 `0e→0f` |

The Digitakt “add trig” pair appears to reset existing trig parameters; do not
use it as proof of empty-pattern-to-trig encoding. The earlier notebook in #8
reports offsets 4/5 changing `00→02` / `00→81`, but has no corresponding full
pair. Treat that earlier report as supplementary evidence only.

The Digitakt length experiment includes the preceding velocity change.
Compare adjacent complete snapshots to isolate the length change, checking
byte equality of the relevant states first. Do not modify the donated files
or silently relabel a derived pair as the original experiment.

Pattern-length captures show repeated length fields (Digitakt offset 909 then
every 911 bytes for 16 entries, plus 25001; Syntakt offset 974 then every 983
bytes for 13 entries, plus 23204). Additional changes look like copying the
first trig into the second page on expansion. Those are layout/behaviour
hypotheses to investigate, not justification to reject a multi-byte diff.
Do not equate the 13 Syntakt entries with 13 ordinary instrument tracks.

The shared first-step offsets 132/196/260/324 are useful starting points for
pitch/velocity/length/microtiming lanes. These few observations do not establish
every track's layout, default-value resolution, signed timing scale, length
conversion, tempo units or swing scaling. Most notes name only the parameter;
exact before/after values from the instrument display were not supplied.
In particular, the earlier notebook's “length” and Syntakt “velocity” offsets
differ from the new per-trig captures; distinguish track defaults from trig
overrides before treating them as contradictory.

## Next-session work

1. Read `CLAUDE.md` and the existing device, pattern and lab modules. Keep
   protected DT2/DN2 encode/decode and protocol internals intact.
2. Reproduce fixture validation and inspect full snapshots, including defaults
   and the state transitions between adjacent experiments. Retain original
   evidence and document any derived comparisons separately.
3. Draft per-device format notes with measured offsets, candidate structure,
   and explicit unknowns. Establish where the pattern ends and kit data begins
   from evidence; do not assume DT2/DN2 layouts or that a combined dump is only
   notes. Probe response sizes alone are not a complete layout specification.
4. Implement only supported read behaviour, with fixture-backed assertions for
   the donated edits and defaults. Check identity/capability registration and
   lab description dispatch by family/request type. Scope Studio import to
   fields that can be decoded honestly; do not expose speculative mappings.
5. Run targeted tests for changed modules, then required regression checks.
   Report remaining ambiguities before requesting a small targeted capture.
   Keep write gates unchanged until a separate hardware verification effort.

Start analysis now; do not ask the contributor to repeat all eight tests.
This session did not post a receipt acknowledgement. The previous instruction
to post applied to the checklist comment, which is already on #8; ask for
authorization before sending a new message unless the user authorizes it.

## Contributor workflow lessons

The notebook export is a summary, not the complete captures. **Export pair**
downloads `digiroll-capture-….json`; collect those files, ZIP them, and upload
through the GitHub issue page. Replying by email did not produce visible
attachments in this exchange.

The baseline does **not** advance automatically after capture or export.
Capture a fresh baseline before each edit, or explicitly use the expert
**Chain: B → baseline** control. Both walkthroughs now state the fresh-baseline
method. Runtime UI changes, if useful, are a separate follow-up.
