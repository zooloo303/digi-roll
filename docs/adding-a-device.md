# Adding a device to digi-roll

digi-roll reads and writes Digitakt II and Digitone II patterns. Nothing about
the approach is specific to those two boxes — the blocker is that mapping a
pattern format requires having the box in front of you, and we have two.

If you own a **Digitone, Syntakt, Analog Rytm, Octatrack** or a gen-1
**Digitakt**, you can map it without writing any code. This is what to do and
what happens to what you send. An **Analog Four MkII** or **Analog Keys** is
worth a probe as well — see "if your box is a gen-1 Analog" below.

> **Not a developer?** Read
> **[mapping-your-box.md](mapping-your-box.md)** instead — the same six steps
> with none of the protocol, written for someone who owns the box rather than
> someone who'll write the `SPEC`. This page assumes you want to know *why* each
> step works.

Two links you'll need:

- the lab — **https://zooloo303.github.io/digi-roll/difflab.html** — in Chrome,
  Edge or Brave (Safari has no Web MIDI). Nothing to install.
- where findings go — **[a mapping issue](https://github.com/zooloo303/digi-roll/issues/new?template=map-my-device.yml)**.

## Browser connection regression

Chrome 152 on macOS can corrupt SysEx framing in its new UMP backend.
A silent identity/probe result on this browser is not evidence that a box lacks
the requested protocol. See [connection help and launcher](../midi-help.html).
Browser detection is advisory; successful connections still use the normal gates.
See [browser release verification](browser-midi-verification.md) before declaring
a Chrome release fixed or retiring the workaround.

## First: nothing here writes to your box

The diff lab (`difflab.html`) is read-only by construction, not by convention:

- Elektron's dump protocol uses `0x6n` messages to **request** a dump and `0x5n`
  messages to **carry** one. Sending a `0x5n` is what stores a payload on a box.
- The two functions the lab uses to talk to hardware — `fetchDump` and
  `probeDumpRequests` in `js/elektron/device.js` — refuse any opcode outside the
  request range `0x60`–`0x6e`, and throw before a byte reaches the port. There is
  no code path from the diff lab to a write.
- Even once a box is mapped, writing stays off until someone verifies it on that
  exact OS build (`WRITE_ALLOWED_BUILDS` in `js/elektron/safe-write.js`). Mapping
  a device does not switch writing on for anybody.

Use a scratch project anyway. It costs you nothing and it is the habit this whole
codebase is built on.

## Step 1 — probe the dump protocol

Every Elektron dump message carries a **family byte** saying whose structs it
holds: `0x06` Analog Four, `0x0a` Digitakt, `0x14` Digitakt II, `0x15` Digitone
II. These aren't published anywhere. The DN2's was found by sweeping requests
across candidate bytes until one answered.

1. Connect your box over USB, open [the diff lab](https://zooloo303.github.io/digi-roll/difflab.html),
   pick it in the dropdown, hit
   **Connect**. It should name itself and its OS even if digi-roll knows nothing
   else about it.
2. Hit **Probe dump protocol**. It sends ~100 read-only requests over about
   twenty seconds, then prints a report.
3. **Copy report**, then
   [open a mapping issue](https://github.com/zooloo303/digi-roll/issues/new?template=map-my-device.yml)
   and paste it in — *including* a report that found nothing. "This box answers
   no family byte over USB-MIDI" is a real finding, and it tells us to look at a
   different transport rather than at our sweep.

### If your box is a gen-1 Analog

The Analog Four, Analog Keys and Analog Rytm are older than the Digitakt II, and
**the same opcode fetches a different object on them**. On a Digitakt II, request
`0x64` is the project settings; on an Analog Four it is the pattern. The lab
knows this and follows the family byte — pick `06` and the capture menu renames
itself — but it is worth knowing before you read a report, because a line saying
"`0x64` → 12,974 bytes" is a pattern, not a settings blob.

Two other things the A4 taught us, which will probably hold for its relatives:

- **Requests `0x68`–`0x6d` fetch the box's current working state** — what is
  loaded and being edited right now. Those are the best captures to make, because
  an edit shows up with no save and without touching a stored slot at all. The
  lab labels them "working …" in the capture menu.
- **A working-state request ignores the slot you ask for** and answers with the
  loaded one. The lab records the slot the box *answered* with and tells you when
  it differs, so don't be alarmed when you ask for A06 and get A02 — that is the
  box telling you which pattern is loaded.

Request `0x60` on an Analog Four is not a dump but the **whole project**: 405
messages, 2.3 MB, about ten seconds. The probe knows to skip it, and you should
not pick it by hand unless that is what you want.

A probe report on its own is a real contribution. Open the issue with just that
if you'd rather stop there — the capture pairs below can follow later, or come
from someone else with the same box.

The report says which family byte answered, which dump types it serves, and how
big each one is. That alone is most of what a new device entry needs.

## Step 2 — capture pairs

A **capture pair** is the unit of evidence: the same pattern slot dumped twice,
either side of exactly one edit, plus a note saying what the edit was. One pair
proves one fact about the format ("the swing byte is at 88812", "a trig's
velocity lives in the pool record, not the step word").

The lab opens in guided mode: use [Guided experiment sessions](#guided-experiment-sessions)
below for its checklist and session ZIP. The following single-pair sequence is
for **Show all controls** (expert mode). If the probe found a family byte, the
capture target fills itself in:

1. **Capture baseline.**
2. Change **exactly one thing** on the box. One trig on, one knob one click, one
   track's length. One thing is the whole method — two changes make a diff you
   can't attribute.
3. **Capture + diff.** Changed bytes appear, annotated where we understand the
   struct and as raw offsets where we don't. For a new box everything is raw
   offsets — that's expected, and those offsets are the discovery.
4. Type what you changed into the note box, in plain words.
5. **Export pair** downloads `digiroll-capture-….json`, containing both complete
   snapshots and the note. Find it in Downloads or the browser's downloads list.
   Export before starting another experiment. **Save to notebook** and
   **Export .md** provide a summary only, not the full capture data.
6. Compress the downloaded `.json` files into a ZIP. Open the mapping issue on
   the GitHub website, drag the ZIP into a comment, wait for the upload, and
   post. Upload through the website rather than replying to notification email.

Before each new edit, click **Capture baseline** again, then repeat the change,
diff, note and export steps. Capturing or exporting does **not** automatically
advance the baseline. In expert mode, **Chain: B → baseline** is an explicit
alternative after exporting the current pair.

A good first series, one pair each: empty pattern → one trig on track 1 step 1;
then that trig's velocity; then its length; then micro-timing; then note pitch;
then pattern length; then tempo; then swing. That sequence is exactly how the DT2
and DN2 formats got mapped, and the logs are in `docs/dt2-pattern-format.md` and
`docs/dn2-pattern-format.md` if you want to see what the answers looked like.

## Guided experiment sessions

For **Add a trig**, follow the numbered instructions on the page. Confirm that
the chosen step is empty before capturing, then confirm you added a trig before
capturing again. These confirmations record “empty → trig on”; there are no
value fields to fill in for this experiment. Other experiments show only the
value fields needed at the current stage.

The prominent button follows your next step: **Capture before → Capture after →
Save experiment → Next experiment**. At the end of the checklist it becomes
**Download session ZIP**. You can also download early and stop after one experiment.
The download instructions name the exact file to attach; downloading does not
send it to anyone. Value examples are hints, not values to copy without checking
your instrument.

The guided lab now enforces a per-experiment cycle:

1. Choose a recipe, prepare its track/step, and enter the displayed before value
   (or explicitly mark it unknown / not displayed).
2. Capture a fresh baseline. The recipe, location and before value are locked.
3. Make one physical edit, capture after, and enter the displayed after value
   or explicit unknown. Notes record extra edits and other context.
4. Save the experiment in the tab. Saving is per pair, never a session-wide
   “already exported” flag. Multiple-byte and unchanged diffs are accepted.
5. Next experiment clears active snapshots and values, requiring a new baseline.
6. Download session ZIP, then attach it through the GitHub issue website.

Saved pairs and probe reports live only in memory until downloaded. Reconnects,
mode changes and explicit restarts clear active captures but retain the saved
session. The UI warns before leaving with undownloaded session additions or an
unfinished capture. A download request is not proof the user kept the file.

`js/labs/experiments.js` owns physical-edit recipes and value validation;
`experiment-panel.js` owns the guided cycle; `session.js` preserves validated
original pair JSON alongside structured metadata. `zip.js` produces a standard
uncompressed ZIP without browser dependencies. Each extracted pair still opens
with the existing `parseCapturePair` / Open pair path. ZIP import is not needed:
extract it and open an individual pair.

A targeted URL can use, for example,
`difflab.html?checklist=layout,default-note,length,micro,tempo,swing&issue=8`.
Only recognised recipe IDs are accepted. `issue` is a positive issue number
within this repository; it cannot redirect to another site. The standard list
is used when no checklist is supplied. The app can generate links using the
**Customize or share a checklist** disclosure, inclusion checkbox and Copy checklist link button.

The ZIP contains `pairs/capture-NNN.json`, optional `reports/probe-N.txt`,
`session.json` with displayed values and experiment metadata, and `README.txt`.
A report-only ZIP is valid. Each pair is validated for framing/checksum/count,
matching family/type/slot, metadata consistency and equal payload sizes before
being added. Unknown musical encodings are not grounds to reject a pair.

Hardware operations share a busy lock so identity, probing and captures cannot
interleave. Guided after captures use the baseline's target and compare the
actual returned slot; imported pairs cannot become live session contributions.
No new MIDI operations or write paths were introduced.

Run `npx vitest run` for unit/regression checks. The ZIP interoperability test
uses Python 3's standard-library ZIP reader. For the browser workflow, serve
the repo on localhost and run `scripts/test-capture-workflow.mjs` with Playwright
available (or set `PLAYWRIGHT_MODULE` to its `index.mjs`). It installs simulated
MIDI ports before page load and never needs connected hardware or a login.

## What a capture pair contains

Plain JSON, readable in any editor before you post it:

- the two dump messages, base64'd, **exactly** as your box sent them (framing and
  version bytes included — on an unmapped box those are evidence too);
- your box's name, product id, OS build and version;
- the family byte, request type and slot the captures were fetched with;
- your note and a timestamp.

The contents depend on the captured request. A pattern-kit dump can include
kit and sound settings and names; other request types can contain project
settings or other objects. These captures are not sample-audio exports. Use a
scratch project with data you are comfortable sharing; the note is included.
If more than one setting was edited, record that explicitly: the pair may
still be useful. A single edit can legitimately change multiple payload fields.

## Step 3 — what we do with it

Anyone can load a donated pair with **Open pair…** and read its diff with no
hardware attached, which is the point: we can work on your box's format without
owning your box. Turning confirmed facts into support means adding a `SPEC` (the
struct offsets) and a `describeOffset` beside `js/elektron/dt2/pattern.js` and
`dn2/pattern.js`, which is a day's work once the facts exist — and the facts only
come from someone holding the box.

Read support lands first. Write support waits for someone with that box to run
the verify cycle: write, read back, byte-compare, check the box's own UI.
