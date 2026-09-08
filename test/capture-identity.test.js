import { it, expect } from 'vitest';
import { captureIdentity } from '../js/labs/capture-identity.js';
import { contributorReport } from '../js/labs/probe.js';
import { writeGate } from '../js/elektron/safe-write.js';
it('keeps a selected A4 port unverified when the identity API is silent', () => {
  const id = captureIdentity({ output: { name: 'Elektron Analog Four' }, identity: null });
  expect(id.name).toContain('identity unavailable');
  expect(id).toMatchObject({ productId: null, family: null, slug: 'elektron', version: '', build: '', supported: false });
  expect(writeGate(id).ok).toBe(false);
  const report = contributorReport({ identity: id, summary: [], probed: 1 });
  expect(report).toContain('product id unknown');
  expect(report).toContain('OS: unknown (build unknown)');
});
it('retains the device-reported identity when available', () => {
  const identity = { name: 'Analog Four', productId: 4, family: 6, build: '0195' };
  expect(captureIdentity({ identity })).toBe(identity);
});
