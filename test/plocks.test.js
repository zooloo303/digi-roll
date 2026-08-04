import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP } from '../js/elektron/protocol.js';
import * as dt2 from '../js/elektron/dt2/pattern.js';
import * as dn2 from '../js/elektron/dn2/pattern.js';
import {
  readLane, readAllPLocks, readTrackPLocks, freeLaneCount, applyTrackPLocks,
  laneHasTriglessValues, NO_VALUE, VALUE_MAX,
} from '../js/elektron/plocks.js';
import {
  param, plainPlock, scaledPlock, paramByPlockId, paramByName,
  clampParamValue, storedFromDisplay, displayFromStored, describeParam,
} from '../js/elektron/params.js';
import {
  DEVICE_KINDS, paramTableFor, auditableParamsFor, writableParamsFor, anyWritableParams,
} from '../js/elektron/param-tables.js';
import { plockLanesForTarget, copyTrack } from '../js/elektron/copy-track.js';
import {
  devicePLocksToRoll, rollPLocksToDevice, pruneLanesToTrigs, plockMessagesForStep, hasAuditableLanes,
} from '../js/roll-bridge.js';
import { makePLockLane, PLOCK_STEPS } from '../js/state.js';
import { MidiEngine } from '../js/midi.js';

// The p-lock pool: lane reads, the write path's minimal diff, and the free/
// reallocate semantics. Fixture-backed where the bytes matter, synthetic where
// the *behaviour* matters. The 2026-08-01 project dumps hold no allocated lanes
// (the pool was empty throughout the earlier experiments); the Phase 0 fixtures
// of 2026-08-04 hold the lanes the paramId tables were measured from, and the
// tests at the bottom read those tables' numbers back off the real bytes.
const DT2_FIXTURE = fileURLToPath(new URL('../dumps/digitakt2-project-2026-08-01T23-37-04.syx', import.meta.url));
const DN2_FIXTURE = fileURLToPath(new URL('../dumps/digitone2-project-2026-08-01.syx', import.meta.url));
const DT2_PHASE0 = fileURLToPath(new URL('../dumps/fixtures/digitakt2-A01-plock-final-2026-08-04.syx', import.meta.url));
const DN2_PHASE0 = fileURLToPath(new URL('../dumps/fixtures/digitone2-A01-plock-final-2026-08-04.syx', import.meta.url));
const have = existsSync(DT2_FIXTURE) && existsSync(DN2_FIXTURE);
const havePhase0 = existsSync(DT2_PHASE0) && existsSync(DN2_PHASE0);

const kits = file => splitSysExStream(new Uint8Array(readFileSync(file)))
  .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);
const payloadOf = (file, index = 0) => kits(file).find(m => m.index === index).payload;

const BOXES = have ? [
  { name: 'DT2', mod: dt2, payload: payloadOf(DT2_FIXTURE), trackIndex: 10, trackSize: 1184 },
  { name: 'DN2', mod: dn2, payload: payloadOf(DN2_FIXTURE), trackIndex: 2, trackSize: 1187 },
] : [];

// A 128-long values array with locks on the given steps.
const sparse = byStep => Array.from({ length: 128 }, (_, s) => byStep[s] ?? null);
const laneOf = (paramId, byStep) => ({ paramId, values: sparse(byStep) });

describe.skipIf(!have)('the fixtures agree on what an empty pool looks like', () => {
  for (const box of BOXES) {
    describe(box.name, () => {
      it('has no allocated lane at all', () => {
        expect(readAllPLocks(box.mod.SPEC, box.payload)).toEqual([]);
        expect(freeLaneCount(box.mod.SPEC, box.payload)).toBe(80);
        expect(readLane(box.mod.SPEC, box.payload, 0)).toBe(null);
      });

      it('leaves a free lane as FF FF plus 256 zero bytes, not FFFF values', () => {
        // Both format docs claimed `FFFF` for an unused value word. The bytes
        // say the header is all-ones and the value area is zeroed, which is
        // what the write path imitates when it frees a lane.
        const { pLocksIndex, pLockSize, numPLocks } = box.mod.SPEC.pattern;
        let ff = 0, zero = 0;
        for (let i = pLocksIndex; i < pLocksIndex + numPLocks * pLockSize; i++) {
          if (box.payload[i] === 0xff) ff++;
          else if (box.payload[i] === 0x00) zero++;
        }
        expect(ff).toBe(numPLocks * 2);
        expect(zero).toBe(numPLocks * 256);
      });

      it('fills the region exactly up to the pattern name', () => {
        const { pLocksIndex, pLockSize, numPLocks, nameOffset } = box.mod.SPEC.pattern;
        expect(pLocksIndex + numPLocks * pLockSize).toBe(nameOffset);
      });

      it('reads every pattern in the fixture the same way', () => {
        for (const msg of kits(box.name === 'DT2' ? DT2_FIXTURE : DN2_FIXTURE)) {
          expect(readAllPLocks(box.mod.SPEC, msg.payload), `pattern ${msg.index}`).toEqual([]);
        }
      });
    });
  }
});

describe.skipIf(!have)('writing lanes keeps the diff minimal', () => {
  for (const box of BOXES) {
    describe(box.name, () => {
      const t = box.trackIndex;
      const { pLocksIndex, numPLocks, pLockSize } = have ? box.mod.SPEC.pattern : {};

      const write = (lanes, trackIndex = t, from = box.payload) => {
        const out = Uint8Array.from(from);
        const { warnings } = applyTrackPLocks(box.mod.SPEC, out, trackIndex, lanes);
        return { payload: out, warnings };
      };

      it('touches nothing outside the p-lock pool', () => {
        const { payload } = write([laneOf(0x2a, { 0: 100, 4: 8000 })]);
        for (const d of box.mod.diffPayloads(box.payload, payload, 100000)) {
          expect(d.offset >= pLocksIndex && d.offset < pLocksIndex + numPLocks * pLockSize,
            `unexpected byte change at ${d.offset} (${box.mod.describeOffset(d.offset)})`).toBe(true);
        }
      });

      it('claims the lowest free lane and writes only that lane', () => {
        const { payload } = write([laneOf(0x2a, { 3: 4096 })]);
        const changed = box.mod.diffPayloads(box.payload, payload, 100000);
        expect(changed.every(d => d.offset < pLocksIndex + pLockSize)).toBe(true);
        expect(readAllPLocks(box.mod.SPEC, payload)).toEqual([
          { lane: 0, paramId: 0x2a, track: t, values: expect.any(Array) },
        ]);
      });

      it('round-trips values, and only on the steps that had them', () => {
        const { payload } = write([laneOf(0x2a, { 0: 0, 3: 4096, 127: VALUE_MAX })]);
        const [lane] = readTrackPLocks(box.mod.SPEC, payload, t);
        expect(lane.values[0]).toBe(0);       // 0 is a real value, not "unlocked"
        expect(lane.values[3]).toBe(4096);
        expect(lane.values[127]).toBe(VALUE_MAX);
        expect(lane.values.filter(v => v != null)).toHaveLength(3);
      });

      it('marks unlocked steps with FFFF inside an allocated lane', () => {
        const { payload } = write([laneOf(0x2a, { 3: 4096 })]);
        const at = step => (payload[pLocksIndex + 2 + step * 2] << 8) | payload[pLocksIndex + 3 + step * 2];
        expect(at(3)).toBe(4096);
        expect(at(0)).toBe(NO_VALUE);
        expect(at(127)).toBe(NO_VALUE);
      });

      it('gives one lane per parameter, in the order asked for', () => {
        const { payload } = write([laneOf(0x2a, { 1: 10 }), laneOf(0x31, { 2: 20 })]);
        expect(readTrackPLocks(box.mod.SPEC, payload, t).map(l => [l.lane, l.paramId]))
          .toEqual([[0, 0x2a], [1, 0x31]]);
      });

      it('rewrites a lane in place rather than moving it', () => {
        const first = write([laneOf(0x2a, { 1: 10 }), laneOf(0x31, { 2: 20 })]).payload;
        const second = write([laneOf(0x31, { 2: 99 }), laneOf(0x2a, { 1: 10 })], t, first).payload;
        // 0x31 was in lane 1 and stays in lane 1, even though it is now first in
        // the list: lane order on the box is not something we may assume about.
        expect(readTrackPLocks(box.mod.SPEC, second, t).map(l => [l.lane, l.paramId]))
          .toEqual([[0, 0x2a], [1, 0x31]]);
        expect(readTrackPLocks(box.mod.SPEC, second, t)[1].values[2]).toBe(99);
      });

      it('frees a lane back to the exact form the fixtures hold', () => {
        const written = write([laneOf(0x2a, { 1: 10, 5: 20 })]).payload;
        const freed = write([], t, written).payload;
        expect(box.mod.diffPayloads(box.payload, freed, 100000)).toEqual([]);
      });

      it('drops a lane with no values instead of claiming a slot for it', () => {
        const { payload } = write([laneOf(0x2a, {})]);
        expect(readAllPLocks(box.mod.SPEC, payload)).toEqual([]);
        expect(box.mod.diffPayloads(box.payload, payload, 100000)).toEqual([]);
      });

      it('hands a freed lane straight to a new parameter', () => {
        const written = write([laneOf(0x2a, { 1: 10 })]).payload;
        const swapped = write([laneOf(0x31, { 1: 10 })], t, written).payload;
        expect(readTrackPLocks(box.mod.SPEC, swapped, t).map(l => [l.lane, l.paramId]))
          .toEqual([[0, 0x31]]);
      });

      it('is byte-identical on a second pass', () => {
        const lanes = [laneOf(0x2a, { 1: 10 }), laneOf(0x31, { 2: 20 })];
        const first = write(lanes).payload;
        const second = write(lanes, t, first).payload;
        expect(box.mod.diffPayloads(first, second, 100000)).toEqual([]);
      });

      it('leaves other tracks\' lanes exactly where they were', () => {
        const other = 5;
        const withOther = write([laneOf(0x2a, { 0: 1 })], other).payload;
        const withBoth = write([laneOf(0x2a, { 9: 2 })], t, withOther).payload;
        expect(readTrackPLocks(box.mod.SPEC, withBoth, other))
          .toEqual(readTrackPLocks(box.mod.SPEC, withOther, other));
        // …and clearing our track doesn't touch theirs.
        const cleared = write([], t, withBoth).payload;
        expect(box.mod.diffPayloads(withOther, cleared, 100000)).toEqual([]);
      });

      it('warns rather than throwing when the 80 lanes are full', () => {
        // 80 lanes on one track, then ask for one more.
        let payload = box.payload;
        for (let i = 0; i < 80; i++) {
          payload = write([...Array.from({ length: i + 1 }, (_, k) => laneOf(k, { 0: k }))], t, box.payload).payload;
        }
        expect(freeLaneCount(box.mod.SPEC, payload)).toBe(0);
        const { warnings, payload: after } = write(
          [...Array.from({ length: 80 }, (_, k) => laneOf(k, { 0: k })), laneOf(200, { 0: 1 })], t, box.payload);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/all in use/);
        expect(readTrackPLocks(box.mod.SPEC, after, t)).toHaveLength(80);
      });

      it('warns when one parameter is asked for twice', () => {
        const { warnings, payload } = write([laneOf(0x2a, { 1: 10 }), laneOf(0x2a, { 2: 20 })]);
        expect(warnings[0]).toMatch(/appears twice/);
        expect(readTrackPLocks(box.mod.SPEC, payload, t)).toHaveLength(1);
      });

      it('clamps a value into the word range and never writes the FFFF sentinel', () => {
        const { payload } = write([laneOf(0x2a, { 0: 0xffff, 1: 0x123456, 2: -5 })]);
        const [lane] = readTrackPLocks(box.mod.SPEC, payload, t);
        expect(lane.values[0]).toBe(VALUE_MAX);
        expect(lane.values[1]).toBe(VALUE_MAX);
        expect(lane.values[2]).toBe(0);
      });

      it('refuses a track index the pattern doesn\'t have', () => {
        expect(() => applyTrackPLocks(box.mod.SPEC, Uint8Array.from(box.payload), 16, [])).toThrow(/no track/);
        expect(() => readTrackPLocks(box.mod.SPEC, box.payload, -1)).toThrow(/no track/);
      });
    });
  }
});

describe('the curated parameter tables', () => {
  it('carry all eleven parameters on both boxes, from the MIDI charts', () => {
    for (const kind of DEVICE_KINDS) {
      expect(paramTableFor(kind), kind).toHaveLength(11);
      expect(auditableParamsFor(kind), kind).toHaveLength(11);
    }
  });

  it('can hear and write every parameter — Phase 0 is measured', () => {
    // The whole state of this feature in one assertion. `auditable` comes from
    // the published CC/NRPN charts; `writable` comes from the Phase 0 hardware
    // experiments of 2026-08-04 (DT2 build 0070, DN2 build 0049), which measured
    // the p-lock paramId and scaling for all eleven knobs on both boxes.
    for (const kind of DEVICE_KINDS) {
      expect(writableParamsFor(kind), kind).toHaveLength(11);
    }
    expect(anyWritableParams()).toBe(true);
  });

  it('carries the measured paramIds, straight off the capture fixtures', () => {
    // The numbers are hardware facts, not derivable from any chart — the NRPN
    // hypothesis failed (cutoff's NRPN LSB is 20, its paramId is 44). Same knob,
    // different number per box; 74 is overdrive on a DT2 and filter frequency on
    // a DN2, which is why lanes translate by name and never by paramId.
    const id = (kind, name) => paramByName(paramTableFor(kind), name).plock.id;
    const MEASURED = {
      'filter.cutoff': [44, 74], 'filter.resonance': [45, 75], 'filter.envDepth': [46, 76],
      'fx.chorusSend': [62, 92], 'fx.delaySend': [63, 93], 'fx.reverbSend': [64, 94],
      'amp.pan': [65, 95], 'fx.overdrive': [74, 104],
      'lfo1.depth': [29, 29], 'lfo2.depth': [30, 30], 'lfo3.depth': [31, 31],
    };
    for (const [name, [dt2, dn2]] of Object.entries(MEASURED)) {
      expect(id('DT2', name), name).toBe(dt2);
      expect(id('DN2', name), name).toBe(dn2);
    }
  });

  it('scales every measured parameter by the one law the captures found', () => {
    // stored = displayValue × 256 on the MIDI 0–127 axis, both boxes, every
    // parameter: cutoff 127 → 0x7F00, pan hard left → 0, LFO depth +16 (MIDI 72)
    // → 0x4800 — all read back off the box byte-for-byte.
    for (const kind of DEVICE_KINDS) {
      for (const p of writableParamsFor(kind)) {
        expect(storedFromDisplay(p, 0), `${kind} ${p.name}`).toBe(0);
        expect(storedFromDisplay(p, 127), `${kind} ${p.name}`).toBe(0x7f00);
        expect(displayFromStored(p, 0x4800), `${kind} ${p.name}`).toBe(72);
      }
    }
  });

  it('names the same knobs on both boxes, so a copy can translate', () => {
    const names = kind => paramTableFor(kind).map(p => p.name).sort();
    expect(names('DT2')).toEqual(names('DN2'));
  });

  it('gives the two boxes different CCs for the same knob', () => {
    // Not a curiosity — pan is CC 90 on a DT2 and CC 89 on a DN2, and 89 is
    // Volume on the DT2. One shared table would ride the wrong fader.
    const cc = (kind, name) => paramByName(paramTableFor(kind), name).midi.cc;
    expect(cc('DT2', 'amp.pan')).toBe(90);
    expect(cc('DN2', 'amp.pan')).toBe(89);
    expect(cc('DT2', 'filter.cutoff')).toBe(74);
    expect(cc('DN2', 'filter.cutoff')).toBe(16);
  });

  it('gives the two boxes mostly the SAME NRPN numbers', () => {
    // This is the observation behind the leading Phase 0 hypothesis: NRPN LSB
    // looks like an internal parameter index, so it may well *be* the p-lock
    // paramId. Cheap to test, and it would hand us both tables at once.
    const nrpn = (kind, name) => paramByName(paramTableFor(kind), name).midi.nrpn;
    for (const name of ['filter.cutoff', 'filter.resonance', 'amp.pan',
      'fx.delaySend', 'fx.reverbSend', 'fx.chorusSend',
      'lfo1.depth', 'lfo2.depth', 'lfo3.depth']) {
      expect(nrpn('DT2', name), name).toEqual(nrpn('DN2', name));
    }
  });

  it('knows the DN2 has no CC at all for LFO3 depth', () => {
    // The DN2 appendix leaves the CC column blank for every LFO3 parameter, so
    // NRPN is the only way to reach it — one of the reasons NRPN is the default.
    const dn2Lfo3 = paramByName(paramTableFor('DN2'), 'lfo3.depth');
    expect(dn2Lfo3.midi.cc).toBe(null);
    expect(dn2Lfo3.midi.nrpn).toEqual([1, 72]);
    expect(dn2Lfo3.auditable).toBe(true);
    expect(paramByName(paramTableFor('DT2'), 'lfo3.depth').midi.cc).toBe(86);
  });

  it('leaves retrig out, since it has neither CC nor NRPN', () => {
    for (const kind of DEVICE_KINDS) {
      expect(paramByName(paramTableFor(kind), 'trig.retrig'), kind).toBe(null);
    }
  });

  it('answers lookups on an unknown device kind without throwing', () => {
    expect(paramTableFor('nonsense')).toEqual([]);
    expect(paramByName(paramTableFor('nonsense'), 'filter.cutoff')).toBe(null);
    expect(paramByPlockId(paramTableFor('DT2'), 0x2a)).toBe(null);
  });

  it('describes an unmapped paramId as raw, and says which box it belongs to', () => {
    const p = describeParam(paramTableFor('DT2'), { paramId: 0x2a, deviceKind: 'DT2' });
    expect(p.curated).toBe(false);
    expect(p.name).toBe(null);
    expect(p.label).toBe('DT2 param 0x2a');
    expect(p.auditable).toBe(false);
    // A raw lane's word passes through untouched, which is what keeps it
    // byte-exact on the way back to the box.
    expect(displayFromStored(p, 12345)).toBe(12345);
    expect(storedFromDisplay(p, 12345)).toBe(12345);
  });

  it('resolves a curated parameter by name', () => {
    const p = describeParam(paramTableFor('DT2'), { name: 'filter.cutoff', deviceKind: 'DT2' });
    expect(p.curated).toBe(true);
    expect(p.label).toBe('FLTR CUTOFF');
    expect(p.writable).toBe(true);
    // The measured scaling: display × 256 (the round-2 capture read 64 back as
    // 0x4002 — the low bits are the box's own sub-MIDI fine resolution).
    expect(storedFromDisplay(p, 64)).toBe(0x4000);
  });
});

describe('parameter descriptors', () => {
  // A parameter as it will look *after* Phase 0 measures its p-lock slot. Every
  // real entry in the shipped tables has `plock: null`; this is what filling one
  // in looks like, and it is what proves the transfer path works the moment a
  // measurement arrives.
  const measured = param({
    name: 'filter.cutoff', label: 'FLTR CUTOFF', cc: 74, nrpn: [1, 20], plock: plainPlock(0x14),
  });
  const scaled = param({
    name: 'lfo1.depth', label: 'LFO1 DEPTH', cc: 109, nrpn: [1, 49], bipolar: true,
    plock: scaledPlock(0x31, 4),
  });

  it('refuses a paramId that would collide with the free-lane marker', () => {
    expect(() => param({ name: 'x', label: 'X', plock: plainPlock(0xff) })).toThrow(/0–254/);
  });

  it('refuses a parameter that could neither be heard nor written', () => {
    expect(() => param({ name: 'x', label: 'X' })).toThrow(/would do nothing/);
  });

  it('separates being auditionable from being writable', () => {
    const previewOnly = param({ name: 'y', label: 'Y', cc: 7 });
    expect(previewOnly.auditable).toBe(true);
    expect(previewOnly.writable).toBe(false);
    expect(measured.auditable).toBe(true);
    expect(measured.writable).toBe(true);
  });

  it('returns null rather than a guess when no scaling is measured', () => {
    const previewOnly = param({ name: 'y', label: 'Y', cc: 7 });
    expect(storedFromDisplay(previewOnly, 64)).toBe(null);
    expect(displayFromStored(previewOnly, 64)).toBe(null);
  });

  it('round-trips every display value through the stored word', () => {
    for (const p of [measured, scaled]) {
      for (let v = p.min; v <= p.max; v += p.step) {
        expect(displayFromStored(p, storedFromDisplay(p, v)), `${p.name} ${v}`).toBe(v);
      }
    }
  });

  it('clamps out-of-range display values onto the MIDI axis', () => {
    expect(clampParamValue(measured, 999)).toBe(127);
    expect(clampParamValue(measured, -5)).toBe(0);
  });

  it('looks parameters up by paramId and by canonical name', () => {
    const table = [measured, scaled];
    expect(paramByPlockId(table, 0x14)).toBe(measured);
    expect(paramByName(table, 'lfo1.depth')).toBe(scaled);
    expect(paramByPlockId(table, 0x99)).toBe(null);
  });
});

describe('the audition path', () => {
  const lane = (name, byStep, kind = 'DT2') =>
    makePLockLane({ name, deviceKind: kind, values: sparse(byStep) });

  it('sends NRPN for a parameter that has one, with the value in the top 7 bits', () => {
    const [m] = plockMessagesForStep([lane('filter.cutoff', { 3: 100 })], 3);
    expect(m.nrpn).toEqual([1, 20]);
    expect(m.value7).toBe(100);
    // 100 << 7 puts the box's parameter exactly where CC 100 would.
    expect(m.value14).toBe(12800);
    expect(m.value14 >> 7).toBe(100);
  });

  it('reaches the DN2 LFO3 depth, which has no CC at all', () => {
    const [m] = plockMessagesForStep([lane('lfo3.depth', { 0: 64 }, 'DN2')], 0);
    expect(m.nrpn).toEqual([1, 72]);
    expect(m.cc).toBe(null);
  });

  it('uses the right box\'s numbering for the same knob', () => {
    const dt2 = plockMessagesForStep([lane('amp.pan', { 0: 10 }, 'DT2')], 0);
    const dn2 = plockMessagesForStep([lane('amp.pan', { 0: 10 }, 'DN2')], 0);
    expect(dt2[0].cc).toBe(90);
    expect(dn2[0].cc).toBe(89);
  });

  it('sends nothing for steps with no value, or for a lane off an unmapped box param', () => {
    expect(plockMessagesForStep([lane('filter.cutoff', { 3: 100 })], 4)).toEqual([]);
    const raw = makePLockLane({ paramId: 0x2a, deviceKind: 'DT2', values: sparse({ 0: 500 }) });
    expect(plockMessagesForStep([raw], 0)).toEqual([]);
    expect(hasAuditableLanes([raw])).toBe(false);
    expect(hasAuditableLanes([lane('filter.cutoff', { 3: 100 })])).toBe(true);
    expect(hasAuditableLanes([lane('filter.cutoff', {})])).toBe(false);
  });

  it('clamps a value onto the 14-bit range', () => {
    const [m] = plockMessagesForStep([lane('filter.cutoff', { 0: 9999 })], 0);
    expect(m.value14).toBeLessThanOrEqual(0x3fff);
    expect(m.value7).toBe(127);
  });

  // The bytes that actually go on the wire, through the real engine — the CC/NRPN
  // numbers are only useful if the messages come out in the right shape and in
  // the right order relative to the notes.
  describe('on the wire', () => {
    const CH = 4;
    const playing = plocks => {
      const sent = [];
      const engine = new MidiEngine(() => ({
        pattern: {
          channel: CH, lengthSteps: 16, swing: 50, trackProb: 100, plocks,
          notes: [{ step: 0, pitch: 60, velocity: 100, len: 1, micro: 0 }],
        },
        bpm: 120, sendClock: false, countIn: 0,
      }), { rng: () => 0, plockMessages: plockMessagesForStep });
      engine.output = { send: (data, time) => sent.push({ data: [...data], time }) };
      engine.start();
      engine.stop();
      return sent;
    };

    it('sends the NRPN select-then-value sequence on the pattern\'s channel', () => {
      const sent = playing([lane('filter.cutoff', { 0: 100 })]);
      const nrpn = sent.filter(m => (m.data[0] & 0xf0) === 0xb0 && [99, 98, 6, 38].includes(m.data[1]));
      expect(nrpn.slice(0, 4).map(m => m.data)).toEqual([
        [0xb0 | CH, 99, 1],    // NRPN MSB — parameter select, high
        [0xb0 | CH, 98, 20],   // NRPN LSB — filter cutoff
        [0xb0 | CH, 6, 100],   // data entry MSB — the value
        [0xb0 | CH, 38, 0],    // data entry LSB — unused on a 0–127 axis
      ]);
    });

    it('sends the parameter before the note it belongs to', () => {
      const sent = playing([lane('filter.cutoff', { 0: 100 })]);
      const lastParam = sent.filter(m => m.data[1] === 38).at(0);
      const firstNoteOn = sent.filter(m => (m.data[0] & 0xf0) === 0x90).at(0);
      expect(lastParam.time).toBeLessThan(firstNoteOn.time);
    });

    it('falls back to a plain CC for a parameter with no NRPN', () => {
      // The DT2's overdrive: its appendix gives a CC and no NRPN.
      const sent = playing([lane('fx.overdrive', { 0: 77 })]);
      expect(sent.some(m => m.data[0] === (0xb0 | CH) && m.data[1] === 57 && m.data[2] === 77)).toBe(true);
      expect(sent.some(m => m.data[1] === 99)).toBe(false);
    });

    it('sends nothing when a trig is silenced by probability', () => {
      // A trig that doesn't fire doesn't apply its locks on the box either.
      const sent = [];
      const engine = new MidiEngine(() => ({
        pattern: {
          channel: CH, lengthSteps: 16, swing: 50, trackProb: 0, plocks: [lane('filter.cutoff', { 0: 100 })],
          notes: [{ step: 0, pitch: 60, velocity: 100, len: 1, micro: 0 }],
        },
        bpm: 120, sendClock: false, countIn: 0,
      }), { rng: () => 0.99, plockMessages: plockMessagesForStep });
      engine.output = { send: (data, time) => sent.push({ data: [...data], time }) };
      engine.start();
      engine.stop();
      expect(sent.some(m => m.data[1] === 99)).toBe(false);
    });

    it('sends no parameters at all when the engine has no resolver', () => {
      const sent = [];
      const engine = new MidiEngine(() => ({
        pattern: {
          channel: CH, lengthSteps: 16, swing: 50, trackProb: 100, plocks: [lane('filter.cutoff', { 0: 100 })],
          notes: [{ step: 0, pitch: 60, velocity: 100, len: 1, micro: 0 }],
        },
        bpm: 120, sendClock: false, countIn: 0,
      }), { rng: () => 0 });
      engine.output = { send: (data, time) => sent.push({ data: [...data], time }) };
      engine.start();
      engine.stop();
      expect(sent.every(m => (m.data[0] & 0xf0) !== 0xb0 || m.data[1] === 123)).toBe(true);
    });
  });
});

describe('cross-device lane translation', () => {
  const lanes = [laneOf(0x2a, { 0: 64 }), laneOf(0x31, { 1: 20 })];

  it('carries lanes untouched between two slots on one box', () => {
    const { lanes: out, warnings } = plockLanesForTarget(lanes, 'DT2', 'DT2');
    expect(warnings).toEqual([]);
    expect(out.map(l => l.paramId)).toEqual([0x2a, 0x31]);
    expect(out[0].values[0]).toBe(64);
  });

  it('drops a lane whose paramId is not one of the measured eleven, with a warning', () => {
    // 0x2a and 0x31 mean nothing in the DT2 table even after Phase 0, so there
    // is still nothing to translate *by*. Said out loud, per lane, rather than
    // aimed at a guess.
    const { lanes: out, warnings } = plockLanesForTarget(lanes, 'DT2', 'DN2');
    expect(out).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/doesn't know which parameter that is yet/);
  });

  it('translates a measured lane across boxes by canonical name', () => {
    // The reason translation is by name and never by number: 44 is filter
    // frequency on a DT2, and 74 — its DN2 paramId — is *overdrive* back on the
    // DT2. Values carry on the display axis; the fine low bits a box-authored
    // lock may hold quantise to the nearest MIDI step on the way.
    const cutoffLane = [laneOf(44, { 0: 0x4002, 8: 0x7f00 })];
    const { lanes: out, warnings } = plockLanesForTarget(cutoffLane, 'DT2', 'DN2');
    expect(warnings).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0].paramId).toBe(74);
    expect(out[0].values[0]).toBe(0x4000);
    expect(out[0].values[8]).toBe(0x7f00);
  });

  it('does nothing at all with no lanes', () => {
    expect(plockLanesForTarget([], 'DT2', 'DN2')).toEqual({ lanes: [], warnings: [] });
  });
});

describe.skipIf(!have)('copyTrack carries lanes', () => {
  // Seed a lane on the source track, because no fixture has one.
  const seeded = (mod, payload, track, paramId = 0x2a) => {
    const out = Uint8Array.from(payload);
    applyTrackPLocks(mod.SPEC, out, track, [laneOf(paramId, { 0: 4096, 8: 40 })]);
    return out;
  };

  it('carries a lane between two slots on one box, values intact', () => {
    const sourcePayload = seeded(dt2, payloadOf(DT2_FIXTURE), 10);
    const { payload, warnings } = copyTrack({
      sourceMod: dt2, sourcePatternKit: dt2.decodePatternKit(sourcePayload), sourcePayload, sourceTrack: 10,
      targetMod: dt2, targetPayload: payloadOf(DT2_FIXTURE, 1), targetTrack: 3,
    });
    expect(warnings).toEqual([]);
    const [lane] = readTrackPLocks(dt2.SPEC, payload, 3);
    expect(lane.paramId).toBe(0x2a);
    expect(lane.values[0]).toBe(4096);
    expect(lane.values[8]).toBe(40);
  });

  it('drops a lane going to the other box, and says which', () => {
    const sourcePayload = seeded(dt2, payloadOf(DT2_FIXTURE), 10);
    const { payload, warnings } = copyTrack({
      sourceMod: dt2, sourcePatternKit: dt2.decodePatternKit(sourcePayload), sourcePayload, sourceTrack: 10,
      targetMod: dn2, targetPayload: payloadOf(DN2_FIXTURE), targetTrack: 5,
    });
    expect(readTrackPLocks(dn2.SPEC, payload, 5)).toEqual([]);
    expect(warnings.some(w => /0x2a/.test(w))).toBe(true);
  });

  it('clears the target track\'s own lanes, since its notes are being replaced', () => {
    const sourcePayload = payloadOf(DT2_FIXTURE);           // no lanes
    const targetPayload = seeded(dt2, payloadOf(DT2_FIXTURE, 1), 3, 0x55);
    const { payload } = copyTrack({
      sourceMod: dt2, sourcePatternKit: dt2.decodePatternKit(sourcePayload), sourcePayload, sourceTrack: 10,
      targetMod: dt2, targetPayload, targetTrack: 3,
    });
    expect(readTrackPLocks(dt2.SPEC, payload, 3)).toEqual([]);
  });

  it('leaves the target\'s other tracks\' lanes alone', () => {
    const sourcePayload = seeded(dt2, payloadOf(DT2_FIXTURE), 10);
    const targetPayload = seeded(dt2, payloadOf(DT2_FIXTURE, 1), 7, 0x55);
    const { payload } = copyTrack({
      sourceMod: dt2, sourcePatternKit: dt2.decodePatternKit(sourcePayload), sourcePayload, sourceTrack: 10,
      targetMod: dt2, targetPayload, targetTrack: 3,
    });
    expect(readTrackPLocks(dt2.SPEC, payload, 7))
      .toEqual(readTrackPLocks(dt2.SPEC, targetPayload, 7));
  });
});

describe('the roll seam', () => {
  it('flags a lane the box filled on a step with no trig', () => {
    const lane = { lane: 0, paramId: 0x2a, track: 0, values: sparse({ 5: 64 }) };
    expect(laneHasTriglessValues(lane, new Set([5]))).toBe(false);
    expect(laneHasTriglessValues(lane, new Set([4]))).toBe(true);

    const [imported] = devicePLocksToRoll([lane], 'DT2', new Set([4]));
    expect(imported.trigless).toBe(true);
    expect(imported.deviceKind).toBe('DT2');
    expect(imported.values).toHaveLength(PLOCK_STEPS);
  });

  it('imports an unidentifiable lane raw, with its words untouched', () => {
    // No paramId is measured yet, so this is every imported lane today. The word
    // has to survive unchanged or write-back wouldn't be byte-exact.
    const [imported] = devicePLocksToRoll(
      [{ lane: 0, paramId: 0x2a, track: 0, values: sparse({ 2: 40000 }) }], 'DT2', new Set([2]));
    expect(imported.name).toBe(null);
    expect(imported.paramId).toBe(0x2a);
    expect(imported.values[2]).toBe(40000);
    // …and back out again unchanged.
    const { lanes } = rollPLocksToDevice([imported], 'DT2');
    expect(lanes).toEqual([{ paramId: 0x2a, values: expect.any(Array) }]);
    expect(lanes[0].values[2]).toBe(40000);
  });

  it('refuses to send a lane belonging to the other box\'s numbering', () => {
    const { lanes, warnings } = rollPLocksToDevice(
      [makePLockLane({ paramId: 0x2a, deviceKind: 'DN2', values: sparse({ 3: 64 }) })], 'DT2');
    expect(lanes).toEqual([]);
    expect(warnings[0]).toMatch(/belongs to a DN2/);
  });

  it('sends a named lane through its measured slot and scaling', () => {
    // Until Phase 0 this refused with "can play but can't write"; the measured
    // table is what turned it into bytes. paramId 44 and value × 256 are the
    // numbers read back off the DT2 in the round-1 capture.
    const { lanes, warnings } = rollPLocksToDevice(
      [makePLockLane({ name: 'filter.cutoff', deviceKind: 'DT2', values: sparse({ 3: 100 }) })], 'DT2');
    expect(warnings).toEqual([]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].paramId).toBe(44);
    expect(lanes[0].values[3]).toBe(100 * 256);
  });

  it('still refuses a lane whose parameter has no measured slot', () => {
    // The refusal path stays live for whatever joins the tables next (retrig is
    // the known candidate) — the warning must keep saying both halves.
    const table = paramTableFor('DT2');
    const cutoff = paramByName(table, 'filter.cutoff');
    const savedPlock = cutoff.plock;
    cutoff.plock = null; cutoff.writable = false;
    try {
      const { lanes, warnings } = rollPLocksToDevice(
        [makePLockLane({ name: 'filter.cutoff', deviceKind: 'DT2', values: sparse({ 3: 100 }) })], 'DT2');
      expect(lanes).toEqual([]);
      expect(warnings[0]).toMatch(/play that parameter over MIDI/);
      expect(warnings[0]).toMatch(/can't write it into the pattern/);
    } finally {
      cutoff.plock = savedPlock; cutoff.writable = true;
    }
  });

  it('prunes editable lanes to the steps that still have trigs', () => {
    const editable = makePLockLane({ name: 'filter.cutoff', deviceKind: 'DT2', values: sparse({ 1: 10, 9: 20 }) });
    const readOnly = makePLockLane({ paramId: 0x31, deviceKind: 'DT2', values: sparse({ 1: 10, 9: 20 }) });
    const notes = [{ step: 1 }];
    pruneLanesToTrigs([editable, readOnly], notes, lane => lane === editable);
    expect(editable.values[1]).toBe(10);
    expect(editable.values[9]).toBe(null);
    // A read-only lane is being passed back to the box byte-exact; pruning it
    // would change bytes we promised not to touch.
    expect(readOnly.values[9]).toBe(20);
  });

  it('needs a name or a paramId to make a lane at all', () => {
    expect(() => makePLockLane({ deviceKind: 'DT2' })).toThrow(/name or a paramId/);
  });
});

describe.skipIf(!havePhase0)('the Phase 0 capture fixtures', () => {
  // The dumps the paramId tables were measured from, read back through the
  // shipped code: every lane in them must resolve to the curated parameter the
  // experiment locked, at the display value the knob was set to.
  const cases = [
    {
      kind: 'DT2', mod: dt2, file: DT2_PHASE0,
      // lane → [paramId, track, { step: display }] as locked on the box
      lanes: [
        [44, 0, { 0: 0, 4: 64, 8: 127 }],           // FLTR FREQ 0/64/127
        [44, 1, { 0: 100 }],                         // FREQ 100 on T2 — the reused hole
        [65, 0, { 4: 0 }],                           // PAN hard left
        [46, 0, { 8: 32 }],                          // ENV DEPTH −32 = MIDI 32
        [74, 0, { 12: 127 }],                        // OVERDRIVE 127
        [63, 0, { 0: 127 }], [64, 0, { 4: 64 }], [62, 0, { 8: 32 }],
        [29, 0, { 12: 72 }], [30, 0, { 0: 72 }], [31, 0, { 4: 72 }], // LFO ±128 → +16 = MIDI 72
      ],
    },
    {
      kind: 'DN2', mod: dn2, file: DN2_PHASE0,
      lanes: [
        [74, 0, { 0: 0, 4: 64, 8: 127, 12: 32 }],    // FREQ, incl. the chord step
        [95, 0, { 4: 0 }], [76, 0, { 8: 32 }], [104, 0, { 12: 127 }],
        [93, 0, { 0: 127 }], [94, 0, { 4: 64 }], [92, 0, { 8: 32 }],
        [29, 0, { 12: 72 }], [30, 0, { 0: 72 }], [31, 0, { 4: 72 }],
      ],
    },
  ];

  for (const { kind, mod, file, lanes: expected } of cases) {
    it(`${kind}: every captured lane resolves to the parameter the experiment locked`, () => {
      const payload = payloadOf(file);
      const lanes = readAllPLocks(mod.SPEC, payload).filter(l => l.paramId !== null);
      expect(lanes).toHaveLength(expected.length);
      const table = paramTableFor(kind);
      for (const [paramId, track, byStep] of expected) {
        const lane = lanes.find(l => l.paramId === paramId && l.track === track);
        expect(lane, `${kind} paramId ${paramId} track ${track}`).toBeTruthy();
        const p = paramByPlockId(table, paramId);
        expect(p, `${kind} paramId ${paramId} should be curated`).toBeTruthy();
        for (const [step, display] of Object.entries(byStep)) {
          // The box keeps sub-MIDI fine resolution in the low bits (a knob nudge
          // leaves +1/256 residues), so compare on the display axis it rounds to.
          expect(displayFromStored(p, lane.values[+step]),
            `${kind} ${p.name} step ${step}`).toBe(display);
        }
      }
    });

    it(`${kind}: the freed lane sits as a hole in the measured free-lane form`, () => {
      // Both boxes freed lane 1 in place when the last RESO lock was removed —
      // paramId FF, track FF, values all zero, neighbours untouched. (The DT2
      // then re-used its hole for the T2 experiment; the DN2's is still open.)
      const payload = payloadOf(file);
      const all = readAllPLocks(mod.SPEC, payload);
      const reso = paramByName(paramTableFor(kind), 'filter.resonance');
      expect(all.some(l => l.paramId === reso.plock.id)).toBe(false);
    });
  }
});
