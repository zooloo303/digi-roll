# Contributing to digi-roll

There are two ways to help, and the first one needs no code.

## 1. Map a box we don't own

digi-roll reads and writes Digitakt II and Digitone II patterns. Nothing about
the approach is specific to those two — the blocker is that mapping a pattern
format requires having the box in front of you, and we have two.

If you own a **Digitone, Syntakt, Analog Rytm, Analog Four, Octatrack** or a
gen-1 **Digitakt**, you can map it without writing a line of code.

**→ [Open the diff lab](https://zooloo303.github.io/digi-roll/difflab.html)**
(Chrome, Edge or Brave — Safari has no Web MIDI)

**→ [Read the walkthrough](docs/adding-a-device.md)**

**→ [Open a mapping issue](https://github.com/zooloo303/digi-roll/issues/new?template=map-my-device.yml)**

### The lab cannot write to your box

Not by convention — by construction. Elektron's dump protocol uses `0x6n`
messages to *request* a dump and `0x5n` messages to *carry* one; sending a `0x5n`
is what stores a payload on a box. The two functions the lab uses to talk to
hardware, `fetchDump` and `probeDumpRequests` in `js/elektron/device.js`, throw on
any opcode outside the request range `0x60`–`0x6e`, before a byte reaches the
port. `test/device.test.js` asserts it.

Mapping a device does not switch writing on for anybody. Even once a box is
mapped, writing stays off until someone verifies it on that exact OS build —
`WRITE_ALLOWED_BUILDS` in `js/elektron/safe-write.js`.

Use a scratch project anyway. It costs you nothing and it's the habit this whole
codebase is built on.

## 2. Code

```sh
git clone https://github.com/zooloo303/digi-roll.git
cd digi-roll
npm install          # Vitest only — nothing reaches the browser
python3 -m http.server 8123
npx vitest run
```

Read [`CLAUDE.md`](CLAUDE.md) first — it's the set of constraints that don't
change between sessions. The short version:

- **The runtime stays zero-dependency vanilla JS.** ES modules, no bundler, no
  framework, no npm package reaching the browser. Vitest is dev-only.
- **Some files are hardware-verified and off limits** — `sevenbit.js`,
  `protocol.js`, the encode/decode paths in `pattern-core.js`, and the two
  `pattern.js` device structs. Every byte layout in `docs/` derives from them.
  Compose them instead. If a change genuinely seems to need editing one, say so
  in the issue rather than editing.
- **Every write goes through `safeWriteTrack`** in `js/elektron/safe-write.js`,
  which enforces all five safety rules as one function: auto-backup first,
  minimal diff, firmware allowlist, verify after write, throwaway projects only.
  Don't add a write path by hand.
- **Don't write to a connected box while developing.** Work against the committed
  fixtures in `dumps/` and the Vitest suite. Read-only checks against a box
  (identity, fetch) are fine.
- **`npx vitest run` must stay green**, and every feature gets tests. The model to
  copy is the minimal-diff property test for `encodeTrackNotes`: prove the
  untouched bytes stay byte-identical.
- **When reporting finished work, say what has *not* been verified on hardware.**

## Where things are

`docs/elektron-sysex-protocol.md`, `docs/dt2-pattern-format.md` and
`docs/dn2-pattern-format.md` are the byte-level truth — including the first
public documentation of the DN2 pattern format. `PLAN.md` is the roadmap.

Protocol work is ported from [elk-herd](https://github.com/mzero/elk-herd)
(BSD-2-Clause, by mzero). Keep the attribution.

## Not affiliated with Elektron

digi-roll is an independent project. Elektron, Digitakt, Digitone, Syntakt,
Analog Rytm, Analog Four and Octatrack are trademarks of Elektron Music Machines
MAV AB.
