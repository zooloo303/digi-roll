import { describe, it, expect } from 'vitest';
import {
  candidateFamilies, sweepPlan, deepPlan, summarizeFindings, contributorReport,
  KNOWN_FAMILIES, REQUEST_TYPES,
} from '../js/labs/probe.js';

// The probe is the front door for contributors mapping boxes we don't own, so
// its plans and its report are worth pinning: a wrong plan wastes a stranger's
// twenty seconds, a wrong report wastes their forum post.
describe('candidateFamilies', () => {
  it('tries the families we have met on hardware first', () => {
    const c = candidateFamilies();
    expect(c.slice(0, 3)).toEqual(Object.keys(KNOWN_FAMILIES).map(Number));
  });

  it('never includes 0x10 — that family byte parses as API traffic, not a dump', () => {
    expect(candidateFamilies()).not.toContain(0x10);
  });

  it('covers the candidate range exactly once each', () => {
    const c = candidateFamilies();
    expect(new Set(c).size).toBe(c.length);
    for (const f of c) expect(f >= 0x01 && f <= 0x2f).toBe(true);
  });
});

describe('plans', () => {
  it('sweeps every family with both pattern-shaped requests', () => {
    const plan = sweepPlan({ families: [0x1a, 0x1b], index: 4 });
    expect(plan).toEqual([
      { family: 0x1a, type: 0x60, index: 4 },
      { family: 0x1a, type: 0x61, index: 4 },
      { family: 0x1b, type: 0x60, index: 4 },
      { family: 0x1b, type: 0x61, index: 4 },
    ]);
  });

  it('deep-probes an answering family with every single-response dump type', () => {
    const plan = deepPlan([0x1a]);
    expect(plan.map(p => p.type)).toEqual(Object.keys(REQUEST_TYPES).map(Number));
    expect(plan.every(p => p.family === 0x1a)).toBe(true);
  });

  it('plans only request opcodes — the read-only guarantee starts here', () => {
    for (const p of [...sweepPlan(), ...deepPlan([0x05, 0x1a])]) {
      expect(p.type >= 0x60 && p.type <= 0x6e).toBe(true);
    }
  });
});

describe('summarizeFindings', () => {
  const finding = (family, type, bytes, index = 0, ok = true) => ({ family, type, index, bytes, ok });

  it('groups replies by family and infers the request that fetches each', () => {
    const s = summarizeFindings([finding(0x1a, 0x52, 16), finding(0x1a, 0x51, 64)]);
    expect(s).toEqual([{
      family: 0x1a,
      known: null,
      replies: [
        { type: 0x51, requestType: 0x61, index: 0, bytes: 64, ok: true },
        { type: 0x52, requestType: 0x62, index: 0, bytes: 16, ok: true },
      ],
    }]);
  });

  it('drops the duplicates the deep pass re-asks for', () => {
    const s = summarizeFindings([finding(0x1a, 0x51, 64), finding(0x1a, 0x51, 64)]);
    expect(s[0].replies).toHaveLength(1);
  });

  it('names a family we already know', () => {
    expect(summarizeFindings([finding(0x15, 0x50, 111616)])[0].known).toBe('Digitone II');
  });
});

describe('contributorReport', () => {
  const identity = { name: 'Syntakt', productId: 47, build: '0012', version: '1.21' };

  it('carries everything a mapping needs to start: identity, port, what answered', () => {
    const md = contributorReport({
      identity, portName: 'Elektron Syntakt',
      summary: summarizeFindings([{ family: 0x1a, type: 0x51, index: 0, bytes: 5472, ok: true }]),
      probed: 97,
    });
    expect(md).toContain('Syntakt (product id 47)');
    expect(md).toContain('OS: 1.21 (build 0012)');
    expect(md).toContain('MIDI port: Elektron Syntakt');
    expect(md).toContain('`0x61` request → `0x51` response, 5,472 bytes, checksum OK');
    expect(md).toContain('dump requests only — the probe cannot write');
  });

  it('treats silence as a finding worth posting too', () => {
    const md = contributorReport({ identity, summary: [], probed: 92 });
    expect(md).toContain('No family byte answered');
    expect(md).toContain('please say what box and OS this is anyway');
  });
});
