import { describe, it, expect } from 'vitest';
import {
  candidateFamilies, sweepPlan, deepPlan, summarizeFindings, contributorReport,
  KNOWN_FAMILIES, REQUEST_TYPES, A4_REQUEST_TYPES, ALL_REQUEST_TYPES,
  requestTypesFor, objectName, defaultRequestFor,
} from '../js/labs/probe.js';

// The probe is the front door for contributors mapping boxes we don't own, so
// its plans and its report are worth pinning: a wrong plan wastes a stranger's
// twenty seconds, a wrong report wastes their forum post.
describe('candidateFamilies', () => {
  it('tries the families we have met on hardware first', () => {
    const c = candidateFamilies();
    const known = Object.keys(KNOWN_FAMILIES).map(Number);
    expect(c.slice(0, known.length)).toEqual(known);
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
  it('sweeps an unmapped family with both pattern-shaped requests', () => {
    const plan = sweepPlan({ families: [0x1a, 0x1b], index: 4 });
    expect(plan).toEqual([
      { family: 0x1a, type: 0x60, index: 4 },
      { family: 0x1a, type: 0x61, index: 4 },
      { family: 0x1b, type: 0x60, index: 4 },
      { family: 0x1b, type: 0x61, index: 4 },
    ]);
  });

  // Measured 2026-09-06 on an A4 mk1 (OS 1.55B): 0x60 on family 0x06 answers
  // with the whole project — 405 messages, 2.3 MB, 9.5 seconds — which buries
  // the report and eats half a contributor's probe. 0x64 answers with one
  // pattern.
  it('never asks the Analog Four for 0x60: there, that is the whole project', () => {
    const plan = sweepPlan({ families: [0x06], index: 0 });
    expect(plan).toEqual([{ family: 0x06, type: 0x64, index: 0 }]);
    expect(sweepPlan().some(p => p.family === 0x06 && p.type === 0x60)).toBe(false);
    expect(deepPlan([0x06]).some(p => p.type === 0x60)).toBe(false);
  });

  it('deep-probes an unmapped family across the whole request range', () => {
    const plan = deepPlan([0x1a]);
    expect(plan.map(p => p.type)).toEqual(ALL_REQUEST_TYPES);
    expect(plan.every(p => p.family === 0x1a)).toBe(true);
  });

  it('deep-probes a known family with the opcodes it actually serves', () => {
    expect(deepPlan([0x14]).map(p => p.type)).toEqual(Object.keys(REQUEST_TYPES).map(Number));
    expect(deepPlan([0x06]).map(p => p.type)).toEqual(Object.keys(A4_REQUEST_TYPES).map(Number));
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
      streamed: false,
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
    // 0x1a is unmapped, so the line must not name an object: "request 0x61" is
    // a label for a menu, not a fact about this box.
    expect(md).not.toContain('(request 0x61)');
    expect(md).toContain('dump requests only — the probe cannot write');
  });

  it('treats silence as a finding worth posting too', () => {
    const md = contributorReport({ identity, summary: [], probed: 92 });
    expect(md).toContain('No family byte answered');
    expect(md).toContain('please say what box and OS this is anyway');
  });
});

// The Analog Four is gen 1: the same opcode fetches a different object than it
// does on a Digitakt II, and every one of these was measured on an A4 mk1
// (OS 1.55B, build 0195) through the deployed lab on 2026-09-06.
describe('the gen-1 dialect', () => {
  it('reads 0x64 as the pattern on an A4 and as project settings on a digi', () => {
    expect(objectName(0x06, 0x64)).toBe('pattern');
    expect(objectName(0x14, 0x64)).toBe('project settings');
  });

  it('offers the A4 the working-state requests the digis have no equivalent for', () => {
    for (const t of [0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d]) {
      expect(A4_REQUEST_TYPES[t]).toMatch(/^working /);
    }
    expect(requestTypesFor(0x06)[0x6a]).toBe('working pattern');
  });

  it('leaves out the two opcodes the box answers with silence', () => {
    expect(A4_REQUEST_TYPES[0x61]).toBeUndefined();
    expect(A4_REQUEST_TYPES[0x6e]).toBeUndefined();
  });

  it('points a fresh capture at the pattern in whichever dialect the box speaks', () => {
    expect(defaultRequestFor(0x06)).toBe(0x64);
    expect(defaultRequestFor(0x14)).toBe(0x60);
    expect(defaultRequestFor(0x1a)).toBe(0x60); // unmapped: the gen-2 guess is all we have
  });

  it('names no object for a family it has never met', () => {
    expect(objectName(0x1a, 0x60)).toBeNull();
    // …but still offers every request, so the box can be asked.
    expect(Object.keys(requestTypesFor(0x1a)).map(Number)).toEqual(ALL_REQUEST_TYPES);
  });

  it('plans only request opcodes for a gen-1 box too', () => {
    for (const p of [...sweepPlan({ families: [0x06] }), ...deepPlan([0x06])]) {
      expect(p.type >= 0x60 && p.type <= 0x6e).toBe(true);
    }
  });
});

// A whole-project stream is not a list of answers, and printing 405 lines of
// one is how a probe report becomes unreadable.
describe('a family that streams a project', () => {
  const stream = () => {
    const out = [];
    for (let i = 0; i < 128; i++) out.push({ family: 0x06, type: 0x52, index: i, bytes: 2410, ok: true });
    for (let i = 0; i < 128; i++) out.push({ family: 0x06, type: 0x54, index: i, bytes: 12974, ok: true });
    return out;
  };

  it('is flagged rather than listed reply by reply', () => {
    const s = summarizeFindings(stream());
    expect(s[0].streamed).toBe(true);
    const md = contributorReport({
      identity: { name: 'Analog Four', productId: 4, build: '0195', version: '1.55B' },
      summary: s, probed: 92,
    });
    expect(md).toContain('256 messages');
    expect(md).toContain('streams a whole *project*');
    expect(md).toContain('`0x52` × 128');
    expect(md).toContain('`0x54` × 128');
    expect(md.split('\n').length).toBeLessThan(30);
  });

  it('leaves an ordinary handful of replies listed in full', () => {
    const s = summarizeFindings([
      { family: 0x06, type: 0x54, index: 2, bytes: 12974, ok: true },
      { family: 0x06, type: 0x58, index: 1, bytes: 2410, ok: true },
    ]);
    expect(s[0].streamed).toBe(false);
    const md = contributorReport({
      identity: { name: 'Analog Four', productId: 4, build: '0195', version: '1.55B' },
      summary: s, probed: 107,
    });
    expect(md).toContain('`0x64` request → `0x54` response (pattern)');
    expect(md).toContain('`0x68` request → `0x58` response (working kit)');
  });
});
