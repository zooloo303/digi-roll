# The Elektron +Drive file API

Reference material, not yet implemented anywhere in digi-roll. Nothing here
changes what Phases 1–4 ship, and nothing here touches the dump-message
mechanism (`docs/elektron-sysex-protocol.md`'s "Mechanism 2") that the pattern
decoders are built on — this is a **third**, unrelated SysEx surface, layered
on top of the same **API** mechanism (`F0 00 20 3C 10 00 …`) that `device.js`
already uses for identity and version.

Contributed 2026-08-14 by DNX, a sibling project independently
reverse-engineering the Digitone family, after we asked them to double-check
a claim in `elektron-sysex-protocol.md` that turned out to be wrong (see
below). Everything here is either measured on real hardware or read off a USB
capture of Elektron's own Transfer application — nothing is inferred from
elk-herd, which has no Digitone support and whose gen-1 file-opcode numbering
(`0x10–0x13`, `0x30–0x36`, `0x40–0x46`) turns out to be a *different*
numbering for the same feature, not the numbering this document describes.

## The headline: two namespaces, one byte value

**The DN2 (and the DN1) do have a +Drive file API.** `elektron-sysex-protocol.md`
used to read the DN2's advertised opcode list (`50–5E`, from the API's
`Device` response) as the *absence* of elk-herd's gen-1 file opcodes, and
concluded "no sample drive". That absence reasoning was the mistake — `50–5E`
in the `Device` response is a **second, renumbered file API**, not a gap.

The trap, stated as plainly as possible: `0x53` means two completely
different things depending on which header carries it.

| header | byte 4 | `0x53` means |
|---|---|---|
| dump (`F0 00 20 3C <family> 00 …`) | family byte (`0x0A` DT, `0x14` DT2, `0x15` DN2, …) | **Sound dump** — a payload, per `elektron-sysex-protocol.md`'s dump-type table |
| API (`F0 00 20 3C 10 00 …`) | always `0x10` | **List** — a +Drive directory listing, empty body |

A box advertising both the gen-1 numbering *and* `50–5E` in `Device` is —
per elk-herd and other Digitakt/Digitone reverse-engineering references —
thought to be reaching the same file API two ways, rather than advertising
two unrelated feature sets. That would also explain why a DT2 capture shows
both: not evidence of some "II-series" opcode band, but the ordinary overlap
of an old and a new numbering for one API. **This part is unverified against
a DT2 directly** — no DT2 was available to confirm its `50–5E` opcodes
actually answer as this file API. §3/§4 below are the parts measured on real
hardware; this paragraph is not.

## 1. Raw bytes, before 7-bit decoding

### A `0x53` (List) request — Elektron Transfer's own, off a USB capture

```
f0 00 20 3c 10 00 20 00 7f 00 00 53 2f 70 00 72 6f 6a 65 63 74 73 00 00 00 00 00 07 00 00 00 00 08 00 f7
```

Decoded: `msgId 255`, `respId` absent (a request), `code 0x53`, a 19-byte body:

```
2f 70 72 6f 6a 65 63 74 73 00   "/projects\0"   NUL-terminated path
00 00 00 07                      u32be           start index = 7
00 00 00 08                      u32be           count = 8
```

The whole-listing form, same capture, is identical with both `u32`s zero:

```
f0 00 20 3c 10 00 20 03 38 00 00 53 2f 70 00 72 6f 6a 65 63 74 73 00 00 00 00 00 00 00 00 00 00 00 00 f7
```

**A paging caution.** `start = 0, count = 0` returns everything, but a
non-zero `start` not handed back by a previous reply returned **0 entries** on
both `/soundbanks/H` (236 entries) and `/kits/A` (96 entries). Paging looks
like it wants the cursor the previous reply gave, not an arbitrary index.

### Two `0x53` responses, both free of anyone's names

The error form:

```
f0 00 20 3c 10 00 04 00 07 75 30 53 00 49 00 6e 76 61 6c 69 64 20 00 70 61 74 68 00 f7
```

`msgId 7`, `respId 30000`, `code 0xD3` (= `0x53 + 0x80`, see §5), body
`00 "Invalid path\0"` — a **leading status byte**, `0x00` for failure, then a
NUL-terminated message.

An empty listing:

```
f0 00 20 3c 10 00 04 00 42 75 30 53 01 00 00 00 00 1c 00 00 00 1c 00 00 00 00 00 f7
```

body `01 | 00 00 00 1c | 00 00 00 1c | 00 00 00 00`:

```
01            status, 0x01 = ok
00 00 00 1c   u32be   start echoed (28)
00 00 00 1c   u32be   next cursor (28)
00 00 00 00   u32be   entry count (0)
```

A populated reply continues with that many entries — not captured here on
purpose, since they'd carry someone's actual project and preset names.

### Entry layout, for a populated reply

Two layouts, distinguished by a per-entry byte. The long form (files and bank
directories) ends in 12 bytes:

```
u32be index
u32be size            constant across a collection; a bank directory's is a fixed allocation
u16be permissions
u8 u8                 occupancy pair — 01 01 occupied, 00 01 empty on kits
```

Read occupancy from **the pair**, not one byte — a single-byte read was
mistaken for a tag mask once. `00 01` for empty is worth noting explicitly:
it is not `00 00` on every collection type.

## 2. The opcode map

All under `F0 00 20 3C 10 00 <7-bit payload> F7` — the same API mechanism
`device.js`'s `API.DEVICE` (`0x01`) and `API.VERSION` (`0x02`) already use.

| code | name | notes |
|---|---|---|
| `0x53` | **List** | directory listing; answers `Invalid path` on a bad one |
| `0x54` | **Open** | open a file for reading |
| `0x55` | **Read** | read a chunk by sequence number |
| `0x56` | **Close** | close the reader; its reply carries the file's total length |
| `0x57` | **WriteOpen** | open for writing, declaring the total length up front |
| `0x58` | **Write** | write a chunk |
| `0x59` | **WriteClose** | close the writer — **this is the commit**; nothing lands without it |
| `0x5A` | **Move** | source and destination paths, both with a trailing slash |
| `0x5B` | **Copy** | same arguments as a move |
| `0x5C` | **Delete** | one path, trailing slash |

`0x5D`/`0x5E` are unidentified.

## 3. Which boxes and which builds

| | product id (API space) | OS / build | lists | reads | writes |
|---|---|---|---|---|---|
| Digitone II | 43 | 1.10E / 0050 | yes | yes | yes, single-chunk only — see §6 |
| Digitone 1 | 20 | 1.42A / 0097 | yes | yes | not tried |

Product id 43 matches what `device.js`'s own capture recorded (build `0049`,
OS 1.10D) — a different build, same product id, so at least that hasn't moved
between the two.

No Digitakt II was available to confirm this file API on that box.

## 4. Not a "II-series" API — the DN1 answers it too

Worth stating because it's the opposite of what the advertised-opcode framing
suggested: the **Digitone 1** (gen-1, OS 1.42A) lists its +Drive and reads
whole projects off it through these same `0x53`/`0x54`–`0x56` opcodes. A
project has been read off a DN1 slot and opened this way.

So `0x53`–`0x5C` spans both Digitone generations. Whatever elk-herd's
`0x10`/`0x30`/`0x40` numbering represents, "the gen-2 file API" isn't it.

## 5. Responses are request + `0x80`, same as the rest of the API

It holds without exception: `0x53` → `0xD3` in the raw bytes above, and every
code in §2's table follows the same rule — `device.js`'s existing
`API.RESPONSE = 0x80` convention for `Device`/`Version` applies here
unchanged. The file API doesn't carve out an exception.

The reply also echoes the request's `msgId` back as `respId`, which is the
match key — same as `device.js`'s own `_pending` map keys on `respId`. The
two samples above show `respId 30000` because that probe allocated ids from a
30000 band; Transfer itself numbers from the low hundreds (`255`, `952` seen
in the capture). Worth keeping digi-roll's own id band (20000+, chosen to stay
clear of Transfer) in mind if this is ever implemented alongside a live
Transfer session.

## 6. Before implementing writes: chunking is unresolved

**Only a single-chunk write has ever succeeded**, on a real DN2. Every
multi-chunk attempt on the exact same 10,795-byte kit, into the same empty
target slot, failed:

| chunks | chunk size | checksum declared | result |
|---|---|---|---|
| 6 | 2,048 | each chunk's own | `Invalid package checksum; corrupt transfer` |
| 6 | 2,048 | the whole file's | `Invalid package checksum; corrupt transfer` |
| 2 | 8,192 | the whole file's | `Invalid package checksum; corrupt transfer` |
| **1** | 16,384 | the whole file's | **committed, and read back byte-exact** |

8,192 was tried specifically because it's elk-herd's `FileWrite` chunk size on
the gen-1 numbering; it's refused here exactly as 2,048 is. **The chunk count
is the variable that matters, not the size and not which checksum is sent** —
something about a continuation `0x58` is wrong in a way this hasn't isolated.
A capture of Transfer itself writing a file larger than one chunk would settle
it and hasn't been taken yet.

The checksum is `crc32` seeded with **zero**, not the more common all-ones
seed, and it is enforced — a wrong value is refused rather than ignored. On a
**read**, the device reports one checksum per chunk and it reproduces cleanly
per-slice; on a **write**, those same per-chunk values are refused. Reads and
writes don't use the checksum field the same way — worth remembering before
assuming a read-path checksum routine also covers writes.

One more container detail: the device stamps a stored kit's own slot index
into container byte `+24`, zero-based. Copying `/kits/A/1` verbatim to
`/kits/A/38` reads back differing in exactly that one byte of 10,795 bytes —
expected, not corruption, if this is ever used for a round-trip check.

**If this API is ever wired into digi-roll**, CLAUDE.md's five safe-write
rules apply here exactly as they do to pattern writes — and given the section
above, rule 4 (verify after write) is doing real work: a chunking bug that
silently truncated or corrupted a multi-chunk file is exactly the failure mode
a byte-compare read-back would catch before anyone trusted it.

## Corrections owed, named rather than quietly fixed

- This repo's `elektron-sysex-protocol.md` concluded "the DN2 has no +Drive
  file API" from the advertised-opcode list alone. It was wrong, and it stood
  until DNX's own hardware use of the API contradicted it — the correction
  is now in that file, pointing here.
- DNX's own listing decoder had the same shape of bug the other way: its
  comment claimed empty slots read `00 00`; kits read `00 01`. The occupancy
  *pair* compare in §1 gives the right answer regardless, but the documented
  model was incomplete until this was checked.

Both mistakes came from the same root cause: reading an absence, or a single
sampled byte, as the whole story instead of checking it against a wider
capture. Worth remembering the next time either project is tempted to.
