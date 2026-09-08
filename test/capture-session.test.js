import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CaptureSession } from '../js/labs/session.js';
import { sessionZip } from '../js/labs/zip.js';
import { buildCapturePair, parseCapturePair } from '../js/labs/capture-pair.js';
import { buildDumpMessage } from '../js/elektron/protocol.js';
import { checklistFromURL, checklistLink, issueLink, STANDARD, detailErrors, experimentNote } from '../js/labs/experiments.js';
const fixtureDir = new URL('../dumps/fixtures/issue-8-2026-09-08/syntakt/', import.meta.url);
const original = fs.readFileSync(new URL(fs.readdirSync(fixtureDir).find(f => f.endsWith('.json')), fixtureDir), 'utf8');
const details = { track: '1', step: '1', before: '0', after: '−1/384 ←', note: 'one edit' };

describe('experiment checklists', () => {
  it('round-trips a targeted checklist and issue without putting captures into a link', () => {
    const link = checklistLink('https://example.test/difflab.html?issue=8', ['layout', 'default-note', 'micro']);
    expect(checklistFromURL(link)).toEqual(['layout', 'default-note', 'micro']);
    expect(issueLink(link)).toBe('https://github.com/zooloo303/digi-roll/issues/8');
    expect(checklistFromURL('https://example.test')).toEqual(STANDARD);
    expect(() => checklistFromURL('https://example.test?checklist=constructor')).toThrow(/not recognised/);
    expect(issueLink('https://example.test?issue=https://evil.test')).toContain('issues/new');
  });
  it('requires before/after values or explicit unknowns and validates only relevant location fields', () => {
    expect(detailErrors('micro', { ...details, before: '', after: '' }, { after: true })).toHaveLength(2);
    expect(detailErrors('micro', { ...details, before: '', after: '', beforeUnknown: true, afterUnknown: true }, { after: true })).toEqual([]);
    expect(detailErrors('pitch', { ...details, track: '0' })).toHaveLength(1);
    expect(detailErrors('tempo', { ...details, track: '0', step: '' })).toEqual([]);
    expect(detailErrors('custom', { ...details, note: '' })).toHaveLength(1);
    expect(experimentNote('micro', details)).toContain('0 → −1/384 ←');
  });
});

describe('session evidence', () => {
  it('keeps each saved pair and metadata independent and tracks new download revisions', () => {
    const session = new CaptureSession(), metadata = { id: 'trig', ...details };
    session.addPair(original, metadata); metadata.before = 'edited later';
    expect(session.pairs[0].experiment.before).toBe('0');
    expect(session.pairs[0].text).toBe(original);
    expect(session.hasUndownloaded).toBe(true);
    session.downloadedRevision = session.revision;
    expect(session.hasUndownloaded).toBe(false);
    session.addReport('Nothing answered.', { name: 'Other box' });
    expect(session.hasUndownloaded).toBe(true);
    expect(session.files().find(f => f.name === 'reports/probe-1.txt').text).toBe('Nothing answered.');
  });
  it('rejects mismatched or corrupt messages and metadata but accepts unchanged and multi-byte pairs', () => {
    const s = new CaptureSession(); s.addPair(original, details); // real two-byte trig edit
    const p = JSON.parse(original); p.family = 10;
    expect(() => s.addPair(JSON.stringify(p), details)).toThrow(/metadata/);
    p.family = 22; p.after = p.baseline;
    expect(() => s.addPair(JSON.stringify(p), details)).not.toThrow();
    const pair = (a, b) => buildCapturePair({ device: {}, family: 22, requestType: 96, index: 0,
      baselineRaw: buildDumpMessage(22, 80, 0, a), afterRaw: buildDumpMessage(22, 80, 0, b) });
    expect(() => s.addPair(pair(new Uint8Array(4), new Uint8Array(5)), details)).toThrow(/sizes/);
    p.after = 'broken'; expect(() => s.addPair(JSON.stringify(p), details)).toThrow();
  });
  it('exports a standards-readable ZIP with byte-identical donated pairs, UTF-8 metadata, and probe-only support', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digiroll-zip-'));
    try {
      const s = new CaptureSession(); s.addPair(original, details); s.addReport('Syntakt — read only', {});
      const archive = path.join(dir, 'session.zip'); fs.writeFileSync(archive, sessionZip(s.files()));
      // Independent ZIP implementation verifies CRCs and extracts each entry.
      const decoded = JSON.parse(execFileSync('python3', ['-c',
        'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))', archive], { encoding: 'utf8' }));
      expect(decoded['pairs/capture-001.json']).toBe(original);
      expect(parseCapturePair(decoded['pairs/capture-001.json']).after.raw).toEqual(parseCapturePair(original).after.raw);
      expect(JSON.parse(decoded['session.json']).pairs[0].experiment.after).toBe(details.after);
      const probeOnly = new CaptureSession(); probeOnly.addReport('No replies', {});
      expect(probeOnly.files().some(f => f.name.endsWith('.txt'))).toBe(true);
      expect(() => new CaptureSession().files()).toThrow(/first/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
