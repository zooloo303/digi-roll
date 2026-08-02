import { describe, it, expect } from 'vitest';
import { ElektronDevice } from '../js/elektron/device.js';
import { buildApiMessage, buildDumpMessage, parseSysEx, API, DUMP, FAMILY } from '../js/elektron/protocol.js';

const ascii = s => [...s].map(c => c.charCodeAt(0));

// Minimal fake of a paired MIDI input/output: whatever `respond` returns for a
// sent message is delivered straight back through the input.
function fakePorts(respond) {
  const input = {
    handlers: new Set(),
    addEventListener(type, fn) { this.handlers.add(fn); },
    removeEventListener(type, fn) { this.handlers.delete(fn); },
    deliver(bytes) { for (const fn of this.handlers) fn({ data: Uint8Array.from(bytes) }); },
  };
  const output = { send(bytes) { for (const reply of respond(parseSysEx(bytes)) ?? []) input.deliver(reply); } };
  return { input, output };
}

function fakeDigitakt2(overrides = {}) {
  return fakePorts(msg => {
    if (msg.kind === 'api' && msg.apiId === API.DEVICE) {
      const supported = [0x10, 0x11, 0x12, 0x20, 0x21];
      return [buildApiMessage(1, API.DEVICE + API.RESPONSE,
        [42, supported.length, ...supported, ...ascii('Digitakt II'), 0], msg.msgId)];
    }
    if (msg.kind === 'api' && msg.apiId === API.VERSION) {
      return [buildApiMessage(2, API.VERSION + API.RESPONSE,
        [...ascii('0065'), 0, ...ascii('1.15A'), 0], msg.msgId)];
    }
    if (msg.kind === 'dump' && msg.type === DUMP.WHOLE_PROJECT_REQUEST) {
      return overrides.projectStream ?? [
        buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.PATTERN_KIT, 0, Uint8Array.of(1, 2, 3)),
        buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.PATTERN_KIT, 1, Uint8Array.of(4, 5, 6)),
        buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.SOUND, 0, Uint8Array.of(7)),
        buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.PROJECT_SETTINGS, 0, Uint8Array.of(8, 9)),
      ];
    }
  });
}

describe('identify', () => {
  it('reads product, name, build and version from the Elektron API', async () => {
    const { input, output } = fakeDigitakt2();
    const dev = new ElektronDevice(input, output);
    const id = await dev.identify();
    expect(id).toMatchObject({
      productId: 42,
      name: 'Digitakt II',
      slug: 'digitakt2',
      family: FAMILY.DIGITAKT_2,
      build: '0065',
      version: '1.15A',
      supported: true,
    });
    dev.close();
  });

  it('reports unknown products as unsupported but still named', async () => {
    const { input, output } = fakePorts(msg => {
      if (msg.kind !== 'api') return;
      if (msg.apiId === API.DEVICE) {
        return [buildApiMessage(1, API.DEVICE + API.RESPONSE, [99, 0, ...ascii('Mysterybox'), 0], msg.msgId)];
      }
      return [buildApiMessage(2, API.VERSION + API.RESPONSE, [...ascii('0001'), 0, ...ascii('9.99'), 0], msg.msgId)];
    });
    const dev = new ElektronDevice(input, output);
    const id = await dev.identify();
    expect(id.supported).toBe(false);
    expect(id.family).toBe(null);
    expect(id.name).toBe('Mysterybox');
    expect(() => dev.fetchProjectDump()).toThrow(/no known dump protocol/);
    dev.close();
  });

  it('knows the Digitone II, dump family 0x15', async () => {
    // Product id 43, OS strings and family byte all captured from real
    // hardware, 2026-08-01 (the family via a 0x60 probe sweep — Phase 3).
    const { input, output } = fakePorts(msg => {
      if (msg.kind !== 'api') return;
      if (msg.apiId === API.DEVICE) {
        return [buildApiMessage(1, API.DEVICE + API.RESPONSE, [43, 0, ...ascii('Digitone II'), 0], msg.msgId)];
      }
      return [buildApiMessage(2, API.VERSION + API.RESPONSE, [...ascii('0049'), 0, ...ascii('1.10D'), 0], msg.msgId)];
    });
    const dev = new ElektronDevice(input, output);
    const id = await dev.identify();
    expect(id).toMatchObject({ productId: 43, name: 'Digitone II', slug: 'digitone2', family: 0x15, supported: true });
    dev.close();
  });
});

describe('fetchProjectDump', () => {
  it('collects the stream until project settings and returns the raw bytes', async () => {
    const { input, output } = fakeDigitakt2();
    const dev = new ElektronDevice(input, output);
    await dev.identify();

    const progress = [];
    const dump = await dev.fetchProjectDump(n => progress.push(n));
    expect(progress).toEqual([1, 2, 3, 4]);

    // The backup is the concatenation of the four raw messages.
    let f7s = 0;
    for (const b of dump) if (b === 0xf7) f7s++;
    expect(f7s).toBe(4);
    expect(dump[0]).toBe(0xf0);
    expect(dump[dump.length - 1]).toBe(0xf7);
    dev.close();
  });

  it('aborts the backup on a corrupt message instead of saving bad data', async () => {
    const bad = buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.PATTERN_KIT, 0, Uint8Array.of(1, 2, 3));
    bad[11] ^= 0x01; // flip a payload bit → checksum mismatch
    const { input, output } = fakeDigitakt2({ projectStream: [bad] });
    const dev = new ElektronDevice(input, output);
    await dev.identify();
    await expect(dev.fetchProjectDump()).rejects.toThrow(/corrupt/);
    dev.close();
  });

  it('ignores dumps from other devices on the same port', async () => {
    const { input, output } = fakeDigitakt2({
      projectStream: [
        buildDumpMessage(FAMILY.DIGITAKT, DUMP.PROJECT_SETTINGS, 0, Uint8Array.of(1)), // wrong family — not our stream
        buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.PROJECT_SETTINGS, 0, Uint8Array.of(2)),
      ],
    });
    const dev = new ElektronDevice(input, output);
    await dev.identify();
    const dump = await dev.fetchProjectDump();
    expect(parseSysEx(dump).family).toBe(FAMILY.DIGITAKT_2);
    dev.close();
  });
});
