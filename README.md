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

There's no build step, so the browser is caching the ES modules directly — after
editing a `js/` file, a plain reload can quietly keep running the old code (the
symptom is a change that "didn't take"). Use a cache-bypassing reload
(**Cmd/Ctrl+Shift+R**), or keep DevTools open with *Disable cache* ticked.

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
`.syx` backup of it, change only that track, read it back and compare every byte.
Sounds, the kit and the other fifteen tracks are untouched, and writes are gated
on a per-device OS-build allowlist. That track's own p-lock lanes *are* replaced,
the same way its trigs are — the confirmation says so before anything is sent.

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
  dragging); **Swing** (50–80, per pattern) pushes the odd 16ths late, and
  travels to the box with a send — where it re-times every track in that slot
- Multi-select: Cmd/Ctrl+drag on empty grid for a marquee, shift+click to
  toggle a note in or out. Move, delete, resize, shift+drag velocity and the
  Velocity and Length sliders all apply to the whole selection — an edge-drag
  keeps long and short notes different, the Length slider makes them equal
- Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z undo and redo (100 steps); Cmd/Ctrl+C/X/V
  copy, cut and paste — the clipboard survives switching pattern slots
- **Trig lane** under the grid — the box's TRIG page 1, one column per step:
  **PROB** (drag up or down; the top means no lock), **COND** (click for a
  picker: `PRE`/`NEI`/`1ST`/`LST`, their `!` negations, and every ratio from
  `1:2` to `!8:8`) and **FILL** (click to cycle none / ON / OFF). Drag sideways to
  paint across steps, right-click to clear, and edits reach every selected step
  at once. These belong to the trig, so every note on a step shares them —
  exactly as the hardware works
- **P-lock lanes** below the trig lane — per-step parameter automation as bar
  rows. Eleven parameters both boxes share (filter cutoff, resonance, filter env
  depth, pan, overdrive, delay/reverb/chorus send, LFO 1–3 depth). Click in a lane
  to set a step, drag to draw, sideways to paint. **Press Play and you hear it on
  the box** — lanes are sent as live NRPN parameter changes ahead of each trig, so
  a filter sweep can be auditioned before anything is transferred. And they
  **transfer into the pattern**: the unpublished internal numbers the format
  uses were measured from real hardware on both boxes (2026-08-04), so all
  eleven store, round-trip and translate across boxes by name. A lane
  automating a parameter *outside* the eleven comes in read-only and is
  **preserved byte-exact** through write-back, copy and Library saves. See
  `PLAN.md`
- **Dup bar** adds a bar and copies the last one into it (up to 8 bars)
- Scale menu (root + scale) tints the in-scale rows; purely visual
- Octave numbering follows the boxes: the key column calls MIDI 60 **C5**, the
  same as the DT2/DN2 display, one higher than the middle-C = C4 convention
- **Export .mid** writes a type 0 Standard MIDI File of the current pattern
  (tempo, velocities, swing and micro-timing baked in — but not trig
  conditions, which MIDI has no concept of); **Import .mid** reads a type 0/1
  file back in, quantized to 16ths with the remainder as micro-timing
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
- **Save .syx** — keep the pattern you just fetched as a single-pattern file,
  restorable on its own and loadable as a copy source on the other box;
- **Write to pattern** — a piano-roll pattern written straight into a pattern
  slot's track — notes, trig conditions, track PROB and p-lock lanes, plus the
  pattern's swing — with automatic pre-write backup, a per-device OS-version
  allowlist and byte-level verify-after-write (Digitakt II + Digitone II, both
  hardware-verified). Same flow as the main page's *Send to box*: both run
  `safeWriteTrack`;
- **Copy track** — a track from one pattern (or one box) into another. The
  destination is always the connected box, so *Connect* is how you pick it, and
  a loaded source is held in memory: to copy between two boxes, load the source
  off the first one, switch the device dropdown, connect the second, and copy.
  A saved `.syx` works as a source too, for a copy in a later session.

`difflab.html` is the reverse-engineering workbench that mapped those formats:
capture a pattern, make one edit on the box, capture again, and read a hex
diff annotated with struct-region names, saved to a lab notebook.

**Own an Elektron box digi-roll can't read yet?** The lab is set up so you can
map it without writing code, and it never writes to a box — it physically
refuses to send anything but read-only dump requests. **Probe dump protocol**
finds which SysEx family byte your box answers; then each capture pair
(baseline → one edit → capture, exported as one file) teaches us one byte-level
fact about its pattern format. Donated pairs can be diffed here with no hardware
attached. See **[docs/adding-a-device.md](docs/adding-a-device.md)** for the
walkthrough and exactly what a pair contains.

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
- `js/triglane.js` — the step-aligned PROB/COND/FILL strip under the roll
- `js/plocklane.js` — the p-lock automation lanes below it
- `js/main.js` — UI wiring
- `js/elektron/` — SysEx protocol: `sevenbit.js` (7↔8-bit packing),
  `protocol.js` (framing/checksums), `device.js` (handshake, dumps),
  `pattern-core.js` + `dt2/` + `dn2/` (pattern struct decode/encode),
  `conditions.js` + `trig-cond.js` (the PROB/FILL/COND tables and lanes),
  `plocks.js` + `params.js` (the p-lock lane pool and its parameter tables)
- `js/labs/` — the device console and diffing-lab pages
- `test/` — Vitest unit tests for the protocol code (dev-only; the app itself
  stays dependency-free): `npm install && npm test`

## Ideas / later

**P-lock lanes** are drawable, audible and stored in the pattern — the write
path is hardware-verified on both boxes (2026-08-04). The unpublished
`paramId` numbering and value scaling were measured the same day by the Phase 0
experiments (logs in `docs/`, fixtures in `dumps/fixtures/`). Small residuals
for the next hardware session: emptying a lane via a send, and a cross-device
copy carrying translated lanes.

After that: pattern chaining preview, and widening the write allowlist beyond one
verified OS build per box. See `PLAN.md` for the detail.

Per-trig conditions — `50%`, `FILL`, `1ST`, `PRE`, the `A:B` ratios — landed in
the **trig lane** under the roll. The byte format is hardware-verified on both
boxes and documented in `docs/`; writing them to a box is implemented but has
not been smoke-tested on hardware yet.

The Octatrack stays on the live-record path; it has no pattern SysEx.
