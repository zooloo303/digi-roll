# digi-roll

A minimal browser-based piano roll for getting MIDI patterns onto Elektron boxes.
Draw a pattern and send it straight into a Digitakt II / Digitone II pattern
slot over SysEx — or pull a track off the box, edit it, and write it back.
Anything else that receives notes and clock (the Octatrack, older Digis) can
still capture the pattern by live recording.

No build step, no dependencies — plain HTML/JS using the Web MIDI API
(same approach as [elk-herd](https://github.com/mzero/elk-herd)).

## Run it

**Hosted:** https://zooloo303.github.io/digi-roll/ — open in Chrome (or
Edge/Brave — not Safari), allow the MIDI permission, pick your box. Patterns
save in the browser's localStorage per device.

**Locally:** Web MIDI needs a secure context, so serve the folder rather than
opening the file directly:

```sh
cd digi-roll
python3 -m http.server 8123
# then open http://localhost:8123 in Chrome (or Edge/Brave — not Safari)
```

Allow the MIDI permission prompt, pick your box in the output menu.

## Workflow: sending a pattern to the box (Digitakt II / Digitone II)

Both everyday routes live in the **Box** panel (⇄) on the main page; the device
console is only for the advanced jobs.

**New pattern → a track:** draw it, open **Box**, pick the destination pattern
and track under *Send to box*, press **Send → A01 T1**, confirm. The notes are
in the box's sequencer — no live recording, no clock to line up. If the pattern
is longer than that track, the confirmation says so: the notes are all stored,
but the box plays only as far as the track's own **LEN**.

**Round trip:** *Import from box* → **Fetch** a pattern (read-only), pick a
track, **Import into this slot**. Edit, then **Write back → A01 T3** — already
aimed at where the notes came from, and it refuses to write to a different box
than the one they came from.

Every write is the same safe flow: re-read the destination pattern, download a
`.syx` backup of it, change only that track's notes, read it back and compare
every byte. Sounds, p-locks and other tracks are untouched, and writes are
gated on a per-device OS-build allowlist.

## Fallback: capturing a pattern by live recording

For boxes digi-roll can't write to directly (Octatrack, older Digitakt,
Digitone I, or an OS build not on the allowlist):

1. Box connected over USB, selected as the MIDI output.
2. On the box: **SETTINGS → MIDI CONFIG → SYNC** — enable **CLOCK RECEIVE**
   and **TRANSPORT RECEIVE**. Keep **Clock** checked in the app.
3. Set the app's channel to the destination track's MIDI channel
   (**SETTINGS → MIDI CONFIG → CHANNELS**).
4. Draw notes, press Play to audition through the track's sound.
5. To transfer: put the box in live recording (RECORD + PLAY) on an empty
   pattern, press Play in the app. The app sends MIDI Stop → Start + clock,
   which snaps the box back to pattern step 1 in sync with the app's bar 1,
   then records the incoming notes. Loop once, exit record mode.

**Sync rule: one clock master at a time.** If another device (e.g. an
Octatrack) is also sending clock/transport to the box, capture won't line up.
During capture either stop the other master's clock send, or set the Digi's
**MIDI CONFIG → PORT CONFIG → INPUT FROM = USB** so it only listens to the
app, and flip it back afterwards. Use the **Count-in** setting (1–2 bars of
clock before notes start) to get a moment between arming live record and the
notes arriving.

## Editing

- Click an empty cell to draw a note; keep dragging right to set its length
- Drag a note to move it, drag its right edge to resize
- Right-click / alt-click deletes; Delete key removes the selection
- Shift+drag a note up/down to set its velocity (brighter = harder); the
  slider mirrors the touched note and sets the default for new notes
- Cmd/Ctrl+drag a note sideways for micro-timing (± half a step, shown while
  dragging); **Swing** (50–80, per pattern) pushes the odd 16ths late
- Multi-select: Cmd/Ctrl+drag on empty grid for a marquee, shift+click to
  toggle a note in or out. Move, delete, shift+drag velocity and the Vel
  slider all apply to the whole selection
- Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z undo and redo (100 steps); Cmd/Ctrl+C/X/V
  copy, cut and paste — the clipboard survives switching pattern slots
- **Dup bar** adds a bar and copies the last one into it (up to 8 bars)
- Scale menu (root + scale) tints the in-scale rows; purely visual
- Octave numbering follows the boxes: the key column calls MIDI 60 **C5**, the
  same as the DT2/DN2 display, one higher than the middle-C = C4 convention
- **Export .mid** writes a type 0 Standard MIDI File of the current pattern
  (tempo, velocities, swing and micro-timing baked in); **Import .mid** reads
  a type 0/1 file back in, quantized to 16ths with the remainder as
  micro-timing
- 8 pattern slots, 1–8 bars each (128 steps, matching the Digi II boxes),
  auto-saved to localStorage
- Space bar = play/stop

## Device console (SysEx)

`console.html` is a separate page that talks to the box over SysEx: it shows a
hex log of every exchange, identifies the device (model + OS version), and can

- **Backup project** — fetch a whole-project dump and download it as a
  replayable `.syx` file, no Transfer app needed (Digitakt, Digitakt II,
  Digitone II);
- **Import from box** — fetch any pattern (or open a `.syx` backup), pick a
  track, and its trigs land in the piano roll with exact notes, velocities,
  lengths and micro-timing (Digitakt II + Digitone II);
- **Write to pattern** — the reference implementation of the write path the
  main page's *Send to box* runs: a piano-roll pattern written straight into a
  pattern slot's track, with automatic pre-write backup, a per-device
  OS-version allowlist and byte-level verify-after-write (Digitakt II +
  Digitone II, both hardware-verified);
- **Copy track** — a track from one pattern (or one box) into another, via a
  live fetch or a saved `.syx`.

`difflab.html` is the reverse-engineering workbench that mapped those formats:
capture a pattern, make one edit on the box, capture again, and read a hex
diff annotated with struct-region names, saved to a lab notebook.

Protocol notes live in `docs/elektron-sysex-protocol.md`; the pattern formats
— including what we believe is the first public documentation of the
Digitone II pattern format — in `docs/dt2-pattern-format.md` and
`docs/dn2-pattern-format.md`.

The protocol implementation is ported from
[elk-herd](https://github.com/mzero/elk-herd) by **mzero** (BSD-2-Clause),
whose source is the de-facto documentation of Elektron's SysEx protocol.

## Architecture

- `js/state.js` — pattern model + persistence
- `js/midi.js` — Web MIDI engine: output handling, lookahead scheduler
  (timestamped `MIDIOutput.send`, 24 ppqn clock, start/stop transport)
- `js/pianoroll.js` — canvas editor
- `js/main.js` — UI wiring
- `js/elektron/` — SysEx protocol: `sevenbit.js` (7↔8-bit packing),
  `protocol.js` (framing/checksums), `device.js` (handshake, dumps),
  `pattern-core.js` + `dt2/` + `dn2/` (pattern struct decode/encode)
- `js/labs/` — the device console and diffing-lab pages
- `test/` — Vitest unit tests for the protocol code (dev-only; the app itself
  stays dependency-free): `npm install && npm test`

## Ideas / later

Next up: **probability / fill / trig conditions** — drawing `50%`, `FILL`, `1ST`
and the `A:B` ratios in the roll — then **p-lock lanes** (filter, pitch, … as
automation lanes). After that, pattern chaining preview and widening the write
allowlist beyond one verified OS build per box. See `PLAN.md` for the detail.

The Octatrack stays on the live-record path; it has no pattern SysEx.
