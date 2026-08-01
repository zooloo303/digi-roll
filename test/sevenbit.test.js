import { describe, it, expect } from 'vitest';
import { encode7, decode7 } from '../js/elektron/sevenbit.js';

// Deterministic bytes so failures reproduce.
function pseudoRandomBytes(len, seed = 1) {
  const out = new Uint8Array(len);
  let s = seed;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
}

describe('encode7', () => {
  it('packs high bits into a leading header byte, MSB of first byte at bit 6', () => {
    expect([...encode7([0x80])]).toEqual([0x40, 0x00]);
    expect([...encode7([0x00, 0xff])]).toEqual([0x20, 0x00, 0x7f]);
    expect([...encode7([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])])
      .toEqual([0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f]);
  });

  it('emits only 7-bit-safe bytes', () => {
    for (const b of encode7(pseudoRandomBytes(100))) expect(b).toBeLessThan(0x80);
  });

  it('encoded length is len + ceil(len/7)', () => {
    for (const len of [0, 1, 6, 7, 8, 13, 14, 15, 700]) {
      expect(encode7(new Uint8Array(len)).length).toBe(len + Math.ceil(len / 7));
    }
  });
});

describe('round trip', () => {
  it('decode7(encode7(x)) === x for every length 0–40', () => {
    for (let len = 0; len <= 40; len++) {
      const data = pseudoRandomBytes(len, len + 1);
      expect([...decode7(encode7(data))]).toEqual([...data]);
    }
  });

  it('survives all-0x00, all-0x7f, all-0x80, all-0xff payloads', () => {
    for (const fill of [0x00, 0x7f, 0x80, 0xff]) {
      const data = new Uint8Array(23).fill(fill);
      expect([...decode7(encode7(data))]).toEqual([...data]);
    }
  });
});

describe('decode7', () => {
  it('rejects a trailing lone header byte', () => {
    expect(() => decode7(new Uint8Array(9))).toThrow();
    expect(() => decode7(new Uint8Array(1))).toThrow();
  });
});
