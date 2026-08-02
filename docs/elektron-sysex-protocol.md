# Elektron SysEx protocol notes

What digi-roll knows about talking to Elektron boxes over SysEx. Nearly all of
this was learned from the source of [elk-herd](https://github.com/mzero/elk-herd)
by **mzero** (BSD-2-Clause) — elk-herd is the de-facto protocol documentation,
and parts of digi-roll's `js/elektron/` are direct ports of it. Thank you, mzero.

Elektron boxes speak **two unrelated SysEx mechanisms**. Both start with the
Elektron manufacturer header `F0 00 20 3C` and diverge at byte 4.

## 7-bit packing (both mechanisms)

MIDI data bytes can't use bit 7, so 8-bit payloads travel in groups of up to
7 data bytes preceded by one header byte carrying their high bits:

```
0abcdefg 0aaaaaaa 0bbbbbbb 0ccccccc 0ddddddd 0eeeeeee 0fffffff 0ggggggg
```

Header bit 6 = MSB of the first data byte, bit 5 the second, … bit 0 the
seventh. A short final group keeps its header (bits packed from the top);
missing trailing bytes are simply omitted. Encoded length = `n + ceil(n/7)`.
Implementation: `js/elektron/sevenbit.js` (elk-herd `ByteArray/SevenBit.elm`).

## Mechanism 1: the Elektron API (RPC)

Used for device identity, OS version, and +Drive file access. Also what
Elektron's Transfer app speaks.

```
F0 00 20 3C 10 00 <7-bit-encoded body> F7

body = uint16be msgId      sender's message id
       uint16be respId     0 in requests; the request's msgId in responses
       uint8    apiId      opcode — responses use request opcode + 0x80
       …                   opcode-specific args
```

No checksum, no length field. Strings are null-terminated Windows-1252.
elk-herd allocates msgIds from 20000 up (to stay clear of Transfer's own ids)
and uses a 5 s timeout with 2 retries — digi-roll does the same.

Opcodes digi-roll uses (`js/elektron/device.js`):

| opcode | name | response args |
|--------|------|---------------|
| `0x01` | Device | `productId:u8`, `count:u8` + that many supported-request ids, `deviceName:str0` |
| `0x02` | Version | `build:str0` (e.g. `"0065"`), `version:str0` (e.g. `"1.15A"`) |

Product ids: **12 = Digitakt, 42 = Digitakt II, 43 = Digitone II** (the DN2 id
is not in elk-herd — captured from real hardware with this console,
2026-08-01, on OS 1.10D build 0049). Version gating keys off the numeric
**build** string, not the human version.

DN2 identity capture notes: its supported-opcode list is
`01 02 03 04 06 07 09 50–5E` — the same dump-adjacent API opcodes the DT2
advertises, but **none of the +Drive file opcodes** (`0x10–0x13`, `0x17–0x19`,
`0x20–0x29`, `0x30–0x36`, `0x40–0x46`), consistent with having no sample
drive. Verified against a real DT2 (OS 1.15B build 0070): identity, version
and a full 16.3 MB whole-project backup all work as described here.

The full API also has +Drive file ops (DirList `0x10`, FileRead `0x30–0x32`,
FileWrite `0x40–0x42`, chunked at 8192 bytes, …) — not needed for Phase 1;
see elk-herd `SysEx/Message.elm` if we ever want sample management.

Note: Elektron boxes do **not** answer the universal MIDI identity request for
identification purposes here — the API above is the handshake.

## Mechanism 2: dump messages (patterns / sounds / project)

Transfers of the *currently loaded* project's contents.

```
F0 00 20 3C <family> 00 <type> 01 01 <index>
   <7-bit-encoded payload> <checksum:uint14be> <count:uint14be> F7
```

- `family` (byte 4): whose structs these are — `0x0A` Digitakt, `0x14`
  Digitakt II, `0x15` **Digitone II** (not in elk-herd — discovered
  2026-08-01 by sweeping candidate family bytes in `0x60` requests against a
  real DN2 on OS 1.10D; it answered `0x15` with a 114 kB pattern-kit response
  and ignored `0x0B–0x0E`, `0x14`, `0x16`).
- `01 01`: a 2-byte version field, always exactly `01 01` in elk-herd.
- `index`: pattern/sound slot (0-based); 0 for project-level messages.
- `checksum`: plain sum of the **encoded** payload bytes, mod 2^14, sent as
  two 7-bit bytes hi-then-lo.
- `count`: encoded-payload length + 5 (2 checksum bytes + 2 count bytes +
  the F7), mod 2^14.

Types (`0x5n` = responses carrying data, `0x6n` = requests, empty payload):

| type | meaning |
|------|---------|
| `0x50` / `0x60` | pattern + kit (one message, structs concatenated) |
| `0x51` / `0x61` | pattern |
| `0x52` / `0x62` | kit |
| `0x53` / `0x63` | sound (sound-pool slot) |
| `0x54` / `0x64` | project settings |
| `0x6F` | whole-project request |

**Whole-project fetch** (the "Backup project" button): send one `0x6F` request
(index 0, empty payload → trailer `00 00 00 05`). The box streams back `0x50`
pattern-kit responses (slots 0–127), then `0x53` sound responses for the sound
pool, then exactly **one `0x54` project-settings response — the only
end-of-stream marker there is**. Each object is one complete SysEx message,
however large; there is no segmentation protocol.

**Whole-project send** (later, for restore): there is no "write project"
request — you just send unsolicited dump *responses* (`0x50` per pattern,
`0x53` per sound slot, then `0x54`), pacing sends so the box can keep up
(elk-herd waits `size/bytesPerMs + 20` ms per message; 800 bytes/ms for DT2).

## Payload structs

Inside dump payloads: patterns start with a `uint32be` struct version; kits
and sounds are wrapped in magic `0xBEEFBACE`. Field offsets vary per struct
version and per device — elk-herd tabulates them in
`Elektron/Digitakt/CppStructs.elm`, keyed off the OS build string.

The Digitakt II pattern-kit payload is decoded (Phase 2): see
**`dt2-pattern-format.md`** for the full field map with per-field provenance,
and `js/elektron/dt2/pattern.js` for the decoder. The Digitone II payload is
decoded too (Phase 3, digi-roll's own reverse engineering — elk-herd has no
Digitone support): see **`dn2-pattern-format.md`** and
`js/elektron/dn2/pattern.js`. Both decoders are specs over the shared
`js/elektron/pattern-core.js`.

## Backup file format

The console's "Backup project" download is the raw concatenation of the dump
messages exactly as received (`.syx`) — replayable with any SysEx tool, and
the raw material for the Phase 3 diffing lab.
