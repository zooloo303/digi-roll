import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP, FAMILY } from '../js/elektron/protocol.js';
import * as dt2 from '../js/elektron/dt2/pattern.js';
import {
  safeWriteTrack, writeGate, writeResultMessage, patternKitBackup,
  decoderFor, PRODUCT_BY_FAMILY, WRITE_ALLOWED_BUILDS,
} from '../js/elektron/safe-write.js';

// js/elektron/safe-write.js is the one write path the Phase 4 features share,
// so PLAN.md's safety rules are provable here rather than only observable on
// hardware: backup before send, always re-fetch, allowlist, verify-after-write.
const FIXTURE = fileURLToPath(new URL('../dumps/digitakt2-project-2026-08-01T23-37-04.syx', import.meta.url));
const have = existsSync(FIXTURE);

const kits = () => splitSysExStream(new Uint8Array(readFileSync(FIXTURE)))
  .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);

const DT2_IDENTITY = {
  productId: 42, slug: 'digitakt2', name: 'Digitakt II',
  family: FAMILY.DIGITAKT_2, build: '0070', version: '1.15B', supported: true,
};

// A box that records every exchange, so tests can assert on ordering.
class FakeBox {
  constructor(identity, slots, { corruptOnStore = false } = {}) {
    this.identity = identity;
    this.slots = slots;
    this.log = [];
    this.corruptOnStore = corruptOnStore;
  }
  async fetchPatternKit(index) {
    this.log.push(`fetch ${index}`);
    return this.slots.get(index);
  }
  async sendPatternKit(index, payload) {
    this.log.push(`send ${index}`);
    const stored = Uint8Array.from(payload);
    if (this.corruptOnStore) stored[20000] ^= 0xff; // the box stores something else
    this.slots.set(index, stored);
  }
}

const bassline = [
  { step: 0, pitch: 36, velocity: 110, len: 2, micro: 0 },
  { step: 6, pitch: 41, velocity: 127, len: 4, micro: 5 / 24 },
];

const boxWithFixture = opts => new FakeBox(
  DT2_IDENTITY,
  new Map(kits().map(m => [m.index, m.payload])),
  opts,
);

describe.skipIf(!have)('safeWriteTrack', () => {
  it('fetches, backs up, writes, then reads back to verify — in that order', async () => {
    const box = boxWithFixture();
    const seen = [];
    const result = await safeWriteTrack(box, {
      index: 1, trackIndex: 2, notes: bassline,
      onBackup: b => { seen.push(`backup ${b.name}`); box.log.push('backup'); },
      onStatus: s => seen.push(s),
    });
    expect(box.log).toEqual(['fetch 1', 'backup', 'send 1', 'fetch 1']);
    expect(result.ok).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.diffs).toEqual([]);
    expect(result.written).toBe(2);
    expect(result.dropped).toBe(0);
    expect(seen.some(s => /Verifying/.test(s))).toBe(true);
  });

  it('actually puts the notes on the box', async () => {
    const box = boxWithFixture();
    await safeWriteTrack(box, { index: 1, trackIndex: 2, notes: bassline, onBackup: () => {} });
    expect(dt2.trackNotes(dt2.decodePatternKit(box.slots.get(1)), 2)).toEqual([
      { step: 0, pitch: 36, velocity: 110, lenSteps: 2, micro: 0 },
      { step: 6, pitch: 41, velocity: 127, lenSteps: 4, micro: 5 / 24 },
    ]);
  });

  it('hands the backup the untouched bytes, before anything is sent', async () => {
    const box = boxWithFixture();
    const original = Uint8Array.from(box.slots.get(1));
    let captured = null;
    await safeWriteTrack(box, {
      index: 1, trackIndex: 2, notes: bassline,
      onBackup: b => {
        captured = b;
        expect(box.log).not.toContain('send 1'); // nothing written yet
      },
    });
    expect(captured.payload).toEqual(original);
    expect(captured.index).toBe(1);
    expect(captured.name).toMatch(/^digitakt2-A02-backup-/);
    expect(captured.name).toMatch(/\.syx$/);
  });

  it('refuses to write at all without a backup hook', async () => {
    const box = boxWithFixture();
    await expect(safeWriteTrack(box, { index: 1, trackIndex: 2, notes: bassline }))
      .rejects.toThrow(/without a backup/);
    expect(box.log).not.toContain('send 1');
  });

  it('aborts the write if the backup fails', async () => {
    const box = boxWithFixture();
    await expect(safeWriteTrack(box, {
      index: 1, trackIndex: 2, notes: bassline,
      onBackup: () => { throw new Error('disk full'); },
    })).rejects.toThrow(/disk full/);
    expect(box.log).toEqual(['fetch 1']); // fetched, then stopped
  });

  it('re-fetches the target instead of trusting an earlier read', async () => {
    const box = boxWithFixture();
    // Something (the user, on the box) changes the pattern after an import:
    // track 10 gets different notes. The write must build on *these* bytes.
    const { payload: moved } = dt2.encodeTrackNotes(box.slots.get(0), 10, [
      { step: 5, pitch: 72, velocity: 42, len: 1, micro: 0 },
    ]);
    box.slots.set(0, moved);

    await safeWriteTrack(box, { index: 0, trackIndex: 2, notes: bassline, onBackup: () => {} });
    const after = dt2.decodePatternKit(box.slots.get(0));
    // Our track landed, and the change made on the box survived untouched.
    expect(dt2.trackNotes(after, 2).map(n => n.pitch)).toEqual([36, 41]);
    expect(dt2.trackNotes(after, 10)).toEqual([{ step: 5, pitch: 72, velocity: 42, lenSteps: 1, micro: 0 }]);
  });

  it('reports a verify mismatch loudly instead of claiming success', async () => {
    const box = boxWithFixture({ corruptOnStore: true });
    const result = await safeWriteTrack(box, {
      index: 1, trackIndex: 2, notes: bassline, onBackup: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.diffs.length).toBeGreaterThan(0);
    expect(result.diffs[0].offset).toBe(20000);
    const { text, isError } = writeResultMessage(result);
    expect(isError).toBe(true);
    expect(text).toMatch(/verify FAILED/i);
    expect(text).toMatch(/backup/i);
  });

  it('cancels cleanly: no backup, no write', async () => {
    const box = boxWithFixture();
    let backedUp = false;
    const result = await safeWriteTrack(box, {
      index: 1, trackIndex: 2, notes: bassline,
      onBackup: () => { backedUp = true; },
      confirm: () => false,
    });
    expect(result.cancelled).toBe(true);
    expect(backedUp).toBe(false);
    expect(box.log).toEqual(['fetch 1']);
    expect(writeResultMessage(result).text).toBe('Write cancelled');
  });

  it('tells the confirm hook exactly what is about to be overwritten', async () => {
    const box = boxWithFixture();
    let summary = null;
    await safeWriteTrack(box, {
      index: 0, trackIndex: 10, notes: bassline,
      onBackup: () => {},
      confirm: s => { summary = s; return true; },
    });
    expect(summary.label).toBe('A01');
    expect(summary.trackIndex).toBe(10);
    expect(summary.existingTrigs).toBe(8); // the fixture's track 11
    expect(summary.noteCount).toBe(2);
    expect(summary.patternKit.kit.name).toBe('JO_KIT');
  });

  it('refuses an OS build that has never been write-verified', async () => {
    const box = new FakeBox({ ...DT2_IDENTITY, build: '9999' }, new Map());
    await expect(safeWriteTrack(box, { index: 1, trackIndex: 0, notes: [], onBackup: () => {} }))
      .rejects.toThrow(/9999 isn't write-verified/);
    expect(box.log).toEqual([]);
  });

  it('produces a backup file the box could actually be sent back', async () => {
    const original = kits().find(m => m.index === 0).payload;
    const backup = patternKitBackup(DT2_IDENTITY, 0, original, new Date('2026-08-01T12:34:56Z'));
    expect(backup.name).toBe('digitakt2-A01-backup-2026-08-01T12-34-56.syx');
    const [msg] = splitSysExStream(backup.bytes);
    expect(msg.kind).toBe('dump');
    expect(msg.type).toBe(DUMP.PATTERN_KIT);
    expect(msg.family).toBe(FAMILY.DIGITAKT_2);
    expect(msg.index).toBe(0);
    expect(msg.checksumOk && msg.countOk).toBe(true);
    expect(msg.payload).toEqual(original);
  });
});

describe('writeGate', () => {
  it('opens only for a known device on a verified build', () => {
    expect(writeGate(DT2_IDENTITY)).toMatchObject({ ok: true });
    expect(writeGate({ ...DT2_IDENTITY, slug: 'digitone2', build: '0049' })).toMatchObject({ ok: true });
  });

  it('closes for an unverified build, an unknown box, and no box', () => {
    expect(writeGate({ ...DT2_IDENTITY, build: '0071' })).toMatchObject({ ok: false });
    expect(writeGate({ ...DT2_IDENTITY, build: '0071' }).reason).toMatch(/0071/);
    expect(writeGate({ slug: 'digitakt', name: 'Digitakt', build: '1' }).ok).toBe(false);
    expect(writeGate(null)).toMatchObject({ ok: false, reason: 'no device connected' });
  });

  it('hands back the decoder for the gated device', () => {
    expect(writeGate(DT2_IDENTITY).mod).toBe(decoderFor('digitakt2'));
    expect(decoderFor('octatrack')).toBe(null);
  });

  it('only allowlists the builds Phases 2 and 3 were verified on', () => {
    expect(WRITE_ALLOWED_BUILDS).toEqual({ digitakt2: ['0070'], digitone2: ['0049'] });
  });
});

describe('PRODUCT_BY_FAMILY', () => {
  it('identifies a box from a .syx file, where there was no handshake', () => {
    expect(PRODUCT_BY_FAMILY[FAMILY.DIGITAKT_2]).toEqual({ slug: 'digitakt2', productId: 42, name: 'Digitakt II' });
    expect(PRODUCT_BY_FAMILY[FAMILY.DIGITONE_2]).toEqual({ slug: 'digitone2', productId: 43, name: 'Digitone II' });
  });
});

describe('writeResultMessage', () => {
  const base = { label: 'A02', trackIndex: 1, diffs: [], backup: { name: 'b.syx' } };

  it('reports a clean write', () => {
    expect(writeResultMessage({ ...base, ok: true, written: 5, dropped: 0 }).text)
      .toBe('✓ Wrote 5 notes to A02 T2 — verified byte-identical');
  });

  it('never hides dropped notes', () => {
    const { text } = writeResultMessage({ ...base, ok: true, written: 4, dropped: 1 });
    expect(text).toMatch(/1 note didn't fit and was dropped/);
  });

  it('gets the singulars right', () => {
    expect(writeResultMessage({ ...base, ok: true, written: 1, dropped: 0 }).text)
      .toMatch(/Wrote 1 note to/);
  });
});
