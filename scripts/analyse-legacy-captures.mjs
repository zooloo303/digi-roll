// Reproduce intake validation and derived comparisons without changing evidence.
// Run: node scripts/analyse-legacy-captures.mjs > /tmp/legacy-analysis.json
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseCapturePair } from '../js/labs/capture-pair.js';
import { readMappedFields } from '../js/elektron/legacy-read.js';
const root = new URL('../dumps/fixtures/issue-8-2026-09-08/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root)));
const validation = JSON.parse(fs.readFileSync(new URL('validation.json', root)));
const changes = (a, b) => Array.from(a.keys()).filter(i => a[i] !== b[i])
  .map(offset => ({ offset, before: a[offset], after: b[offset] }));
const report = [];
for (const archive of manifest.archives) {
  const pairs = [];
  for (const file of archive.files) {
    const bytes = fs.readFileSync(new URL(file.path, root));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    if (!file.path.endsWith('.json')) continue;
    const pair = parseCapturePair(bytes.toString());
    assert.equal(pair.family, pair.baseline.msg.family);
    assert.equal(pair.requestType, pair.baseline.msg.type + 0x10);
    assert.equal(pair.index, pair.baseline.msg.index);
    assert.deepEqual(changes(pair.baseline.payload, pair.after.payload),
      validation.find(v => v.path === file.path).changes);
    pairs.push({ file: file.path, ...pair });
  }
  pairs.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  report.push({ device: archive.device, pairs: pairs.map((p, i) => {
    const a = p.baseline.payload;
    const magic = [];
    for (let j = 0; j < a.length - 3; j++) {
      if (a[j] === 0xbe && a[j+1] === 0xef && a[j+2] === 0xba && a[j+3] === 0xce) magic.push(j);
    }
    const stride = archive.device === 'digitakt' ? 911 : 983;
    const entries = archive.device === 'digitakt' ? 16 : 13;
    const poolStart = 4 + stride * entries;
    const pool = bytes => ({
      start: poolStart, endExclusive: poolStart + 80 * 130,
      freeLookingRecords: Array.from({ length: 80 }, (_, n) => {
        const offset = poolStart + n * 130;
        return bytes[offset] === 255 && bytes[offset + 1] === 255
          && bytes.subarray(offset + 2, offset + 130).every(v => v === 0);
      }).filter(Boolean).length,
    });
    return { file: p.file, note: p.note, magicOffsets: magic,
      candidatePool: { baseline: pool(a), after: pool(p.after.payload) },
      baseline: readMappedFields(p.family, p.requestType, a),
      after: readMappedFields(p.family, p.requestType, p.after.payload),
      previousAfterToBaseline: i ? changes(pairs[i-1].after.payload, a) : null,
      previousAfterToAfter: i ? changes(pairs[i-1].after.payload, p.after.payload) : null };
  }) });
}
console.log(JSON.stringify(report, null, 2));
