import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP } from '../js/elektron/protocol.js';
import {
  CONDITIONS, COND_GROUPS, COND_BY_DENOMINATOR, NONE,
  condFromByte, condToByte, isCondKey, condDescription,
  probFromByte, probToByte, fillFromByte, fillToByte,
  isDefaultTrigSetting, trigSettingLabel,
} from '../js/elektron/conditions.js';
import {
  readTrackTrigSettings, readStepTrigSetting, applyTrackTrigSettings, trigSettingsFromNotes,
} from '../js/elektron/trig-cond.js';
import * as dt2 from '../js/elektron/dt2/pattern.js';
import * as dn2 from '../js/elektron/dn2/pattern.js';
import { attachTrigSettings } from '../js/roll-bridge.js';

// The Stage 0 hardware fixtures: one pattern-kit message each, captured
// 2026-08-02 with known PROB/FILL/COND on known steps of track 1. The DT2 one
// also carries a deleted trig (step 16) whose FILL/PROB bytes the box left
// behind — see the [V2] logs in docs/.
const DT2_FIXTURE = fileURLToPath(new URL('../dumps/fixtures/digitakt2-A01-conditions-2026-08-02.syx', import.meta.url));
const DN2_FIXTURE = fileURLToPath(new URL('../dumps/fixtures/digitone2-A01-conditions-2026-08-02.syx', import.meta.url));
const PROJECT_FIXTURE = fileURLToPath(new URL('../dumps/digitakt2-project-2026-08-01T23-37-04.syx', import.meta.url));

const payloadOf = file => splitSysExStream(new Uint8Array(readFileSync(file)))
  .find(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT).payload;

const haveDt2 = existsSync(DT2_FIXTURE);
const haveDn2 = existsSync(DN2_FIXTURE);
const haveProject = existsSync(PROJECT_FIXTURE);

describe('the COND table', () => {
  it('has the 76 values the hardware menu has, in menu order', () => {
    expect(CONDITIONS.length).toBe(76);
    expect(CONDITIONS[0].key).toBe('PRE');
    expect(CONDITIONS[75].key).toBe('!8:8');
  });

  it('matches every value pinned on hardware', () => {
    // Indices 0-15 were walked one trig at a time; 16/27/44/52/75 are the
    // anchors that confirmed the extrapolated ordering, and 18/19 were
    // re-confirmed independently on the DN2.
    const pinned = {
      0: 'PRE', 1: '!PRE', 2: 'NEI', 3: '!NEI', 4: '1ST', 5: '!1ST', 6: 'LST', 7: '!LST',
      8: '1:2', 9: '2:2', 10: '1:3', 11: '!1:3', 12: '2:3', 13: '!2:3', 14: '3:3', 15: '!3:3',
      16: '1:4', 18: '2:4', 19: '!2:4', 27: '!2:5', 44: '6:6', 52: '4:7', 75: '!8:8',
    };
    for (const [value, key] of Object.entries(pinned)) {
      expect(CONDITIONS[value].key, `index ${value}`).toBe(key);
    }
  });

  it('gives the :2 group no negations, because they would be redundant', () => {
    expect(CONDITIONS.filter(c => c.b === 2).map(c => c.key)).toEqual(['1:2', '2:2']);
    expect(isCondKey('!1:2')).toBe(false);
  });

  it('round-trips every value through byte and back', () => {
    for (const c of CONDITIONS) {
      expect(condToByte(c.key)).toBe(c.value);
      expect(condFromByte(c.value)).toBe(c.key);
    }
  });

  it('treats FF and null as "no condition"', () => {
    expect(condFromByte(NONE)).toBeNull();
    expect(condToByte(null)).toBe(NONE);
    expect(condToByte('')).toBe(NONE);
  });

  it('decodes an unknown stored value to null with a warning, never a throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(condFromByte(76)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('throws on an unknown label, which would be our bug not the box\'s', () => {
    expect(() => condToByte('9:9')).toThrow(/unknown trig condition/);
  });

  it('groups every value exactly once for the picker', () => {
    const grouped = COND_GROUPS.flatMap(g => g.items);
    expect(grouped.length).toBe(CONDITIONS.length);
    expect(new Set(grouped.map(c => c.key)).size).toBe(CONDITIONS.length);
    expect(COND_BY_DENOMINATOR.flatMap(d => d.items).length).toBe(68);
  });

  it('describes ratios and their negations in opposite terms', () => {
    expect(condDescription('2:4')).toMatch(/loop 2 of every 4/);
    expect(condDescription('!2:4')).toMatch(/EXCEPT loop 2/);
    expect(condDescription('1ST')).toMatch(/first loop/);
    expect(condDescription('!1ST')).toMatch(/NOT/);
  });
});

describe('PROB and FILL encodings', () => {
  it('stores probability as the percentage itself', () => {
    for (const p of [0, 5, 45, 75, 100]) expect(probToByte(p)).toBe(p);
    expect(probFromByte(0)).toBe(0);
    expect(probFromByte(0x4b)).toBe(75);
  });

  it('keeps an explicit 100% lock distinct from no lock, as the box does', () => {
    expect(probFromByte(0x64)).toBe(100);
    expect(probFromByte(NONE)).toBeNull();
    expect(probToByte(null)).toBe(NONE);
    expect(probToByte(100)).toBe(0x64);
  });

  it('treats fill as a tri-state', () => {
    expect(fillFromByte(0x01)).toBe(true);
    expect(fillFromByte(0x00)).toBe(false);
    expect(fillFromByte(NONE)).toBeNull();
    expect(fillToByte(true)).toBe(0x01);
    expect(fillToByte(false)).toBe(0x00);
    expect(fillToByte(null)).toBe(NONE);
  });

  it('knows when a setting is entirely default', () => {
    expect(isDefaultTrigSetting(null)).toBe(true);
    expect(isDefaultTrigSetting({ prob: null, fill: null, cond: null })).toBe(true);
    // false is a real FILL OFF lock, not an absence
    expect(isDefaultTrigSetting({ prob: null, fill: false, cond: null })).toBe(false);
    expect(isDefaultTrigSetting({ prob: 0, fill: null, cond: null })).toBe(false);
  });

  it('builds a badge from whatever is set', () => {
    expect(trigSettingLabel({ cond: '2:4', prob: 50 })).toBe('2:4 50%');
    expect(trigSettingLabel({})).toBe('');
    expect(trigSettingLabel({ fill: true })).toBe('F');
  });
});

describe.skipIf(!haveDt2)('reading the DT2 hardware fixture', () => {
  const payload = haveDt2 ? payloadOf(DT2_FIXTURE) : null;
  const byStep = haveDt2 ? readTrackTrigSettings(dt2.SPEC, payload, 0) : null;

  it('decodes exactly the values set on the box, on exactly the right steps', () => {
    // Steps 1-16 as Neil left them; step index is 0-based here.
    const expected = {
      0:  { cond: '1:4',  fill: true,  prob: 0 },
      1:  { cond: '!2:5', fill: true,  prob: 5 },
      2:  { cond: '6:6',  fill: true,  prob: 10 },
      3:  { cond: '4:7',  fill: true,  prob: 15 },
      4:  { cond: '!8:8', fill: true,  prob: 20 },
      5:  { cond: null,   fill: true,  prob: 25 },   // COND cleared
      6:  { cond: 'LST',  fill: true,  prob: null }, // PROB lock cleared
      7:  { cond: '!LST', fill: null,  prob: 35 },   // FILL lock cleared
      8:  { cond: '1:2',  fill: false, prob: 40 },
      9:  { cond: '2:2',  fill: false, prob: 100 },  // explicit 100% lock
      10: { cond: '1:3',  fill: false, prob: 50 },
      11: { cond: '!1:3', fill: false, prob: 55 },
      12: { cond: '2:3',  fill: false, prob: 60 },
      13: { cond: '!2:3', fill: false, prob: 65 },
      14: { cond: '3:3',  fill: false, prob: 70 },
      // Trig 16 was deleted before this capture: the box cleared its COND but
      // left FILL and PROB behind.
      15: { cond: null,   fill: false, prob: 75 },
    };
    expect(Object.fromEntries(byStep)).toEqual(expected);
  });

  it('finds nothing on any other track', () => {
    for (let t = 1; t < dt2.SPEC.pattern.numTracks; t++) {
      expect(readTrackTrigSettings(dt2.SPEC, payload, t).size, `track ${t + 1}`).toBe(0);
    }
  });

  it('leaves settings on steps whose trig was deleted — the caller decides', () => {
    // The box clears COND on delete but leaves FILL and PROB behind. Steps 15
    // and 16 are dead yet still carry bytes; nothing here filters them out.
    const kit = dt2.decodePatternKit(payload);
    expect(kit.tracks[0].steps[15] & 1).toBe(0);
    expect(byStep.get(15)).toEqual({ cond: null, fill: false, prob: 75 });
  });

  it('reads one step at a time consistently with the whole-track read', () => {
    for (let s = 0; s < dt2.SPEC.track.numSteps; s++) {
      expect(readStepTrigSetting(dt2.SPEC, payload, 0, s)).toEqual(byStep.get(s) ?? null);
    }
  });

  it('records the track-level PROB default the box showed', () => {
    const at = dt2.SPEC.pattern.tracksOffset + dt2.SPEC.track.trackProb;
    expect(payload[at]).toBe(100);
  });
});

describe.skipIf(!haveDn2)('reading the DN2 hardware fixture', () => {
  const payload = haveDn2 ? payloadOf(DN2_FIXTURE) : null;

  it('decodes the same way at the same track-relative offsets', () => {
    expect(Object.fromEntries(readTrackTrigSettings(dn2.SPEC, payload, 0))).toEqual({
      0: { cond: 'PRE',  fill: null,  prob: null },
      1: { cond: '!8:8', fill: null,  prob: null },
      2: { cond: '2:4',  fill: null,  prob: null },
      3: { cond: '!2:4', fill: null,  prob: null },
      4: { cond: null,   fill: null,  prob: 45 },
      5: { cond: null,   fill: true,  prob: null },
      6: { cond: null,   fill: false, prob: null },
    });
  });

  it('leaves the plain control trig with nothing stored', () => {
    expect(readStepTrigSetting(dn2.SPEC, payload, 0, 7)).toBeNull();
  });
});

describe.skipIf(!haveProject)('a project dump captured before the feature existed', () => {
  // An independent check on the mapping: this dump predates the experiment by a
  // day and nobody was thinking about conditions when it was taken. Two of its
  // trigs carry "a single small value in the first per-step array" that
  // dt2-pattern-format.md recorded as unexplained — the mapping says they are
  // COND locks, and they decode as valid conditions on live trigs.
  const kits = splitSysExStream(new Uint8Array(readFileSync(PROJECT_FIXTURE)))
    .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);

  it('explains the two previously-unknown lane bytes as COND locks', () => {
    const found = [];
    for (const m of kits) {
      for (let t = 0; t < dt2.SPEC.pattern.numTracks; t++) {
        for (const [step, setting] of readTrackTrigSettings(dt2.SPEC, m.payload, t)) {
          const live = !!(dt2.decodePatternKit(m.payload).tracks[t].steps[step] & 1);
          found.push({ pattern: m.index, track: t, step, live, ...setting });
        }
      }
    }
    expect(found).toEqual([
      { pattern: 0, track: 1, step: 6, live: true, prob: null, fill: null, cond: '2:2' },
      { pattern: 0, track: 9, step: 7, live: true, prob: null, fill: null, cond: '1:2' },
    ]);
  });

  it('reads an empty map for the 15 tracks that never had one', () => {
    const p0 = kits.find(m => m.index === 0).payload;
    for (const t of [0, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]) {
      expect(readTrackTrigSettings(dt2.SPEC, p0, t).size, `track ${t + 1}`).toBe(0);
    }
  });
});

describe('trigSettingsFromNotes', () => {
  const note = (step, pitch, extra = {}) => ({ step, pitch, prob: null, fill: null, cond: null, ...extra });

  it('takes each step\'s values from its first note, like the encoder does', () => {
    const notes = [
      note(4, 72, { cond: '2:4' }),
      note(4, 60, { cond: 'PRE' }), // lower pitch sorts first, so PRE wins
    ];
    expect(trigSettingsFromNotes(notes).get(4)).toEqual({ prob: null, fill: null, cond: 'PRE' });
  });

  it('skips steps where all three are default', () => {
    expect(trigSettingsFromNotes([note(0, 60), note(1, 60)]).size).toBe(0);
  });

  it('keeps a FILL OFF lock, which is not the same as no lock', () => {
    expect(trigSettingsFromNotes([note(2, 60, { fill: false })]).get(2))
      .toEqual({ prob: null, fill: false, cond: null });
  });
});

describe('attachTrigSettings', () => {
  it('stamps a step\'s settings onto every note on that step', () => {
    const notes = [{ step: 3, pitch: 60 }, { step: 3, pitch: 64 }, { step: 5, pitch: 67 }];
    attachTrigSettings(notes, new Map([[3, { prob: 50, fill: true, cond: '2:4' }]]));
    expect(notes[0]).toMatchObject({ prob: 50, fill: true, cond: '2:4' });
    expect(notes[1]).toMatchObject({ prob: 50, fill: true, cond: '2:4' });
    expect(notes[2].cond).toBeUndefined(); // untouched step keeps its defaults
  });

  it('is a no-op for an empty map', () => {
    const notes = [{ step: 0, pitch: 60 }];
    expect(attachTrigSettings(notes, new Map())).toBe(notes);
  });
});

describe.skipIf(!haveDt2)('applyTrackTrigSettings', () => {
  const payload = haveDt2 ? payloadOf(DT2_FIXTURE) : null;
  const laneStart = (spec, lane, track) =>
    spec.pattern.tracksOffset + track * spec.track.size + lane;

  it('scrubs the track\'s three lanes before writing, so nothing is inherited', () => {
    const out = applyTrackTrigSettings(dt2.SPEC, Uint8Array.from(payload), 0, new Map());
    for (const lane of [dt2.SPEC.track.trigCond, dt2.SPEC.track.trigFill, dt2.SPEC.track.trigProb]) {
      const start = laneStart(dt2.SPEC, lane, 0);
      expect([...out.subarray(start, start + 128)].every(b => b === NONE)).toBe(true);
    }
  });

  it('touches nothing outside this track\'s three lanes', () => {
    const out = applyTrackTrigSettings(dt2.SPEC, Uint8Array.from(payload), 0,
      new Map([[2, { prob: 33, fill: false, cond: 'NEI' }]]));
    const inLanes = new Set();
    for (const lane of [dt2.SPEC.track.trigCond, dt2.SPEC.track.trigFill, dt2.SPEC.track.trigProb]) {
      const start = laneStart(dt2.SPEC, lane, 0);
      for (let i = start; i < start + 128; i++) inLanes.add(i);
    }
    const strayed = [];
    for (let i = 0; i < payload.length; i++) {
      if (payload[i] !== out[i] && !inLanes.has(i)) strayed.push(i);
    }
    expect(strayed).toEqual([]);
  });

  it('never touches another track\'s lanes', () => {
    const spec = dt2.SPEC;
    const seeded = Uint8Array.from(payload);
    // Put a marker in track 2's PROB lane and prove writing track 1 leaves it.
    const marker = laneStart(spec, spec.track.trigProb, 1) + 7;
    seeded[marker] = 42;
    const out = applyTrackTrigSettings(spec, Uint8Array.from(seeded), 0,
      new Map([[0, { prob: 10, fill: true, cond: 'PRE' }]]));
    expect(out[marker]).toBe(42);
  });

  it('round-trips settings written then read back', () => {
    const written = new Map([
      [0, { prob: 0, fill: true, cond: 'PRE' }],
      [7, { prob: 100, fill: false, cond: '!8:8' }],
      [63, { prob: 55, fill: null, cond: null }],
      [127, { prob: null, fill: null, cond: '2:4' }],
    ]);
    const out = applyTrackTrigSettings(dt2.SPEC, Uint8Array.from(payload), 0, written);
    expect(Object.fromEntries(readTrackTrigSettings(dt2.SPEC, out, 0)))
      .toEqual(Object.fromEntries(written));
  });

  it('drops steps outside the track and all-default settings', () => {
    const out = applyTrackTrigSettings(dt2.SPEC, Uint8Array.from(payload), 0, new Map([
      [128, { prob: 50, fill: null, cond: null }],
      [-1, { prob: 50, fill: null, cond: null }],
      [4, { prob: null, fill: null, cond: null }],
    ]));
    expect(readTrackTrigSettings(dt2.SPEC, out, 0).size).toBe(0);
  });

  it('refuses a track index the pattern does not have', () => {
    expect(() => applyTrackTrigSettings(dt2.SPEC, Uint8Array.from(payload), 16, new Map()))
      .toThrow(/no track/);
  });
});
