import { describe, it, expect } from 'vitest';
import { ElektronDevice, slugFromPortName } from '../js/elektron/device.js';
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

// The generic dump fetch and the probe are the contributor-facing primitives:
// they are what lets someone with a box digi-roll has never met capture real
// bytes for us. Read-only is structural here, not a convention — anything that
// isn't a request opcode is refused before a byte is sent.
describe('fetchDump', () => {
  // An unknown box speaking a not-quite-standard framing: version bytes that
  // aren't buildDumpMessage's 0x01 0x01. The capture must keep them.
  function fakeUnknownBox() {
    return fakePorts(msg => {
      if (msg.kind !== 'dump' || msg.family !== 0x1a || msg.type !== 0x61) return;
      const reply = buildDumpMessage(0x1a, 0x51, msg.index, Uint8Array.of(9, 8, 7));
      reply[7] = 0x03; reply[8] = 0x02; // version bytes are outside the checksum
      return [reply];
    });
  }

  it('fetches any dump type from any family, no identity needed', async () => {
    const { input, output } = fakeUnknownBox();
    const dev = new ElektronDevice(input, output);
    const { payload, msg } = await dev.fetchDump(0x1a, 0x61, 3);
    expect([...payload]).toEqual([9, 8, 7]);
    expect(msg).toMatchObject({ family: 0x1a, type: 0x51, index: 3 });
    dev.close();
  });

  it('keeps the raw message exactly as the box sent it — version bytes included', async () => {
    const { input, output } = fakeUnknownBox();
    const dev = new ElektronDevice(input, output);
    const { raw } = await dev.fetchDump(0x1a, 0x61, 0);
    expect(raw[0]).toBe(0xf0);
    expect(raw[raw.length - 1]).toBe(0xf7);
    expect([raw[7], raw[8]]).toEqual([0x03, 0x02]); // not normalised to 0x01 0x01
    dev.close();
  });

  it('refuses to send anything that is not a request opcode', () => {
    const { input, output } = fakeUnknownBox();
    const dev = new ElektronDevice(input, output);
    // 0x51 is a dump *payload* — sending one is what writes to a box.
    expect(() => dev.fetchDump(0x1a, 0x51, 0)).toThrow(/not a dump request opcode/);
    expect(() => dev.fetchDump(0x1a, 0x50, 0)).toThrow(/refusing/);
    dev.close();
  });

  it('still serves fetchPatternKit, byte for byte', async () => {
    const { input, output } = fakePorts(msg => {
      if (msg.kind === 'api' && msg.apiId === API.DEVICE) {
        return [buildApiMessage(1, API.DEVICE + API.RESPONSE, [42, 0, ...ascii('Digitakt II'), 0], msg.msgId)];
      }
      if (msg.kind === 'api') {
        return [buildApiMessage(2, API.VERSION + API.RESPONSE, [...ascii('0070'), 0, ...ascii('1.15B'), 0], msg.msgId)];
      }
      if (msg.kind === 'dump' && msg.type === DUMP.PATTERN_KIT_REQUEST) {
        return [buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.PATTERN_KIT, msg.index, Uint8Array.of(1, 2, 3, 4))];
      }
    });
    const dev = new ElektronDevice(input, output);
    await dev.identify();
    expect([...await dev.fetchPatternKit(5)]).toEqual([1, 2, 3, 4]);
    dev.close();
  });
});

describe('probeDumpRequests', () => {
  // A box that answers exactly one family byte, like the real DN2 sweep found.
  const fakeShyBox = () => fakePorts(msg => {
    if (msg.kind !== 'dump' || msg.family !== 0x1a) return;
    if (msg.type === 0x61) return [buildDumpMessage(0x1a, 0x51, msg.index, new Uint8Array(64))];
    if (msg.type === 0x62) return [buildDumpMessage(0x1a, 0x52, msg.index, new Uint8Array(16))];
  });

  it('reports which requests answered, attributed by the reply itself', async () => {
    const { input, output } = fakeShyBox();
    const dev = new ElektronDevice(input, output);
    const findings = await dev.probeDumpRequests([
      { family: 0x14, type: 0x60, index: 0 }, // silence
      { family: 0x1a, type: 0x60, index: 0 }, // silence — this box splits pattern and kit
      { family: 0x1a, type: 0x61, index: 0 },
      { family: 0x1a, type: 0x62, index: 0 },
    ], { paceMs: 0, settleMs: 25 });
    expect(findings.map(f => [f.family, f.type, f.bytes])).toEqual([
      [0x1a, 0x51, 64],
      [0x1a, 0x52, 16],
    ]);
    expect(findings.every(f => f.ok)).toBe(true);
    dev.close();
  });

  it('resolves empty when nothing answers, rather than hanging or throwing', async () => {
    const { input, output } = fakePorts(() => undefined);
    const dev = new ElektronDevice(input, output);
    expect(await dev.probeDumpRequests([{ family: 0x22, type: 0x60, index: 0 }], { paceMs: 0, settleMs: 25 }))
      .toEqual([]);
    dev.close();
  });

  it('refuses a plan containing anything but request opcodes', async () => {
    const { input, output } = fakeShyBox();
    const dev = new ElektronDevice(input, output);
    await expect(dev.probeDumpRequests([
      { family: 0x1a, type: 0x61, index: 0 },
      { family: 0x1a, type: 0x51, index: 0 }, // a payload message — would write
    ])).rejects.toThrow(/not a dump request opcode/);
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

// Recognising a box from its MIDI port name, for the UI decisions that have to be
// made before any SysEx handshake — which box's p-lock parameters to offer, in
// particular. The names are the ones the Device response reports, which is what
// the ports are called too.
describe('slugFromPortName', () => {
  it('recognises the two boxes digi-roll writes to', () => {
    expect(slugFromPortName('Elektron Digitakt II')).toBe('digitakt2');
    expect(slugFromPortName('Elektron Digitone II')).toBe('digitone2');
  });

  it('is case- and decoration-insensitive, as port names vary by OS', () => {
    expect(slugFromPortName('elektron digitone ii')).toBe('digitone2');
    expect(slugFromPortName('Digitakt II MIDI 1')).toBe('digitakt2');
    expect(slugFromPortName('Elektron Digitakt II Port 1 (USB)')).toBe('digitakt2');
  });

  it('does not mistake a gen-1 Digitakt for a Digitakt II', () => {
    // "Digitakt II" starts with "Digitakt", so a naive first-match would claim
    // the gen-1 box supports things it doesn't.
    expect(slugFromPortName('Elektron Digitakt')).toBe('digitakt');
    expect(slugFromPortName('Elektron Digitakt II')).toBe('digitakt2');
  });

  it('says nothing rather than guessing at an unknown port', () => {
    expect(slugFromPortName('Octatrack MKII')).toBe(null);
    expect(slugFromPortName('IAC Driver Bus 1')).toBe(null);
    expect(slugFromPortName('')).toBe(null);
    expect(slugFromPortName(null)).toBe(null);
    expect(slugFromPortName(undefined)).toBe(null);
  });
});
