import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP } from '../js/elektron/protocol.js';
import { diffPayloads } from '../js/elektron/pattern-core.js';
import * as dt2 from '../js/elektron/dt2/pattern.js';
import * as dn2 from '../js/elektron/dn2/pattern.js';
import { readSwing, applySwing, SWING_MIN, SWING_MAX } from '../js/elektron/pattern-settings.js';

// Swing: one byte in the pattern's settings tail, holding the offset from
// straight rather than the percentage the box shows. Mapped 2026-08-04 by
// controlled experiment on a DN2 — the fixtures below are that experiment, and
// the DT2 side rides on the sibling offset both format docs had already flagged
// as an unknown pattern setting.
//
// dumps/ is gitignored (personal patterns), so fixture-backed cases skip on
// checkouts without them; the pure round-trip cases always run.
const F = name => fileURLToPath(new URL(`../dumps/${name}`, import.meta.url));
const kit = file => splitSysExStream(new Uint8Array(readFileSync(file)))
  .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT)[0].payload;

const FRESH_78 = F('dn2-fresh-A01.syx');   // A01, swing 78, fresh project
const FRESH_BLANK = F('dn2-fresh-A02.syx'); // A02, untouched blank alongside it
const FRESH_65 = F('dn2-swing-65.syx');     // the same A01 moved to 65
const DT2_PROJECT = F('digitakt2-project-2026-08-01T23-37-04.syx');
const haveSwing = [FRESH_78, FRESH_BLANK, FRESH_65].every(existsSync);
const haveDt2 = existsSync(DT2_PROJECT);

// A payload big enough to hold the swing byte, for the maths-only cases.
const blank = spec => new Uint8Array(spec.pattern.size + 64);

describe('swing encoding, on both specs', () => {
  for (const [name, mod] of [['DT2', dt2], ['DN2', dn2]]) {
    describe(name, () => {
      const spec = mod.SPEC;

      it('reads a zero byte as straight', () => {
        expect(readSwing(spec, blank(spec))).toBe(SWING_MIN);
      });

      it('round-trips every value the box can hold', () => {
        for (let v = SWING_MIN; v <= SWING_MAX; v++) {
          const buf = blank(spec);
          applySwing(spec, buf, v);
          expect(readSwing(spec, buf)).toBe(v);
        }
      });

      it('stores the offset from straight, not the percentage', () => {
        const buf = blank(spec);
        applySwing(spec, buf, 78);
        expect(buf[spec.pattern.nameOffset + 24]).toBe(28);
        applySwing(spec, buf, SWING_MIN);
        expect(buf[spec.pattern.nameOffset + 24]).toBe(0);
      });

      it('moves exactly one byte', () => {
        const before = blank(spec);
        const after = applySwing(spec, Uint8Array.from(before), 72);
        expect(diffPayloads(before, after, 1000)).toEqual([
          { offset: spec.pattern.nameOffset + 24, sent: 0, read: 22 },
        ]);
      });

      it('clamps out-of-range requests instead of writing nonsense', () => {
        const buf = blank(spec);
        applySwing(spec, buf, 999);
        expect(readSwing(spec, buf)).toBe(SWING_MAX);
        applySwing(spec, buf, 0);
        expect(readSwing(spec, buf)).toBe(SWING_MIN);
        applySwing(spec, buf, 64.6);
        expect(readSwing(spec, buf)).toBe(65);
      });

      it('treats null as straight — there is no "unset" to store', () => {
        const buf = blank(spec);
        applySwing(spec, buf, 70);
        applySwing(spec, buf, null);
        expect(readSwing(spec, buf)).toBe(SWING_MIN);
      });

      it('reads a byte past the range as straight rather than throwing', () => {
        // A moved field must not stop a pattern opening.
        const buf = blank(spec);
        buf[spec.pattern.nameOffset + 24] = 0xff;
        expect(readSwing(spec, buf)).toBe(SWING_MIN);
      });
    });
  }
});

describe.skipIf(!haveSwing)('the DN2 hardware capture the mapping came from', () => {
  const spec = dn2.SPEC;

  it('reads 78 off the pattern that was set to 78', () => {
    expect(readSwing(spec, kit(FRESH_78))).toBe(78);
  });

  it('reads 65 after the box was moved to 65', () => {
    expect(readSwing(spec, kit(FRESH_65))).toBe(65);
  });

  it('reads an untouched blank as straight', () => {
    expect(readSwing(spec, kit(FRESH_BLANK))).toBe(SWING_MIN);
  });

  it('is the only byte that moved between 78 and 65 — the experiment itself', () => {
    expect(diffPayloads(kit(FRESH_78), kit(FRESH_65), 100000)).toEqual([
      { offset: spec.pattern.nameOffset + 24, sent: 28, read: 15 },
    ]);
  });

  it('writes back onto real hardware bytes without disturbing anything else', () => {
    const original = kit(FRESH_65);
    const after = applySwing(spec, Uint8Array.from(original), 78);
    expect(diffPayloads(after, kit(FRESH_78), 100000)).toEqual([]);
  });
});

describe.skipIf(!haveDt2)('the DT2 sibling offset', () => {
  it('finds swing at the byte the format doc flagged as unknown', () => {
    // One pattern out of 128 was edited on the box; the rest are straight.
    const kits = splitSysExStream(new Uint8Array(readFileSync(DT2_PROJECT)))
      .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);
    const swings = kits.map(m => readSwing(dt2.SPEC, m.payload));
    expect(swings.filter(s => s === SWING_MIN)).toHaveLength(127);
    expect(swings.filter(s => s !== SWING_MIN)).toEqual([55]);
  });
});
