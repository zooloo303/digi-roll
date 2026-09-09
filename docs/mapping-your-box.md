# Help digi-roll read your Elektron box

**No coding. Nothing gets installed. Nothing on your box changes.**

digi-roll can read and write patterns on the Digitakt II and Digitone II. It
does not yet have complete note import for the boxes below. Working out how a
box stores its patterns needs controlled captures from someone who owns it.

If you own a **Digitone, Syntakt, Analog Rytm, Analog Four, Analog Keys,
Octatrack** or a first-generation **Digitakt**, you can help by capturing a few controlled edits. You don't need to know what a
byte is. A short session is useful; completing the mapping may need follow-ups.

> Prefer the technical version, with the protocol reasoning and the byte-level
> method? That's [`adding-a-device.md`](adding-a-device.md). This page and that
> page describe the same capture workflow.

---

## First, the thing you're actually worried about

You're being asked to point a web page at an instrument with your patterns on
it. Fair enough. So:

**The lab has no button that changes anything on your box.** Not a save, not a
send, not a write, not an overwrite. Every single thing it does is *ask the box a
question and write down the answer*. There is no control on that page that can
alter a pattern, a sound, a kit or a setting — the buttons that do that kind of
thing live on a different page of digi-roll entirely, and they don't work on your
box anyway, because nobody has mapped it yet. (That's the thing you're helping
with.)

Two more things worth knowing:

- **Your box can't be "left in a weird state" by this.** Reading a pattern is
  the same thing your box does when you back it up to Transfer. It doesn't
  change what's loaded, it doesn't save anything, and unplugging halfway through
  does nothing except stop the reading.
- **Mapping your box does not switch writing on.** Even after we understand your
  box's format, digi-roll stays read-only on it until somebody with that exact
  box and OS version tests writing properly. That's a deliberate rule in the
  code, not a promise.

Use a scratch project anyway — a spare project with nothing in it you'd miss.
Not because anything here will hurt it, but because it's the habit everything in
this codebase is built on, and it costs you nothing.

If you want to check any of that rather than take my word for it, the "cannot
write" claim is enforced in code and explained in
[CONTRIBUTING.md](../CONTRIBUTING.md#the-lab-cannot-write-to-your-box).

---

## What you'll need

- Your box, and the USB cable it came with.
- **Chrome, Edge, or Brave** on a computer. Safari and Firefox can't talk to
  MIDI devices, so they won't work — this isn't a setting you can change.
- Time for a short session; you can stop after one experiment.

Nothing to download or install. The lab is a web page:

**→ [Open the diff lab](https://zooloo303.github.io/digi-roll/difflab.html)**

When it opens it will walk you through the steps below, one at a time, and tick
them off as you go. If you'd rather read them all first, here they are.

---

## Step 1 — Connect

Plug the box into your computer, switch it on, and wait for it to finish booting.
Then pick it in the dropdown at the top of the lab and hit **Connect**.

It should say its own name and OS version back at you — something like
*Syntakt · OS 1.20 (build 0055)*.

**If nothing happens**, or you get a message about no reply:

- **Using Chrome 152 on a Mac?** A known browser bug can prevent device replies.
  Read [connection help](../midi-help.html) for the tested launcher workaround
  before restarting your gear. The help opens separately from the lab; download
  any session ZIP before closing the lab tab.

- Make sure the box has *finished* booting before you hit Connect.
- If you plugged it in after opening the page, reload the page.
- Some boxes occasionally stop answering this kind of message until they're
  restarted. Turn the box off and on again, then retry — this fixes it far more
  often than anything you could do in the browser.

## Step 2 — Ask the box how it talks

Hit **Probe dump protocol** and leave it alone for about twenty seconds.

It's asking your box roughly a hundred harmless questions and noting which ones
get a reply. (This is how we found out how to talk to the Digitone II — by
asking until something answered.) When it's finished, hit **Copy report**.

**That report on its own is already a real contribution.** If you do nothing
else, [open a mapping issue](https://github.com/zooloo303/digi-roll/issues/new?template=map-my-device.yml)
and paste it in. You're done, and you've helped.

**Including if it found nothing.** "This box doesn't answer any of these
questions over USB" is a genuine, useful result — it tells us to go looking down
a different road instead of down this one. Please send it. A silent report is not
a failed attempt.

If it *did* find something, the lab quietly fills in the technical settings it
needs for the next steps. You don't have to touch or understand them.

## Step 3 — Choose an experiment and prepare the box

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

The **Experiment** menu contains the standard checklist: add a trig, velocity,
length, microtiming, pitch, pattern length, tempo and swing. It also offers
follow-up experiments for another track/step, a track default note, and a
custom edit. If someone sent you a checklist link, those requested experiments
appear first. Each experiment explains what to prepare and what to change.

Use the track and step shown in the form, or enter the ones you are actually
using. Preparation happens **before** the before snapshot: for example, a
velocity experiment needs an existing trig, while “Add a trig” needs an empty
step. Keep the same scratch pattern selected on the box and in the lab.

Enter the **Before value** exactly as the box displays it, including units,
octaves, fractions or a timing direction. If the box does not show a value,
select **Before unknown / not displayed**. For adding a trig, “empty” is a
useful before value. Do not guess.

## Step 4 — Capture before, make one edit, capture after

Click **Capture before**. This is your before snapshot. The page locks the
experiment, track, step and before value so they continue to describe that
snapshot.

Now make only the requested edit on the box. Click **Capture after** for the
after snapshot. Enter the **After value**, or explicitly mark it unknown / not
displayed. Include earlier/later or left/right for microtiming.

Several changed bytes are fine: one edit can change several stored fields.
A zero-change result is also useful. If you accidentally changed something
else, explain it in the note; the pair may still help. A corrupt response or
a response from another slot is rejected; follow the status message to retry
or restart.

## Step 5 — Save the experiment, then start the next one

Click **Save experiment**. This keeps both full snapshots and your experiment
details **in this browser tab**. It does not download them yet or send them to
anyone. The menu marks that experiment as saved.

Click **Next experiment**. The previous pair stays in the session, while the
active snapshots and value fields are cleared. Prepare the next experiment,
enter its before value and click **Capture before** to take a fresh snapshot before editing.
There is no automatic reuse of the previous after snapshot.

You can choose another experiment from the menu before taking a baseline. To
abandon an unfinished pair, use **Discard current pair and restart**. Saved
session pairs are retained. Reconnecting or switching between guided and
expert modes also clears the active pair; saved session pairs remain.

## Step 6 — Download one ZIP and attach it

Click **Download session ZIP**. It contains every saved experiment and any
probe reports collected in this tab. A probe report can be downloaded on its
own, including a report with no replies. There is no need to create a ZIP
manually, and you can stop after one experiment.

Check your Downloads folder for `digiroll-session-….zip`. **Download before
closing or reloading the tab**: the session is not stored across reloads.
Download again if you save more experiments or run another probe.

Click **Open mapping issue**. If you arrived through a link to an existing
issue, it opens that issue; otherwise it opens the new mapping issue form.
Drag the ZIP into the issue comment in your browser, wait for the upload to
finish, and post the comment. **Replying by email does not attach these files.**

The **Read the walkthrough** link stays on the lab page for future sessions.
To share a particular checklist, open **Customize or share a checklist**, select experiments and use **Include in
shared checklist**, then **Copy checklist link**. The link shares instructions,
not your captures or displayed values.

### Existing single-pair workflow

**Show all controls** retains **Export pair**, **Open pair…**, explicit
**Chain: B → baseline**, and the notebook. Export pair downloads the original
single JSON format. **Export .md** is only a notebook summary, not complete
capture evidence. In expert mode, take a fresh baseline before each edit or
explicitly chain the previous after snapshot.

---

## What's in the file you're sending

Fair question. It's plain text — open it in any text editor first if you'd like
to see for yourself. It contains:

- the two snapshots of **one pattern slot**, exactly as your box sent them;
- your box's name, model number and OS version;
- your note, and the time.

A pattern-and-kit capture can also include kit and sound settings and names.
It is not a sample-audio export. Other capture targets can contain different
data, so use a scratch project with names and settings you are comfortable
sharing. Your note is included too.

If the pattern you captured is from a project you'd rather not share at all, use
an empty scratch project instead — an empty pattern works perfectly well for
most of these experiments, and for experiment 1 it's actually required.

## What happens next

Someone can open your file in the same lab, with no box attached, and read what
moved. Enough pairs and we can teach digi-roll your box's format — first reading
patterns, then, once someone with your box has carefully tested it, writing them.

You'll be credited on the issue. And if you're the first person to send a report
for your model, you're the reason it gets supported at all.

**Thank you.** This is genuinely the one job that can't be done without you.
