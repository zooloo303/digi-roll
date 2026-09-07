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

If the probe found a family byte, the capture target above the hint fills itself
in, and:

1. **Capture baseline.**
2. Change **exactly one thing** on the box. One trig on, one knob one click, one
   track's length. One thing is the whole method — two changes make a diff you
   can't attribute.
3. **Capture + diff.** Changed bytes appear, annotated where we understand the
   struct and as raw offsets where we don't. For a new box everything is raw
   offsets — that's expected, and those offsets are the discovery.
4. Type what you changed into the note box, in plain words.
5. **Export pair** → drag the `.json` into your mapping issue. **Save to
   notebook** keeps a running log you can **Export .md** at the end of a session
   and paste in alongside.

A good first series, one pair each: empty pattern → one trig on track 1 step 1;
then that trig's velocity; then its length; then micro-timing; then note pitch;
then pattern length; then tempo; then swing. That sequence is exactly how the DT2
and DN2 formats got mapped, and the logs are in `docs/dt2-pattern-format.md` and
`docs/dn2-pattern-format.md` if you want to see what the answers looked like.

## What a capture pair contains

Plain JSON, readable in any editor before you post it:

- the two dump messages, base64'd, **exactly** as your box sent them (framing and
  version bytes included — on an unmapped box those are evidence too);
- your box's name, product id, OS build and version;
- the family byte, request type and slot the captures were fetched with;
- your note and a timestamp.

It contains one pattern slot from your project. It does **not** contain samples,
sounds, project settings, or anything else on the box — and no personal data
beyond what your box reports about itself. Read it first if you'd rather check.

## Step 3 — what we do with it

Anyone can load a donated pair with **Open pair…** and read its diff with no
hardware attached, which is the point: we can work on your box's format without
owning your box. Turning confirmed facts into support means adding a `SPEC` (the
struct offsets) and a `describeOffset` beside `js/elektron/dt2/pattern.js` and
`dn2/pattern.js`, which is a day's work once the facts exist — and the facts only
come from someone holding the box.

Read support lands first. Write support waits for someone with that box to run
the verify cycle: write, read back, byte-compare, check the box's own UI.
