import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateArrangement, generatePart, applyPartToPattern, ROLE_ORDER } from '../js/gen/arrange.js';
import {
  defaultGenContext, normalizeGenContext, GEN_ROLES,
  withVariationBumped, withVariationsReset, partLabel, roleForSlot,
} from '../js/gen/context.js';
import { GENRE_IDS } from '../js/gen/genres.js';
import { defaultPattern, PLOCK_STEPS } from '../js/state.js';
import { splitSysExStream, DUMP } from '../js/elektron/protocol.js';
import * as dt2 from '../js/elektron/dt2/pattern.js';
import * as dn2 from '../js/elektron/dn2/pattern.js';
import { rollNotesToDevice, rollPLocksToDevice } from '../js/roll-bridge.js';
import { applyTrackPLocks, readTrackPLocks } from '../js/elektron/plocks.js';
import {
  applyTrackTrigSettings, readTrackTrigSettings, trigSettingsFromNotes,
} from '../js/elektron/trig-cond.js';

const ctx = (over = {}) => normalizeGenContext({ ...defaultGenContext(), ...over });
const shape = notes => notes.map(n => `${n.step}:${n.pitch}:${n.len}:${n.velocity}:${n.micro}`).join('|');

describe('an arrangement', () => {
  it('is three parts, in band order', () => {
    const { parts } = generateArrangement(ctx({ seed: 1 }));
    expect(Object.keys(parts)).toEqual(['bass', 'chords', 'lead']);
    expect(ROLE_ORDER).toEqual(GEN_ROLES);
    for (const role of GEN_ROLES) {
      expect(parts[role].notes.length).toBeGreaterThan(0);
      expect(parts[role].role).toBe(role);
      expect(parts[role].slot).toBe(ctx().parts[role].slot);
    }
  });

  it('gives every note a unique id, so a slot can hold it straight away', () => {
    const { parts } = generateArrangement(ctx({ seed: 2 }));
    const ids = GEN_ROLES.flatMap(r => parts[r].notes.map(n => n.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes its length from the bar count', () => {
    for (const bars of [1, 2, 4, 8]) {
      const { parts, context } = generateArrangement(ctx({ bars, seed: 3 }));
      expect(context.lengthSteps).toBe(bars * 16);
      for (const role of GEN_ROLES) {
        expect(parts[role].lengthSteps).toBe(bars * 16);
        for (const n of parts[role].notes) expect(n.step).toBeLessThan(bars * 16);
      }
    }
  });

  it('counts trigs, not notes — a chord is one trig', () => {
    const { parts } = generateArrangement(ctx({ seed: 4 }));
    expect(parts.chords.trigCount).toBeLessThan(parts.chords.notes.length);
    expect(parts.chords.trigCount).toBe(new Set(parts.chords.notes.map(n => n.step)).size);
  });

  it('throws the parser\'s message for a malformed progression', () => {
    expect(() => generateArrangement(ctx({ progression: 'i nonsense' }))).toThrow(/roman numerals/);
  });

  it('generates something for every genre', () => {
    for (const genre of GENRE_IDS) {
      const { parts } = generateArrangement(ctx({ genre, seed: 5 }));
      for (const role of GEN_ROLES) expect(parts[role].notes.length).toBeGreaterThan(0);
    }
  });
});

describe('the seed', () => {
  it('makes a result reproducible', () => {
    const a = generateArrangement(ctx({ seed: 12345 }));
    const b = generateArrangement(ctx({ seed: 12345 }));
    for (const role of GEN_ROLES) expect(shape(b.parts[role].notes)).toBe(shape(a.parts[role].notes));
  });

  it('changes everything when it changes', () => {
    const a = generateArrangement(ctx({ seed: 12345 }));
    const b = generateArrangement(ctx({ seed: 12346 }));
    const different = GEN_ROLES.filter(r => shape(b.parts[r].notes) !== shape(a.parts[r].notes));
    expect(different.length).toBe(3);
  });

  it('keeps the bass still when only the lead\'s density moves — the point of per-part streams', () => {
    const base = ctx({ seed: 999 });
    const moved = {
      ...base,
      parts: { ...base.parts, lead: { ...base.parts.lead, density: base.parts.lead.density + 30 } },
    };
    const a = generateArrangement(base);
    const b = generateArrangement(moved);
    expect(shape(b.parts.bass.notes)).toBe(shape(a.parts.bass.notes));
    expect(shape(b.parts.chords.notes)).toBe(shape(a.parts.chords.notes));
    expect(shape(b.parts.lead.notes)).not.toBe(shape(a.parts.lead.notes));
  });

  it('keeps the music still when only Motion moves — lanes draw on their own stream', () => {
    const base = ctx({ seed: 555, feel: { motion: 0, looseness: 40, humanize: 20 } });
    const moved = { ...base, feel: { ...base.feel, motion: 100 } };
    const a = generateArrangement(base, { deviceKind: 'DN2' });
    const b = generateArrangement(moved, { deviceKind: 'DN2' });
    for (const role of GEN_ROLES) expect(shape(b.parts[role].notes)).toBe(shape(a.parts[role].notes));
    expect(a.parts.bass.plocks.length).toBe(0);
    expect(b.parts.bass.plocks.length).toBeGreaterThan(0);
  });

  it('leaves the lead alone when the bass is unchecked', () => {
    // Every part is generated whether or not it is applied, precisely so that
    // turning one off doesn't reshuffle the ones that answer it.
    const base = ctx({ seed: 31337 });
    const off = { ...base, parts: { ...base.parts, bass: { ...base.parts.bass, on: false } } };
    const a = generateArrangement(base);
    const b = generateArrangement(off);
    expect(shape(b.parts.lead.notes)).toBe(shape(a.parts.lead.notes));
    expect(b.parts.bass.on).toBe(false);
    expect(b.parts.bass.notes.length).toBeGreaterThan(0);
  });
});

describe('the band', () => {
  it('threads the rhythm map forward, so the lead answers the bass', () => {
    let doubled = 0;
    let total = 0;
    for (let seed = 0; seed < 25; seed++) {
      const { parts } = generateArrangement(ctx({ seed, bars: 2 }));
      const bass = new Set(parts.bass.notes.map(n => n.step));
      for (const n of parts.lead.notes) {
        total++;
        if (bass.has(n.step)) doubled++;
      }
    }
    expect(doubled / total).toBeLessThan(0.35);
  });
});

describe('regenerating one part', () => {
  it('produces exactly the part the whole arrangement would have', () => {
    const c = ctx({ seed: 24680 });
    const whole = generateArrangement(c);
    for (const role of GEN_ROLES) {
      const { part } = generatePart(c, role);
      expect(shape(part.notes)).toBe(shape(whole.parts[role].notes));
    }
  });

  it('refuses a role nobody has written', () => {
    expect(() => generatePart(ctx(), 'drums')).toThrow(/unknown part/);
  });

  it('re-rolls one part and leaves the others exactly where they were', () => {
    // What "Generate this slot" does: bump that part's variation, not the seed.
    const base = ctx({ seed: 1357 });
    const rerolled = withVariationBumped(base, 'lead');
    const a = generateArrangement(base);
    const b = generateArrangement(rerolled);
    expect(shape(b.parts.bass.notes)).toBe(shape(a.parts.bass.notes));
    expect(shape(b.parts.chords.notes)).toBe(shape(a.parts.chords.notes));
    expect(shape(b.parts.lead.notes)).not.toBe(shape(a.parts.lead.notes));
  });

  it('keeps a re-rolled lead answering the bass that is actually in the slot', () => {
    let doubled = 0;
    let total = 0;
    for (let seed = 0; seed < 15; seed++) {
      let c = ctx({ seed, bars: 2 });
      const bass = new Set(generateArrangement(c).parts.bass.notes.map(n => n.step));
      for (let take = 1; take <= 3; take++) {
        c = withVariationBumped(c, 'lead');
        const { parts } = generateArrangement(c);
        // The bass is untouched by the lead's re-roll…
        expect(new Set(parts.bass.notes.map(n => n.step))).toEqual(bass);
        for (const n of parts.lead.notes) {
          total++;
          if (bass.has(n.step)) doubled++;
        }
      }
    }
    // …so each new lead still sits in its gaps.
    expect(doubled / total).toBeLessThan(0.35);
  });

  it('goes back to the canonical arrangement when the variations are reset', () => {
    const base = ctx({ seed: 2468 });
    const messy = withVariationBumped(withVariationBumped(base, 'lead'), 'bass');
    const a = generateArrangement(base);
    const b = generateArrangement(withVariationsReset(messy));
    for (const role of GEN_ROLES) expect(shape(b.parts[role].notes)).toBe(shape(a.parts[role].notes));
  });

  it('names a generated slot after its genre and part', () => {
    expect(partLabel(ctx({ genre: 'dnb' }), 'bass')).toBe('DnB bass');
    expect(partLabel(ctx({ genre: 'house' }), 'chords')).toBe('House chords');
  });

  it('knows which part a slot is holding', () => {
    const c = ctx();
    expect(roleForSlot(c, 0)).toBe('bass');
    expect(roleForSlot(c, 2)).toBe('lead');
    expect(roleForSlot(c, 7)).toBe(null);
  });
});

describe('p-lock lanes on a part', () => {
  it('are real lanes, keyed by name and box, spanning the pattern memory', () => {
    const { parts } = generateArrangement(ctx({ seed: 6, feel: { motion: 100, looseness: 30, humanize: 20 } }),
      { deviceKind: 'DT2' });
    const lanes = parts.bass.plocks;
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) {
      expect(lane.name).toBeTruthy();
      expect(lane.paramId).toBe(null);      // named lanes resolve their byte on the way out
      expect(lane.deviceKind).toBe('DT2');
      expect(lane.trigless).toBe(false);
      expect(lane.values.length).toBe(PLOCK_STEPS);
    }
  });

  it('only sit on steps the part actually trigs', () => {
    const { parts } = generateArrangement(ctx({ seed: 7, feel: { motion: 90, looseness: 40, humanize: 10 } }),
      { deviceKind: 'DN2' });
    for (const role of GEN_ROLES) {
      const live = new Set(parts[role].notes.map(n => n.step));
      for (const lane of parts[role].plocks) {
        lane.values.forEach((v, step) => {
          if (v != null) expect(live.has(step), `${role} lane value on trigless step ${step}`).toBe(true);
        });
      }
    }
  });

  it('are absent, with a warning, when no box can be resolved', () => {
    const { parts, warnings } = generateArrangement(
      ctx({ seed: 8, feel: { motion: 100, looseness: 20, humanize: 0 } }), { deviceKind: null });
    for (const role of GEN_ROLES) expect(parts[role].plocks).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/which box/);
  });

  it('report that warning once, not once per part', () => {
    const { warnings } = generateArrangement(ctx({ feel: { motion: 50, looseness: 0, humanize: 0 } }),
      { deviceKind: null });
    expect(new Set(warnings).size).toBe(warnings.length);
  });

  it('say nothing about a box when Motion is off — no lanes were wanted', () => {
    const { warnings } = generateArrangement(ctx({ feel: { motion: 0, looseness: 20, humanize: 0 } }),
      { deviceKind: null });
    expect(warnings).toEqual([]);
  });
});

describe('applying a part to a slot — the safety story', () => {
  it('replaces the music and leaves every other field alone', () => {
    const before = {
      ...defaultPattern(3),
      channel: 9, swing: 66, trackProb: 40,
      source: { slug: 'digitakt2', patternIndex: 5, trackIndex: 2 },
      dest: { patternIndex: 5, trackIndex: 2 },
    };
    const pattern = { ...before };
    const { parts } = generateArrangement(ctx({ seed: 9, bars: 4 }), { deviceKind: 'DT2' });
    applyPartToPattern(pattern, parts.bass, { label: 'DnB bass' });

    expect(pattern.notes).toBe(parts.bass.notes);
    expect(pattern.plocks).toBe(parts.bass.plocks);
    expect(pattern.lengthSteps).toBe(64);
    expect(pattern.name).toBe('DnB bass');
    // The four the generator must never touch.
    expect(pattern.swing).toBe(66);
    expect(pattern.trackProb).toBe(40);
    expect(pattern.channel).toBe(9);
    expect(pattern.source).toBe(before.source);
    expect(pattern.dest).toBe(before.dest);
  });

  it('keeps the slot\'s name when it isn\'t given one', () => {
    const pattern = defaultPattern(0);
    const { parts } = generateArrangement(ctx({ seed: 10 }));
    applyPartToPattern(pattern, parts.lead);
    expect(pattern.name).toBe('Pattern 1');
  });

  it('never produces a pattern carrying a swing or trackProb opinion', () => {
    // Belt and braces: nothing in a generated part even has those fields.
    const { parts } = generateArrangement(ctx({ seed: 11 }), { deviceKind: 'DN2' });
    for (const role of GEN_ROLES) {
      expect(parts[role]).not.toHaveProperty('swing');
      expect(parts[role]).not.toHaveProperty('trackProb');
    }
  });
});

// --- Does it survive the write path? -------------------------------------------
//
// The feature's claim is that it adds no write surface: what it produces is
// ordinary pattern state that leaves through the existing, hardware-verified
// encode path. This is that claim, tested against real dumps — notes, per-trig
// conditions and p-lock lanes all encoded into a fixture and read back.
//
// dumps/ is gitignored, so this skips on a checkout without them.
const DT2_FIXTURE = fileURLToPath(new URL('../dumps/digitakt2-project-2026-08-01T23-37-04.syx', import.meta.url));
const DN2_FIXTURE = fileURLToPath(new URL('../dumps/digitone2-project-2026-08-01.syx', import.meta.url));
const have = existsSync(DT2_FIXTURE) && existsSync(DN2_FIXTURE);

const payloadOf = (file, index) => splitSysExStream(new Uint8Array(readFileSync(file)))
  .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT)
  .find(m => m.index === index).payload;

const BOXES = have ? [
  { name: 'DT2', mod: dt2, payload: payloadOf(DT2_FIXTURE, 0) },
  { name: 'DN2', mod: dn2, payload: payloadOf(DN2_FIXTURE, 0) },
] : [];

describe.skipIf(!have)('a generated part through the real write path', () => {
  for (const box of BOXES) {
    describe(box.name, () => {
      const trackIndex = 3;
      const kind = box.mod.SPEC.device;

      // Exactly the sequence safeWriteTrack runs, minus the device conversation:
      // encode the notes, stamp the per-trig lanes, then the p-lock lanes.
      const encode = (part, base = box.payload) => {
        const { lanes, warnings } = rollPLocksToDevice(part.plocks, kind);
        expect(warnings).toEqual([]);
        const notes = rollNotesToDevice(part.notes);
        const { payload } = box.mod.encodeTrackNotes(base, trackIndex, notes);
        applyTrackTrigSettings(box.mod.SPEC, payload, trackIndex, trigSettingsFromNotes(notes));
        expect(applyTrackPLocks(box.mod.SPEC, payload, trackIndex, lanes).warnings).toEqual([]);
        return payload;
      };

      it('encodes every note the generator drew, and reads them back identically', () => {
        const { parts } = generateArrangement(
          ctx({ seed: 4242, bars: 2, feel: { motion: 80, looseness: 60, humanize: 30 } }),
          { deviceKind: kind });
        for (const role of GEN_ROLES) {
          const payload = encode(parts[role]);
          const back = box.mod.trackNotes(box.mod.decodePatternKit(payload), trackIndex)
            .filter(n => n.step < parts[role].lengthSteps);
          expect(back.length, role).toBe(parts[role].notes.length);
          const want = [...parts[role].notes].sort((a, b) => a.step - b.step || a.pitch - b.pitch);
          const got = [...back].sort((a, b) => a.step - b.step || a.pitch - b.pitch);
          got.forEach((n, i) => {
            expect(n.pitch, `${role} pitch`).toBe(want[i].pitch);
            expect(n.velocity, `${role} velocity`).toBe(want[i].velocity);
            expect(n.lenSteps, `${role} length`).toBeCloseTo(want[i].len, 6);
            expect(n.micro, `${role} micro`).toBeCloseTo(want[i].micro, 6);
          });
        }
      });

      it('stores the per-trig conditions it wrote', () => {
        const { parts } = generateArrangement(
          ctx({ seed: 77, bars: 2, feel: { motion: 0, looseness: 100, humanize: 0 } }),
          { deviceKind: kind });
        const part = parts.bass;
        const conditioned = part.notes.filter(n => n.prob != null || n.fill != null || n.cond != null);
        expect(conditioned.length).toBeGreaterThan(0);
        const settings = readTrackTrigSettings(box.mod.SPEC, encode(part), trackIndex);
        for (const n of conditioned) {
          expect(settings.get(n.step), `step ${n.step}`).toMatchObject({
            prob: n.prob, fill: n.fill, cond: n.cond,
          });
        }
      });

      it('stores the p-lock lanes it designed, on the right paramIds', () => {
        const { parts } = generateArrangement(
          ctx({ seed: 88, bars: 2, feel: { motion: 100, looseness: 0, humanize: 0 } }),
          { deviceKind: kind });
        const part = parts.chords;
        expect(part.plocks.length).toBeGreaterThan(0);
        const { lanes: wanted } = rollPLocksToDevice(part.plocks, kind);
        const back = readTrackPLocks(box.mod.SPEC, encode(part), trackIndex);
        for (const want of wanted) {
          const got = back.find(l => l.paramId === want.paramId);
          expect(got, `paramId ${want.paramId}`).toBeTruthy();
          expect(got.values).toEqual(want.values);
        }
      });

      it('changes nothing outside the track it was written to', () => {
        const { parts } = generateArrangement(ctx({ seed: 99, bars: 2 }), { deviceKind: kind });
        const payload = encode(parts.lead);
        const before = box.mod.decodePatternKit(box.payload);
        const after = box.mod.decodePatternKit(payload);
        for (let other = 0; other < 16; other++) {
          if (other === trackIndex) continue;
          expect(box.mod.trackNotes(after, other), `track ${other + 1}`)
            .toEqual(box.mod.trackNotes(before, other));
        }
        expect(after.name).toBe(before.name);
        expect(after.tempoBpm).toBe(before.tempoBpm);
        expect(after.kit.soundNames).toEqual(before.kit.soundNames);
      });

      it('writes the same bytes twice for the same seed', () => {
        const once = () => encode(generateArrangement(ctx({ seed: 5150, bars: 2 }),
          { deviceKind: kind }).parts.bass);
        expect(box.mod.diffPayloads(once(), once(), 100000)).toEqual([]);
      });
    });
  }
});
