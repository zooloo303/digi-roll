import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stashBackup, stashedBackups, STASH_KEY, STASH_MAX } from '../js/elektron/backup-stash.js';

// The stash is rule 1's guarantee: a .syx download can be cancelled or blocked
// without JS ever knowing, so the copy localStorage keeps is the one a write
// can count on. Everything here is best-effort by contract — no environment
// may ever make stashing throw, because a stash failure must not block a write
// that still has its download path.

const DT2 = { slug: 'digitakt2' };
const DN2 = { slug: 'digitone2' };
const backup = (index, byte, name = `digitakt2-backup-${index}.syx`) =>
  ({ index, name, payload: new Uint8Array(64).fill(byte) });

// Node has no localStorage; give the module a minimal, controllable one.
let mem;
beforeEach(() => {
  mem = new Map();
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  };
});
afterEach(() => {
  delete globalThis.localStorage;
});

describe('stashBackup / stashedBackups', () => {
  it('round-trips a backup byte-exact, newest first', () => {
    expect(stashBackup(DT2, backup(3, 0xaa), new Date('2026-08-08T10:00:00Z'))).toBe(true);
    expect(stashBackup(DT2, backup(7, 0xbb), new Date('2026-08-08T11:00:00Z'))).toBe(true);
    const got = stashedBackups();
    expect(got.map(e => e.index)).toEqual([7, 3]);
    expect(got[0].payload).toEqual(new Uint8Array(64).fill(0xbb));
    expect(got[0]).toMatchObject({ slug: 'digitakt2', at: '2026-08-08T11:00:00.000Z' });
  });

  it('filters by box, so a DN2 backup is never offered for a DT2', () => {
    stashBackup(DT2, backup(1, 1));
    stashBackup(DN2, backup(2, 2));
    expect(stashedBackups('digitakt2').map(e => e.index)).toEqual([1]);
    expect(stashedBackups('digitone2').map(e => e.index)).toEqual([2]);
  });

  it(`keeps only the newest ${STASH_MAX}`, () => {
    for (let i = 0; i < STASH_MAX + 3; i++) stashBackup(DT2, backup(i, i));
    const got = stashedBackups();
    expect(got.length).toBe(STASH_MAX);
    expect(got[0].index).toBe(STASH_MAX + 2); // newest survives, oldest fell off
  });

  it('reports failure instead of throwing when storage is full', () => {
    globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(stashBackup(DT2, backup(0, 0))).toBe(false);
  });

  it('reports failure instead of throwing with no localStorage at all', () => {
    delete globalThis.localStorage;
    expect(stashBackup(DT2, backup(0, 0))).toBe(false);
    expect(stashedBackups()).toEqual([]);
  });

  it('shrugs off corrupt storage rather than dying on it', () => {
    mem.set(STASH_KEY, 'not json');
    expect(stashedBackups()).toEqual([]);
    // …and a fresh stash on top of the corruption works.
    expect(stashBackup(DT2, backup(5, 5))).toBe(true);
    expect(stashedBackups().map(e => e.index)).toEqual([5]);
  });
});
