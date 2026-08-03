import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP } from '../js/elektron/protocol.js';
import * as dt2 from '../js/elektron/dt2/pattern.js';
import * as dn2 from '../js/elektron/dn2/pattern.js';
import {
  readTrackTrigSettings, applyTrackTrigSettings, trigSettingsFromNotes, attachTrigSettings,
  readTrackProb, applyTrackProb,
} from '../js/elektron/trig-cond.js';
import { NONE } from '../js/elektron/conditions.js';
import { copyTrack, truncateChords, deviceNotesToEncoder } from '../js/elektron/copy-track.js';
import { deviceNotesToRoll, rollNotesToDevice, rollLengthForTrack } from '../js/roll-bridge.js';

// Stage 3: the write path. Same shape as the minimal-diff property test in
// roundtrip.test.js — the point is not that the new bytes land, but that
// nothing else moves when they do.
const DT2_FIXTURE = fileURLToPath(new URL('../dumps/digitakt2-project-2026-08-01T23-37-04.syx', import.meta.url));
const DN2_FIXTURE = fileURLToPath(new URL('../dumps/digitone2-project-2026-08-01.syx', import.meta.url));
const DT2_COND = fileURLToPath(new URL('../dumps/fixtures/digitakt2-A01-conditions-2026-08-02.syx', import.meta.url));
const have = existsSync(DT2_FIXTURE) && existsSync(DN2_FIXTURE);
const haveCond = existsSync(DT2_COND);

const kits = file => splitSysExStream(new Uint8Array(readFileSync(file)))
  .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);
const payloadOf = (file, index = 0) => kits(file).find(m => m.index === index).payload;

const BOXES = have ? [
  { name: 'DT2', mod: dt2, payload: payloadOf(DT2_FIXTURE), trackIndex: 10, trackSize: 1184, pool: [18948, 68100] },
  { name: 'DN2', mod: dn2, payload: payloadOf(DN2_FIXTURE), trackIndex: 2, trackSize: 1187, pool: [18996, 68148] },
] : [];

// The extended contract: step words, the shared pool, and this one track's
// three condition lanes. Everything else must be byte-identical.
function expectOnlyTrackBytesChanged(box, before, after, t) {
  const base = 4 + t * box.trackSize;
  const S = box.mod.SPEC.track;
  const regions = [
    [base, base + 256],                                   // step words
    box.pool,
    [base + S.trigCond, base + S.trigCond + 128],
    [base + S.trigFill, base + S.trigFill + 128],
    [base + S.trigProb, base + S.trigProb + 128],
    [base + S.trackProb, base + S.trackProb + 1],         // the track's PROB default
  ];
  for (const d of box.mod.diffPayloads(before, after, 100000)) {
    const ok = regions.some(([lo, hi]) => d.offset >= lo && d.offset < hi);
    expect(ok, `unexpected byte change at ${d.offset} (${box.mod.describeOffset(d.offset)})`).toBe(true);
  }
}

// Encode notes and apply their conditions — exactly what safeWriteTrack does.
const encodeWithConditions = (mod, payload, t, notes, trackProb = null) => {
  const { payload: out, dropped } = mod.encodeTrackNotes(payload, t, notes);
  applyTrackTrigSettings(mod.SPEC, out, t, trigSettingsFromNotes(notes));
  if (trackProb != null) applyTrackProb(mod.SPEC, out, t, trackProb);
  return { payload: out, dropped };
};

describe.skipIf(!have)('encode + apply keeps the diff minimal', () => {
  for (const box of BOXES) {
    describe(box.name, () => {
      const t = box.trackIndex;
      const notesWithConditions = () => {
        const decoded = box.mod.decodePatternKit(box.payload);
        const notes = deviceNotesToEncoder(box.mod.trackNotes(decoded, t));
        // Lock up a handful of steps, spread across the track.
        const steps = [...new Set(notes.map(n => n.step))].sort((a, b) => a - b);
        const locks = new Map([
          [steps[0], { prob: 25, fill: true, cond: '2:4' }],
          [steps[1], { prob: null, fill: false, cond: '!1ST' }],
          [steps[2], { prob: 0, fill: null, cond: null }],
        ]);
        return attachTrigSettings(notes, locks);
      };

      it('touches nothing outside the step words, the pool and this track\'s lanes', () => {
        const { payload } = encodeWithConditions(box.mod, box.payload, t, notesWithConditions());
        expectOnlyTrackBytesChanged(box, box.payload, payload, t);
      });

      it('leaves every other track\'s lanes untouched', () => {
        const { payload } = encodeWithConditions(box.mod, box.payload, t, notesWithConditions());
        for (let other = 0; other < 16; other++) {
          if (other === t) continue;
          expect(readTrackTrigSettings(box.mod.SPEC, payload, other).size, `track ${other + 1}`)
            .toBe(readTrackTrigSettings(box.mod.SPEC, box.payload, other).size);
        }
      });

      it('round-trips notes with all three fields back out again', () => {
        const notes = notesWithConditions();
        const { payload } = encodeWithConditions(box.mod, box.payload, t, notes);
        const decoded = box.mod.decodePatternKit(payload);
        const back = attachTrigSettings(
          deviceNotesToEncoder(box.mod.trackNotes(decoded, t)),
          readTrackTrigSettings(box.mod.SPEC, payload, t),
        );
        const trio = ns => ns.map(n => ({ step: n.step, prob: n.prob, fill: n.fill, cond: n.cond }));
        expect(trio(back)).toEqual(trio(notes));
      });

      it('is byte-identical on a second pass — writing twice changes nothing', () => {
        const notes = notesWithConditions();
        const first = encodeWithConditions(box.mod, box.payload, t, notes).payload;
        const second = encodeWithConditions(box.mod, first, t, notes).payload;
        expect(box.mod.diffPayloads(first, second, 100000)).toEqual([]);
      });

      it('writes the track PROB default without disturbing anything else', () => {
        const notes = notesWithConditions();
        const { payload } = encodeWithConditions(box.mod, box.payload, t, notes, 30);
        expectOnlyTrackBytesChanged(box, box.payload, payload, t);
        expect(readTrackProb(box.mod.SPEC, payload, t)).toBe(30);
      });

      it('leaves every other track\'s PROB default alone', () => {
        const { payload } = encodeWithConditions(box.mod, box.payload, t, notesWithConditions(), 30);
        for (let other = 0; other < 16; other++) {
          if (other === t) continue;
          expect(readTrackProb(box.mod.SPEC, payload, other), `track ${other + 1}`)
            .toBe(readTrackProb(box.mod.SPEC, box.payload, other));
        }
      });

      it('keeps an explicit 100% trig lock distinct from the track default', () => {
        // The user's case, end to end: a 30% track with one trig pinned at 100.
        const notes = notesWithConditions();
        const step = notes[0].step;
        for (const n of notes) if (n.step === step) n.prob = 100;
        const { payload } = encodeWithConditions(box.mod, box.payload, t, notes, 30);
        expect(readTrackProb(box.mod.SPEC, payload, t)).toBe(30);
        expect(readTrackTrigSettings(box.mod.SPEC, payload, t).get(step).prob).toBe(100);
      });

      it('survives the piano roll: draw conditions, write, read back', () => {
        const decoded = box.mod.decodePatternKit(box.payload);
        const lengthSteps = rollLengthForTrack(decoded.tracks[t]);
        const rollNotes = deviceNotesToRoll(box.mod.trackNotes(decoded, t), lengthSteps);
        // Lock the first step the way the trig lane would: all notes on it.
        const step = rollNotes[0].step;
        for (const n of rollNotes) {
          if (n.step === step) { n.prob = 40; n.fill = false; n.cond = '!2:5'; }
        }
        const { payload } = encodeWithConditions(box.mod, box.payload, t, rollNotesToDevice(rollNotes));
        expect(readTrackTrigSettings(box.mod.SPEC, payload, t).get(step))
          .toEqual({ prob: 40, fill: false, cond: '!2:5' });
      });
    });
  }
});

describe.skipIf(!haveCond)('stale leftovers on a reused step', () => {
  const payload = haveCond ? payloadOf(DT2_COND) : null;
  const t = 0;
  const laneAt = (buf, lane, step) => buf[4 + dt2.SPEC.track[lane] + step];

  it('starts from a fixture that really does carry leftovers', () => {
    // Step 16's trig was deleted on the box: the trig bit is clear but FILL and
    // PROB bytes are still there. This is the hazard the scrub exists for.
    expect(dt2.decodePatternKit(payload).tracks[0].steps[15] & 1).toBe(0);
    expect(laneAt(payload, 'trigFill', 15)).toBe(0x00);
    expect(laneAt(payload, 'trigProb', 15)).toBe(0x4b);
  });

  it('lets a fresh locked note on that step win over the leftovers', () => {
    const notes = [{ step: 15, pitch: 60, velocity: 100, len: 1, micro: 0, prob: 10, fill: true, cond: 'PRE' }];
    const { payload: out } = encodeWithConditions(dt2, payload, t, notes);
    expect(readTrackTrigSettings(dt2.SPEC, out, t).get(15)).toEqual({ prob: 10, fill: true, cond: 'PRE' });
  });

  it('clears the leftovers for a fresh UNlocked note on that step', () => {
    // Without the scrub this note would silently inherit PROB 75 and FILL OFF.
    const notes = [{ step: 15, pitch: 60, velocity: 100, len: 1, micro: 0, prob: null, fill: null, cond: null }];
    const { payload: out } = encodeWithConditions(dt2, payload, t, notes);
    expect(readTrackTrigSettings(dt2.SPEC, out, t).size).toBe(0);
    for (const lane of ['trigCond', 'trigFill', 'trigProb']) {
      expect(laneAt(out, lane, 15), lane).toBe(NONE);
    }
  });
});

describe('a chord truncated for the target keeps the step\'s settings', () => {
  it('carries the conditions on whichever notes survive', () => {
    // Five notes on one step, going to a box with four slots. The settings are
    // per trig, so every note carries them and truncation cannot lose them.
    const chord = [72, 67, 64, 62, 60].map((pitch, i) => ({
      step: 3, pitch, velocity: 100 - i, len: 1, micro: 0,
      prob: 60, fill: true, cond: '3:4',
    }));
    const { notes, drops } = truncateChords(chord, 4);
    expect(notes).toHaveLength(4);
    expect(drops).toHaveLength(1);
    expect(notes.every(n => n.cond === '3:4' && n.prob === 60 && n.fill === true)).toBe(true);
    expect(trigSettingsFromNotes(notes).get(3)).toEqual({ prob: 60, fill: true, cond: '3:4' });
  });
});

describe.skipIf(!have || !haveCond)('cross-device copy carries conditions', () => {
  it('takes DT2 conditions onto a DN2 track', () => {
    const sourcePayload = payloadOf(DT2_COND);
    const sourcePatternKit = dt2.decodePatternKit(sourcePayload);
    const targetPayload = payloadOf(DN2_FIXTURE);
    const { payload, warnings } = copyTrack({
      sourceMod: dt2, sourcePatternKit, sourcePayload, sourceTrack: 0,
      targetMod: dn2, targetPayload, targetTrack: 5,
    });
    // Both boxes share one COND list, so nothing may be dropped for lack of a
    // target-side equivalent.
    expect(warnings).toEqual([]);
    const copied = readTrackTrigSettings(dn2.SPEC, payload, 5);
    const source = readTrackTrigSettings(dt2.SPEC, sourcePayload, 0);
    // Only live steps travel: step 16's trig was deleted, so its leftovers stay
    // behind rather than being resurrected on the target.
    const liveSource = new Map([...source].filter(([s]) => sourcePatternKit.tracks[0].steps[s] & 1));
    expect(Object.fromEntries(copied)).toEqual(Object.fromEntries(liveSource));
  });

  it('does not disturb the target\'s other tracks', () => {
    const sourcePayload = payloadOf(DT2_COND);
    const targetPayload = payloadOf(DN2_FIXTURE);
    const { payload } = copyTrack({
      sourceMod: dt2, sourcePatternKit: dt2.decodePatternKit(sourcePayload), sourcePayload, sourceTrack: 0,
      targetMod: dn2, targetPayload, targetTrack: 5,
    });
    for (let other = 0; other < 16; other++) {
      if (other === 5) continue;
      expect(readTrackTrigSettings(dn2.SPEC, payload, other).size, `track ${other + 1}`).toBe(0);
    }
  });

  it('carries the source track\'s PROB default onto the target', () => {
    const sourcePayload = Uint8Array.from(payloadOf(DT2_COND));
    applyTrackProb(dt2.SPEC, sourcePayload, 0, 30);
    const targetPayload = payloadOf(DN2_FIXTURE);
    const { payload } = copyTrack({
      sourceMod: dt2, sourcePatternKit: dt2.decodePatternKit(sourcePayload), sourcePayload, sourceTrack: 0,
      targetMod: dn2, targetPayload, targetTrack: 5,
    });
    expect(readTrackProb(dn2.SPEC, payload, 5)).toBe(30);
    for (let other = 0; other < 16; other++) {
      if (other === 5) continue;
      expect(readTrackProb(dn2.SPEC, payload, other), `track ${other + 1}`)
        .toBe(readTrackProb(dn2.SPEC, targetPayload, other));
    }
  });

  it('copies nothing when the source track has no conditions', () => {
    const sourcePayload = payloadOf(DT2_FIXTURE);
    const targetPayload = payloadOf(DN2_FIXTURE);
    const { payload } = copyTrack({
      sourceMod: dt2, sourcePatternKit: dt2.decodePatternKit(sourcePayload), sourcePayload, sourceTrack: 10,
      targetMod: dn2, targetPayload, targetTrack: 5,
    });
    expect(readTrackTrigSettings(dn2.SPEC, payload, 5).size).toBe(0);
  });
});
