// Elektron SysEx message framing.
//
// Elektron boxes speak two unrelated SysEx mechanisms, both starting with the
// manufacturer header F0 00 20 3C and diverging at byte 4:
//
//   API message (RPC request/response — device info, +Drive file access):
//     F0 00 20 3C 10 00 <7-bit-encoded body> F7
//     body = uint16be msgId, uint16be respId (0 in requests, else the msgId
//     being answered), uint8 apiId, then opcode-specific args.
//     Response apiId = request apiId + 0x80. No checksum, no length field.
//
//   Dump message (pattern/sound/project transfers):
//     F0 00 20 3C <family> 00 <type> 01 01 <index>
//        <7-bit-encoded payload> <cksum uint14be> <count uint14be> F7
//     checksum = sum of the *encoded* payload bytes, mod 2^14;
//     count = encoded-payload length + 5 (the 4 trailer bytes + F7), mod 2^14.
//
// Byte-level format ported from elk-herd (BSD-2-Clause, © mzero):
// src/SysEx/SysEx.elm, src/SysEx/Dump.elm, src/SysEx/ApiUtil.elm.

import { encode7, decode7 } from './sevenbit.js';

export const ELEKTRON_ID = [0x00, 0x20, 0x3c];
const API_TAG = 0x10;

// API opcodes. Responses come back as request opcode + 0x80.
export const API = {
  DEVICE: 0x01,   // → productId, supported-request list, device name
  VERSION: 0x02,  // → build string, version string
  RESPONSE: 0x80,
};

// Dump message types: 0x5n are responses/payloads, 0x6n are requests.
export const DUMP = {
  PATTERN_KIT: 0x50,
  PATTERN: 0x51,
  KIT: 0x52,
  SOUND: 0x53,
  PROJECT_SETTINGS: 0x54,
  PATTERN_KIT_REQUEST: 0x60,
  PATTERN_REQUEST: 0x61,
  KIT_REQUEST: 0x62,
  SOUND_REQUEST: 0x63,
  PROJECT_SETTINGS_REQUEST: 0x64,
  WHOLE_PROJECT_REQUEST: 0x6f,
};

// Dump family codes (SysEx byte 4) — which device's structs a dump carries.
// DIGITONE_2 is not in elk-herd: discovered 2026-08-01 by probing a real DN2
// (OS 1.10D) with 0x60 requests across candidate bytes — only 0x15 answered.
// DIGITONE (the DN1) is elk-herd's published Digitakt-family value; confirmed
// against real DN1 captures 2026-08-13 (see docs/dn1-support-plan.md §1).
export const FAMILY = {
  DIGITAKT: 0x0a,
  DIGITAKT_2: 0x14,
  DIGITONE: 0x0d,
  DIGITONE_2: 0x15,
};

export function checksum14(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  return sum & 0x3fff;
}

const uint14be = v => [(v >> 7) & 0x7f, v & 0x7f];

export function buildApiMessage(msgId, apiId, args = [], respId = 0) {
  const body = new Uint8Array(5 + args.length);
  body[0] = (msgId >> 8) & 0xff;
  body[1] = msgId & 0xff;
  body[2] = (respId >> 8) & 0xff;
  body[3] = respId & 0xff;
  body[4] = apiId;
  body.set(args, 5);
  return Uint8Array.from([0xf0, ...ELEKTRON_ID, API_TAG, 0x00, ...encode7(body), 0xf7]);
}

export function buildDumpMessage(family, type, index, payload = new Uint8Array(0)) {
  const encoded = encode7(payload);
  return Uint8Array.from([
    0xf0, ...ELEKTRON_ID, family, 0x00, type, 0x01, 0x01, index,
    ...encoded,
    ...uint14be(checksum14(encoded)),
    ...uint14be((encoded.length + 5) & 0x3fff),
    0xf7,
  ]);
}

// Split a byte stream of concatenated SysEx messages (a .syx backup file, or
// a captured dump stream) into parsed messages. Anything outside F0…F7 frames
// is ignored.
export function splitSysExStream(bytes) {
  const messages = [];
  let start = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xf0) start = i;
    else if (bytes[i] === 0xf7 && start >= 0) {
      messages.push(parseSysEx(bytes.subarray(start, i + 1)));
      start = -1;
    }
  }
  return messages;
}

// Parse one complete SysEx message (F0…F7 inclusive). Never throws on foreign
// or malformed data — returns { kind: 'foreign' | 'unknown' | 'api' | 'dump' }
// so the console can log anything a device sends us.
export function parseSysEx(bytes) {
  if (bytes.length < 6 || bytes[0] !== 0xf0 ||
      bytes[1] !== ELEKTRON_ID[0] || bytes[2] !== ELEKTRON_ID[1] || bytes[3] !== ELEKTRON_ID[2]) {
    return { kind: 'foreign' };
  }

  if (bytes[4] === API_TAG && bytes[5] === 0x00) {
    let body;
    try { body = decode7(bytes.subarray(6, bytes.length - 1)); } catch { return { kind: 'unknown' }; }
    if (body.length < 5) return { kind: 'unknown' };
    return {
      kind: 'api',
      msgId: (body[0] << 8) | body[1],
      respId: (body[2] << 8) | body[3],
      apiId: body[4],
      args: body.subarray(5),
    };
  }

  if (bytes[5] === 0x00 && bytes.length >= 15) {
    const encoded = bytes.subarray(10, bytes.length - 5);
    let payload;
    try { payload = decode7(encoded); } catch { return { kind: 'unknown' }; }
    const checksum = (bytes[bytes.length - 5] << 7) | bytes[bytes.length - 4];
    const count = (bytes[bytes.length - 3] << 7) | bytes[bytes.length - 2];
    return {
      kind: 'dump',
      family: bytes[4],
      type: bytes[6],
      version: [bytes[7], bytes[8]],
      index: bytes[9],
      payload,
      checksumOk: checksum14(encoded) === (checksum & 0x3fff),
      countOk: ((encoded.length + 5) & 0x3fff) === (count & 0x3fff),
    };
  }

  return { kind: 'unknown' };
}
