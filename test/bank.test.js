import { describe, it, expect, beforeEach } from 'vitest';
import {
  BANK_PREFIX, BANK_SCHEMA, serializePattern, deserializePattern,
  listBank, bankEntry, saveToBank, loadFromBank, deleteFromBank, renameInBank,
  exportBank, parseBankFile, importBank,
} from '../js/bank.js';
import { makeNote, defaultPattern } from '../js/state.js';
import { makeSource } from '../js/roll-bridge.js';

// Phase 4 feature 2: the pattern bank. A localStorage-shaped fake stands in
// for the browser's, which is also how the module is written — no global
// reaching, so "save, reload the page, load it back" is a real test rather
// than a manual click-through.
class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

// A pattern with something interesting in every field the bank must preserve:
// micro-timing, swing, provenance, a non-default channel and length.
const richPattern = () => ({
  ...defaultPattern(0),
  name: 'DnB roller',
  lengthSteps: 32,
  channel: 9,
  swing: 62,
  source: makeSource({
    slug: 'digitakt2', productId: 42, deviceName: 'Digitakt II',
    patternIndex: 15, trackIndex: 10, patternName: 'JAM', importedAt: '2026-08-01T12:00:00.000Z',
  }),
  notes: [
    makeNote(0, 36, 2, 110, 0),
    makeNote(3, 39, 1, 90, -5 / 24),
    makeNote(10, 48, 4, 64, 7 / 24),
  ],
});

let store;
beforeEach(() => { store = new FakeStorage(); });

describe('serialize / deserialize', () => {
  it('round-trips every field the piano roll cares about', () => {
    const p = richPattern();
    const back = deserializePattern(serializePattern(p), makeNote);
    expect(back.name).toBe(p.name);
    expect(back.lengthSteps).toBe(p.lengthSteps);
    expect(back.channel).toBe(p.channel);
    expect(back.swing).toBe(p.swing);
    expect(back.source).toEqual(p.source);
    expect(back.notes.map(({ id, ...n }) => n))
      .toEqual(p.notes.map(({ id, ...n }) => n));
  });

  it('keeps micro-timing exactly, not rounded to the grid', () => {
    const back = deserializePattern(serializePattern(richPattern()), makeNote);
    expect(back.notes.map(n => n.micro)).toEqual([0, -5 / 24, 7 / 24]);
  });

  it('reissues note ids instead of restoring stale ones', () => {
    const back = deserializePattern(serializePattern(richPattern()), makeNote);
    expect(new Set(back.notes.map(n => n.id)).size).toBe(3);
    expect(back.notes.every(n => typeof n.id === 'number')).toBe(true);
    expect(JSON.stringify(serializePattern(back))).not.toMatch(/"id"/);
  });

  it('stamps a schema number and refuses entries from another one', () => {
    const entry = serializePattern(richPattern());
    expect(entry.schema).toBe(BANK_SCHEMA);
    expect(() => deserializePattern({ ...entry, schema: 99 }, makeNote)).toThrow(/schema 99/);
    expect(() => deserializePattern(null, makeNote)).toThrow(/not a pattern bank entry/);
    expect(() => deserializePattern({ schema: BANK_SCHEMA }, makeNote)).toThrow(/no notes/);
  });

  it('carries no provenance for a locally drawn pattern', () => {
    const back = deserializePattern(serializePattern(defaultPattern(3)), makeNote);
    expect(back.source).toBe(null);
  });
});

describe('bank storage', () => {
  it('reproduces the pattern exactly after a page reload', () => {
    const p = richPattern();
    saveToBank('roller', p, store);

    // "Reload the page": nothing survives but localStorage itself.
    const reloaded = loadFromBank('roller', makeNote, store);
    expect(reloaded.swing).toBe(62);
    expect(reloaded.lengthSteps).toBe(32);
    expect(reloaded.channel).toBe(9);
    expect(reloaded.source).toEqual(p.source);
    expect(reloaded.notes.map(({ id, ...n }) => n)).toEqual(p.notes.map(({ id, ...n }) => n));
  });

  it('stores one key per pattern under the digiroll.bank. prefix', () => {
    saveToBank('one', richPattern(), store);
    saveToBank('two', defaultPattern(1), store);
    expect([...store.map.keys()].sort()).toEqual([`${BANK_PREFIX}one`, `${BANK_PREFIX}two`]);
    expect(listBank(store)).toEqual(['one', 'two']);
  });

  it('lists names alphabetically and trims the ones you type', () => {
    saveToBank('  zeta  ', richPattern(), store);
    saveToBank('alpha', richPattern(), store);
    expect(listBank(store)).toEqual(['alpha', 'zeta']);
    expect(() => saveToBank('   ', richPattern(), store)).toThrow(/name/);
  });

  it('renames and deletes', () => {
    saveToBank('before', richPattern(), store);
    renameInBank('before', 'after', store);
    expect(listBank(store)).toEqual(['after']);
    expect(loadFromBank('after', makeNote, store).name).toBe('DnB roller');
    expect(() => renameInBank('ghost', 'x', store)).toThrow(/isn't in the bank/);

    deleteFromBank('after', store);
    expect(listBank(store)).toEqual([]);
    expect(() => loadFromBank('after', makeNote, store)).toThrow(/isn't in the bank/);
  });

  it('survives an entry that isn\'t valid JSON', () => {
    store.setItem(`${BANK_PREFIX}mangled`, 'not json{');
    saveToBank('good', richPattern(), store);
    expect(listBank(store)).toEqual(['good', 'mangled']);
    expect(bankEntry('mangled', store)).toBe(null);
  });
});

describe('export / import file', () => {
  it('round-trips an exported file into a fresh bank', () => {
    saveToBank('roller', richPattern(), store);
    saveToBank('empty', defaultPattern(2), store);
    const text = exportBank(listBank(store), store);

    const fresh = new FakeStorage();
    const added = importBank(parseBankFile(text), fresh);
    expect(added.sort()).toEqual(['empty', 'roller']);

    const before = loadFromBank('roller', makeNote, store);
    const after = loadFromBank('roller', makeNote, fresh);
    expect(after.notes.map(({ id, ...n }) => n)).toEqual(before.notes.map(({ id, ...n }) => n));
    expect(after.swing).toBe(before.swing);
    expect(after.source).toEqual(before.source);
  });

  it('exports a single pattern for sharing', () => {
    saveToBank('roller', richPattern(), store);
    saveToBank('other', defaultPattern(1), store);
    const doc = JSON.parse(exportBank(['roller'], store));
    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].name).toBe('roller');
    expect(doc.schema).toBe(BANK_SCHEMA);
  });

  it('never overwrites an existing save on import', () => {
    saveToBank('roller', richPattern(), store);
    const text = exportBank(['roller'], store);
    expect(importBank(parseBankFile(text), store)).toEqual(['roller (2)']);
    expect(importBank(parseBankFile(text), store)).toEqual(['roller (3)']);
    expect(listBank(store)).toEqual(['roller', 'roller (2)', 'roller (3)']);
  });

  it('rejects files that aren\'t a bank export', () => {
    expect(() => parseBankFile('nope')).toThrow(/not a JSON file/);
    expect(() => parseBankFile('{"hello":1}')).toThrow(/not a digi-roll pattern bank file/);
    expect(() => parseBankFile(JSON.stringify({ schema: 99, entries: [] }))).toThrow(/schema 99/);
    expect(() => parseBankFile(JSON.stringify({ schema: BANK_SCHEMA, entries: [{ pattern: {} }] })))
      .toThrow(/no name/);
  });
});
