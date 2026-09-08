import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseCapturePair } from '../js/labs/capture-pair.js';
import { readMappedFields } from '../js/elektron/legacy-read.js';
import { describerFor } from '../js/labs/describers.js';
import { diffAnnotatedRanges } from '../js/elektron/pattern-core.js';
import { decoderFor, writeGate, PRODUCT_BY_FAMILY, WRITE_ALLOWED_BUILDS } from '../js/elektron/safe-write.js';
const root = new URL('../dumps/fixtures/issue-8-2026-09-08/', import.meta.url);
function captures(device) {
  const dir = new URL(device + '/', root);
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => parseCapturePair(fs.readFileSync(new URL(f, dir), 'utf8')))
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

it('revalidates all donated hashes, framing and recorded diffs, and isolates chained edits', () => {
  const report = JSON.parse(execFileSync(process.execPath,
    [new URL('../scripts/analyse-legacy-captures.mjs', import.meta.url).pathname], { encoding: 'utf8' }));
  expect(report.map(r => r.pairs.length)).toEqual([8, 8]);
  for (const device of report) for (const pair of device.pairs) {
    expect(pair.candidatePool.baseline.freeLookingRecords).toBe(80);
    expect(pair.candidatePool.after.freeLookingRecords).toBe(80);
    expect(pair.magicOffsets).toEqual(device.device === 'digitakt'
      ? Array.from({ length: 8 }, (_, i) => 25124 + i * 160)
      : Array.from({ length: 12 }, (_, i) => 23598 + i * 263));
  }
  expect(report[0].pairs[2].previousAfterToBaseline).toEqual([{ offset: 196, before: 51, after: 255 }]);
  expect(report[0].pairs[2].previousAfterToAfter).toEqual([{ offset: 260, before: 255, after: 28 }]);
  expect(report[1].pairs[7].previousAfterToBaseline).toEqual([{ offset: 23207, before: 0, after: 14 }]);
});

for (const [device, family, expected] of [
  ['digitakt', 0x0a, { defaults: [60,104,14], velocity: 51, length: 28, micro: 1, pitch: 62, swing: 4 }],
  ['syntakt', 0x16, { defaults: [60,100,14], velocity: 95, length: 26, micro: 255, pitch: 59, swing: 15 }],
]) describe(device, () => {
  const pairs = captures(device);
  const read = (i, side = 'after') => readMappedFields(family, 0x60, pairs[i][side].payload);
  it('reads measured edits without inventing default values or musical units', () => {
    expect(read(0).track1Step1Raw).toEqual({ pitch: 255, velocity: 255, length: 255, microtiming: 0 });
    expect(read(1).track1Step1Raw.velocity).toBe(expected.velocity);
    expect(read(2).track1Step1Raw.length).toBe(expected.length);
    expect(read(3).track1Step1Raw.microtiming).toBe(expected.micro);
    expect(read(4).track1Step1Raw.pitch).toBe(expected.pitch);
    expect(read(5, 'baseline').patternLengthByteRaw).toBe(16);
    expect(read(5).patternLengthByteRaw).toBe(32);
    expect(read(7).swingByteRaw).toBe(expected.swing);
    for (const p of pairs) for (const side of ['baseline', 'after']) {
      expect(readMappedFields(family, 0x60, p[side].payload).defaultCandidateBytes).toEqual(expected.defaults);
    }
    expect(read(6).tempoChangedBytesRaw).toEqual(device === 'digitakt'
      ? [{ offset: 24998, value: 58 }, { offset: 24999, value: 32 }]
      : [{ offset: 23202, value: 184 }]);
  });
  it('annotates donated fields by captured family/request and preserves unknown regions', () => {
    const p = pairs[1];
    const describe = describerFor(family, 0x60, p.baseline.payload);
    expect(diffAnnotatedRanges(p.baseline.payload, p.after.payload, describe)[0].label).toMatch(/step 1 velocity.*raw/);
    expect(describe(197)).toBe('unknown'); // no controlled step-2 velocity edit
    expect(describe(10000)).toBe('unknown');
    for (const request of [0x61, 0x62, 0x65, 0x68]) expect(describerFor(family, request, p.baseline.payload)).toBeNull();
    expect(describerFor(0x7f, 0x60, p.baseline.payload)).toBeNull();
    const bad = p.baseline.payload.slice(); bad[3]++;
    expect(describerFor(family, 0x60, bad)).toBeNull();
    expect(() => readMappedFields(family, 0x60, bad)).toThrow(/Unmapped/);
    expect(() => readMappedFields(family, 0x60, bad.subarray(0, 200))).toThrow(/Unmapped/);
  });
  it('keeps Studio decoding and writing unavailable for these partial maps', () => {
    expect(PRODUCT_BY_FAMILY[family].slug).toBe(device);
    expect(decoderFor(device)).toBeNull();
    expect(WRITE_ALLOWED_BUILDS[device]).toBeUndefined();
    expect(writeGate({ slug: device, name: device, build: pairs[0].device.build }).ok).toBe(false);
  });
});
