import { describe, it, expect } from 'vitest';
import {
  buildApiMessage, buildDumpMessage, parseSysEx, checksum14, API, DUMP, FAMILY,
} from '../js/elektron/protocol.js';

describe('dump messages', () => {
  it('whole-project request for a Digitakt II matches the known wire bytes', () => {
    // Empty payload → checksum 0, count 5 (elk-herd src/SysEx/Dump.elm).
    expect([...buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.WHOLE_PROJECT_REQUEST, 0)])
      .toEqual([0xf0, 0x00, 0x20, 0x3c, 0x14, 0x00, 0x6f, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x05, 0xf7]);
  });

  it('round-trips a payload through build → parse', () => {
    const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) & 0xff);
    const msg = parseSysEx(buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.PATTERN_KIT, 42, payload));
    expect(msg.kind).toBe('dump');
    expect(msg.family).toBe(FAMILY.DIGITAKT_2);
    expect(msg.type).toBe(DUMP.PATTERN_KIT);
    expect(msg.index).toBe(42);
    expect(msg.version).toEqual([1, 1]);
    expect(msg.checksumOk).toBe(true);
    expect(msg.countOk).toBe(true);
    expect([...msg.payload]).toEqual([...payload]);
  });

  it('flags a corrupted payload byte via the checksum', () => {
    const wire = buildDumpMessage(FAMILY.DIGITAKT, DUMP.SOUND, 3, new Uint8Array(50).fill(0x55));
    wire[20] ^= 0x01;
    expect(parseSysEx(wire).checksumOk).toBe(false);
  });

  it('flags a truncated payload via the count', () => {
    const wire = buildDumpMessage(FAMILY.DIGITAKT, DUMP.SOUND, 3, new Uint8Array(50).fill(0x55));
    const cut = Uint8Array.from([...wire.slice(0, 18), ...wire.slice(26)]); // drop one 8-byte group
    expect(parseSysEx(cut).countOk).toBe(false);
  });

  it('parses dumps from unknown family bytes (future Digitone II captures)', () => {
    const msg = parseSysEx(buildDumpMessage(0x15, DUMP.PATTERN_KIT, 0, Uint8Array.of(1, 2, 3)));
    expect(msg.kind).toBe('dump');
    expect(msg.family).toBe(0x15);
    expect(msg.checksumOk).toBe(true);
  });
});

describe('API messages', () => {
  it('round-trips id, opcode and args through build → parse', () => {
    const args = Uint8Array.of(0x00, 0x80, 0xff, 0x12);
    const msg = parseSysEx(buildApiMessage(20000, API.DEVICE, args));
    expect(msg.kind).toBe('api');
    expect(msg.msgId).toBe(20000);
    expect(msg.respId).toBe(0);
    expect(msg.apiId).toBe(API.DEVICE);
    expect([...msg.args]).toEqual([...args]);
  });

  it('carries respId for responses', () => {
    const msg = parseSysEx(buildApiMessage(7, API.VERSION + API.RESPONSE, [], 20001));
    expect(msg.respId).toBe(20001);
    expect(msg.apiId).toBe(API.VERSION + API.RESPONSE);
  });

  it('keeps every wire byte 7-bit-safe between F0 and F7', () => {
    const wire = buildApiMessage(0xabcd, API.DEVICE, Uint8Array.of(0xff, 0xfe));
    for (const b of wire.subarray(1, wire.length - 1)) expect(b).toBeLessThan(0x80);
  });
});

describe('parseSysEx guard rails', () => {
  it('marks non-Elektron traffic as foreign', () => {
    expect(parseSysEx(Uint8Array.of(0xf0, 0x7e, 0x00, 0x06, 0x02, 0xf7)).kind).toBe('foreign');
  });

  it('never throws on garbage', () => {
    expect(parseSysEx(Uint8Array.of(0xf0, 0x00, 0x20, 0x3c, 0x10, 0x00, 0x7f, 0xf7)).kind).toBe('unknown');
    expect(parseSysEx(Uint8Array.of(0xf0, 0x00, 0x20, 0x3c, 0x0a, 0x00, 0xf7)).kind).toBe('unknown');
  });
});

describe('checksum14', () => {
  it('sums wire bytes mod 2^14', () => {
    expect(checksum14([1, 2, 3])).toBe(6);
    expect(checksum14(new Uint8Array(0x3fff).fill(2))).toBe((0x3fff * 2) & 0x3fff);
  });
});
