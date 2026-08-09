import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDumpMessage, splitSysExStream, DUMP, FAMILY } from '../js/elektron/protocol.js';
import {
  buildCapturePair, parseCapturePair, bytesToBase64, base64ToBytes,
} from '../js/labs/capture-pair.js';

// A capture pair is the file a contributor posts to the forum: two raw dumps of
// one slot, before and after a single edit, plus what the edit was. It has to
// survive the trip through JSON/base64 byte-exact, and a malformed one has to
// fail with a message the *importer* can act on.

const FIXTURE = fileURLToPath(new URL('../dumps/digitakt2-project-2026-08-01T23-37-04.syx', import.meta.url));
const have = existsSync(FIXTURE);

const DEVICE = { name: 'Digitakt II', productId: 42, build: '0070', version: '1.15B', slug: 'digitakt2' };

function fixtureMessage() {
  const kits = splitSysExStream(new Uint8Array(readFileSync(FIXTURE)))
    .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);
  return buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.PATTERN_KIT, 0, kits[0].payload);
}

describe('base64', () => {
  it('round-trips bytes of every value, chunked past the apply() limit', () => {
    const bytes = new Uint8Array(70000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('buildCapturePair / parseCapturePair', () => {
  // Two synthetic captures of the same slot from an unmapped box, version
  // bytes deliberately non-standard — the raw framing must survive verbatim.
  function syntheticPair() {
    const mk = payload => {
      const raw = buildDumpMessage(0x1a, 0x51, 7, payload);
      raw[7] = 0x03; raw[8] = 0x02; // outside the checksum, part of the evidence
      return raw;
    };
    return {
      baselineRaw: mk(Uint8Array.of(1, 2, 3, 4)),
      afterRaw: mk(Uint8Array.of(1, 2, 9, 4)),
    };
  }

  it('round-trips a pair byte-exact, framing and all', () => {
    const { baselineRaw, afterRaw } = syntheticPair();
    const text = buildCapturePair({
      device: { name: 'Syntakt', productId: 47, build: '0012', version: '1.21', slug: 'elektron' },
      family: 0x1a, requestType: 0x61, index: 7,
      note: 'added trig, track 1, step 5',
      capturedAt: '2026-08-04T12:00:00.000Z',
      baselineRaw, afterRaw,
    });
    const pair = parseCapturePair(text);
    expect(pair.device.name).toBe('Syntakt');
    expect(pair.family).toBe(0x1a);
    expect(pair.requestType).toBe(0x61);
    expect(pair.index).toBe(7);
    expect(pair.note).toBe('added trig, track 1, step 5');
    expect(pair.baseline.raw).toEqual(baselineRaw);        // verbatim
    expect([pair.after.raw[7], pair.after.raw[8]]).toEqual([0x03, 0x02]); // odd version bytes kept
    expect([...pair.baseline.payload]).toEqual([1, 2, 3, 4]);
    expect([...pair.after.payload]).toEqual([1, 2, 9, 4]);
  });

  it.skipIf(!have)('carries a real 111,616-byte pattern without loss', () => {
    const a = fixtureMessage();
    const text = buildCapturePair({
      device: DEVICE, family: FAMILY.DIGITAKT_2, requestType: 0x60, index: 0,
      capturedAt: '2026-08-04T12:00:00.000Z', baselineRaw: a, afterRaw: a,
    });
    const pair = parseCapturePair(text);
    expect(pair.baseline.raw).toEqual(a);
    expect(pair.baseline.payload.length).toBe(111616);
  });

  it('normalises a missing or hand-edited device block to safe strings', () => {
    // Donations are hand-edited; a pair with no device block once put
    // undefineds into the diff lab's notebook and kept the page from booting.
    const { baselineRaw, afterRaw } = syntheticPair();
    const text = buildCapturePair({
      device: {}, family: 0x1a, requestType: 0x61, index: 7, baselineRaw, afterRaw,
    });
    const stripped = JSON.parse(text);
    delete stripped.device;
    const pair = parseCapturePair(JSON.stringify(stripped));
    expect(pair.device).toEqual({
      name: 'unknown device', build: '', version: '', slug: '', productId: null,
    });
    // Junk values coerce rather than smuggle non-strings downstream.
    const junk = { ...JSON.parse(text), device: { name: 5, build: { odd: true } } };
    expect(parseCapturePair(JSON.stringify(junk)).device)
      .toMatchObject({ name: 'unknown device', build: '' });
  });

  it('rejects a file that is not a pair, saying why', () => {
    expect(() => parseCapturePair('not json')).toThrow(/not a JSON file/);
    expect(() => parseCapturePair('{"kind":"something else"}')).toThrow(/not a digi-roll capture pair/);
    expect(() => parseCapturePair(JSON.stringify({ kind: 'digi-roll capture pair', version: 99 })))
      .toThrow(/version 99/);
  });

  it('rejects a corrupt capture instead of diffing garbage', () => {
    const { baselineRaw, afterRaw } = (() => {
      const mk = p => buildDumpMessage(0x1a, 0x51, 7, p);
      return { baselineRaw: mk(Uint8Array.of(1)), afterRaw: mk(Uint8Array.of(2)) };
    })();
    const damaged = Uint8Array.from(afterRaw);
    damaged[11] ^= 0x01; // flip a payload bit → checksum mismatch
    const text = buildCapturePair({
      device: DEVICE, family: 0x1a, requestType: 0x61, index: 7,
      capturedAt: 'x', baselineRaw, afterRaw: damaged,
    });
    expect(() => parseCapturePair(text)).toThrow(/after capture is corrupt/);
  });

  it('rejects a pair whose two sides watched different slots', () => {
    const text = buildCapturePair({
      device: DEVICE, family: 0x1a, requestType: 0x61, index: 7, capturedAt: 'x',
      baselineRaw: buildDumpMessage(0x1a, 0x51, 7, Uint8Array.of(1)),
      afterRaw: buildDumpMessage(0x1a, 0x51, 8, Uint8Array.of(1)),
    });
    expect(() => parseCapturePair(text)).toThrow(/not of the same slot/);
  });
});
