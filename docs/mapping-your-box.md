# Help digi-roll read your Elektron box

**No coding. Nothing gets installed. Nothing on your box changes.**

digi-roll can read and write patterns on the Digitakt II and Digitone II. It
can't read yours yet — not because it's hard, but because working out how a box
stores its patterns means having that box in front of you, and we only have two.

If you own a **Digitone, Syntakt, Analog Rytm, Analog Four, Analog Keys,
Octatrack** or a first-generation **Digitakt**, you can fix that in about twenty
minutes, and you don't need to know what a byte is. This page is the whole job.

> Prefer the technical version, with the protocol reasoning and the byte-level
> method? That's [`adding-a-device.md`](adding-a-device.md). This page and that
> page describe the same six button presses.

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
- About twenty minutes.

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

## Step 3 — Take a "before" snapshot

Pick a pattern slot from the dropdown — one in your scratch project — and hit
**Capture baseline**.

That reads the pattern out of the box and remembers it. Nothing on the box
changes.

## Step 4 — Change exactly one thing, then snapshot again

Go to the box. Change **one** thing, and nothing else:

- put one trig on, or
- turn one knob by one click, or
- change one note's length, or
- change the pattern's tempo.

Then come back to the lab and hit **Capture + diff**.

**One change at a time is the entire method.** We learn where something lives by
seeing which part of the pattern moved when you changed it. Change two things and
we can't tell which change caused which movement, and the whole snapshot is
wasted. Resist the urge to be efficient here — it's the one thing that makes this
not work.

Your screen will now fill up with numbers. **That's fine and you can ignore all
of it.** It isn't addressed to you, you don't have to interpret it, and nothing
about it means you did something wrong. The lab will tell you in plain English
how much moved.

## Step 5 — Say what you changed

Type what you did into the note box, in completely normal words:

> put a trig on track 1, step 1

> turned track 3 filter cutoff from 64 to 65

> changed pattern tempo from 120 to 121

**This is the most valuable thing you give us.** The numbers are genuinely
meaningless without it — we can see that something moved, but only you know what
you touched. A snapshot pair with a vague note teaches us much less than one with
a precise note, and one with no note at all teaches us nothing.

## Step 6 — Save the file and send it

Hit **Export pair**. That saves one small file containing both snapshots and your
note.

Then [open a mapping issue](https://github.com/zooloo303/digi-roll/issues/new?template=map-my-device.yml)
and attach it. Say which box you have, and drag the file in. That's it — the
form asks for nothing you don't already have.

**Want to do more than one?** Please do — each pair teaches us one more fact, and
a run of them is what actually maps a box. Just change one more thing on the box
and hit **Capture + diff** again; the snapshot you just took becomes the new
"before". Attach all the files to the same issue.

A good run, if you're up for it — one pair each, in this order:

1. an empty pattern, then one trig on track 1 step 1
2. that trig's velocity
3. that trig's length
4. that trig's micro-timing
5. that trig's note pitch
6. the pattern's length
7. the tempo
8. the swing

That exact sequence is how the Digitakt II and Digitone II got mapped.

---

## What's in the file you're sending

Fair question. It's plain text — open it in any text editor first if you'd like
to see for yourself. It contains:

- the two snapshots of **one pattern slot**, exactly as your box sent them;
- your box's name, model number and OS version;
- your note, and the time.

It does **not** contain your samples, your sounds, your other patterns, your
project settings, or anything about you. The only personal thing in there is
whatever you typed in the note box.

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
