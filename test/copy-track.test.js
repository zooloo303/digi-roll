import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSysExStream, DUMP } from '../js/elektron/protocol.js';
import * as dt2 from '../js/elektron/dt2/pattern.js';
import * as dn2 from '../js/elektron/dn2/pattern.js';
import { copyTrack, truncateChords, describeChordDrops } from '../js/elektron/copy-track.js';

// Phase 4 feature 3: the pattern librarian. Copy one track's notes between two
// patterns — DT2 → DN2, DN2 → DT2, or two slots on one box — with the note
// model as the interchange format and the target's sounds, p-locks and
// settings untouched.
const DT2_FIXTURE = fileURLToPath(new URL('../dumps/digitakt2-project-2026-08-01T23-37-04.syx', import.meta.url));
const DN2_FIXTURE = fileURLToPath(new URL('../dumps/digitone2-project-2026-08-01.syx', import.meta.url));
const have = existsSync(DT2_FIXTURE) && existsSync(DN2_FIXTURE);

const kits = file => splitSysExStream(new Uint8Array(readFileSync(file)))
  .filter(m => m.kind === 'dump' && m.type === DUMP.PATTERN_KIT);
const payloadOf = (file, index) => kits(file).find(m => m.index === index).payload;

const DT2 = { mod: dt2, trackSize: 1184, pool: [18948, 68100] };
const DN2 = { mod: dn2, trackSize: 1187, pool: [18996, 68148] };

// Nothing outside the target track's step words and the shared trig-record
// pool may move — the target keeps its own sounds, p-locks and settings.
function expectOnlyTrackBytesChanged(box, before, after, trackIndex) {
  const stepLo = 4 + trackIndex * box.trackSize;
  const [poolLo, poolHi] = box.pool;
  const diffs = box.mod.diffPayloads(before, after, 100000);
  expect(diffs.length).toBeGreaterThan(0);
  for (const d of diffs) {
    const ok = (d.offset >= stepLo && d.offset < stepLo + 256) || (d.offset >= poolLo && d.offset < poolHi);
    expect(ok, `unexpected byte change at ${d.offset} (${box.mod.describeOffset(d.offset)})`).toBe(true);
  }
}

// The note fields that must survive a hop between boxes.
const musical = n => ({ step: n.step, pitch: n.pitch, velocity: n.velocity, lenSteps: n.lenSteps, micro: n.micro });

describe.skipIf(!have)('cross-device copy', () => {
  const dn2Source = () => dn2.decodePatternKit(payloadOf(DN2_FIXTURE, 0));   // trigs on tracks 3 and 9
  const dt2Source = () => dt2.decodePatternKit(payloadOf(DT2_FIXTURE, 0));   // trigs on several tracks
  const dt2Target = () => payloadOf(DT2_FIXTURE, 1);                          // blank pattern A02
  const dn2Target = () => payloadOf(DN2_FIXTURE, 1);

  it('carries DN2 notes into a DT2 pattern, note for note', () => {
    const before = dt2Target();
    const { payload, dropped, drops } = copyTrack({
      sourceMod: dn2, sourcePatternKit: dn2Source(), sourceTrack: 2,
      targetMod: dt2, targetPayload: before, targetTrack: 5,
    });
    expect(dropped).toBe(0);
    expect(drops).toEqual([]);
    expect(dt2.trackNotes(dt2.decodePatternKit(payload), 5).map(musical))
      .toEqual(dn2.trackNotes(dn2Source(), 2).map(musical));
  });

  it('carries DT2 notes into a DN2 pattern, note for note', () => {
    const { payload } = copyTrack({
      sourceMod: dt2, sourcePatternKit: dt2Source(), sourceTrack: 10,
      targetMod: dn2, targetPayload: dn2Target(), targetTrack: 0,
    });
    expect(dn2.trackNotes(dn2.decodePatternKit(payload), 0).map(musical))
      .toEqual(dt2.trackNotes(dt2Source(), 10).map(musical));
  });

  it('changes only the target track\'s trig region and pool records', () => {
    const before = dt2Target();
    const { payload } = copyTrack({
      sourceMod: dn2, sourcePatternKit: dn2Source(), sourceTrack: 2,
      targetMod: dt2, targetPayload: before, targetTrack: 5,
    });
    expectOnlyTrackBytesChanged(DT2, before, payload, 5);

    const beforeKit = dt2.decodePatternKit(before);
    const afterKit = dt2.decodePatternKit(payload);
    expect(afterKit.kit.soundNames).toEqual(beforeKit.kit.soundNames);
    expect(afterKit.name).toBe(beforeKit.name);
    expect(afterKit.tempoBpm).toBe(beforeKit.tempoBpm);
    expect(afterKit.kitIndex).toBe(beforeKit.kitIndex);
  });

  it('leaves the target\'s other tracks alone', () => {
    const before = payloadOf(DT2_FIXTURE, 0); // a pattern that already has notes
    const { payload } = copyTrack({
      sourceMod: dn2, sourcePatternKit: dn2Source(), sourceTrack: 2,
      targetMod: dt2, targetPayload: before, targetTrack: 5,
    });
    const beforeKit = dt2.decodePatternKit(before);
    const afterKit = dt2.decodePatternKit(payload);
    for (let t = 0; t < 16; t++) {
      if (t === 5) continue;
      expect(dt2.trackNotes(afterKit, t), `track ${t + 1} changed`).toEqual(dt2.trackNotes(beforeKit, t));
    }
  });

  it('copies between two patterns on the same box', () => {
    const before = dt2Target();
    const { payload } = copyTrack({
      sourceMod: dt2, sourcePatternKit: dt2Source(), sourceTrack: 10,
      targetMod: dt2, targetPayload: before, targetTrack: 10,
    });
    expect(dt2.trackNotes(dt2.decodePatternKit(payload), 10).map(musical))
      .toEqual(dt2.trackNotes(dt2Source(), 10).map(musical));
    expectOnlyTrackBytesChanged(DT2, before, payload, 10);
  });

  it('copies an empty track, clearing the target track', () => {
    const before = payloadOf(DT2_FIXTURE, 0);
    const { payload, notes } = copyTrack({
      sourceMod: dn2, sourcePatternKit: dn2Source(), sourceTrack: 0, // blank on the DN2
      targetMod: dt2, targetPayload: before, targetTrack: 10,        // 8 trigs on the DT2
    });
    expect(notes).toEqual([]);
    expect(dt2.trackNotes(dt2.decodePatternKit(payload), 10)).toEqual([]);
    expectOnlyTrackBytesChanged(DT2, before, payload, 10);
  });
});

describe.skipIf(!have)('chord truncation, DN2 → DT2', () => {
  // A DN2 trig can hold more notes than a DT2 trig has slots. The fixture has
  // no such chord, so build one the way the DN2 stores them: consecutive
  // per-note pool records sharing (track, step), with the step's trig bits set.
  function dn2WithChord(step, voices) {
    const payload = Uint8Array.from(payloadOf(DN2_FIXTURE, 1)); // blank pattern
    const { pattern: P, track: T } = dn2.SPEC;
    const trackIndex = 0;
    voices.forEach(([pitch, velocity], i) => {
      const o = P.trigPool + i * 6;
      payload.set([trackIndex, step, pitch, velocity, 14, 0], o);
    });
    const stepWord = P.tracksOffset + trackIndex * T.size + step * 2;
    payload[stepWord] |= 0x03;
    payload[stepWord + 1] |= 0x81;
    return dn2.decodePatternKit(payload);
  }

  const sixVoices = [[36, 100], [43, 127], [48, 90], [55, 127], [60, 110], [67, 80]];

  it('keeps the four highest-velocity notes and reports the rest', () => {
    const source = dn2WithChord(0, sixVoices);
    expect(dn2.trackNotes(source, 0)).toHaveLength(6);

    const { payload, notes, dropped, drops, warnings } = copyTrack({
      sourceMod: dn2, sourcePatternKit: source, sourceTrack: 0,
      targetMod: dt2, targetPayload: payloadOf(DT2_FIXTURE, 1), targetTrack: 0,
      targetName: 'the Digitakt II',
    });

    // Velocities 127, 127, 110, 100 survive; 90 and 80 don't.
    expect(notes.map(n => n.pitch)).toEqual([36, 43, 55, 60]);
    expect(dropped).toBe(0); // the policy ran here, so the encoder never had to drop
    expect(drops).toHaveLength(1);
    expect(drops[0].step).toBe(0);
    expect(drops[0].dropped.map(n => n.pitch)).toEqual([48, 67]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/step 1/);
    expect(warnings[0]).toMatch(/note 48 \(vel 90\)/);
    expect(warnings[0]).toMatch(/note 67 \(vel 80\)/);
    expect(warnings[0]).toMatch(/the Digitakt II/);

    expect(dt2.trackNotes(dt2.decodePatternKit(payload), 0).map(n => n.pitch)).toEqual([36, 43, 55, 60]);
  });

  it('keeps the lower pitch when velocities tie', () => {
    // All six at the same velocity: the four lowest pitches win.
    const source = dn2WithChord(4, sixVoices.map(([pitch]) => [pitch, 100]));
    const { notes, drops } = copyTrack({
      sourceMod: dn2, sourcePatternKit: source, sourceTrack: 0,
      targetMod: dt2, targetPayload: payloadOf(DT2_FIXTURE, 1), targetTrack: 0,
    });
    expect(notes.map(n => n.pitch)).toEqual([36, 43, 48, 55]);
    expect(drops[0].dropped.map(n => n.pitch)).toEqual([60, 67]);
  });

  it('never truncates silently', () => {
    const source = dn2WithChord(0, sixVoices);
    const { drops, warnings } = copyTrack({
      sourceMod: dn2, sourcePatternKit: source, sourceTrack: 0,
      targetMod: dt2, targetPayload: payloadOf(DT2_FIXTURE, 1), targetTrack: 0,
    });
    expect(drops.length).toBe(warnings.length);
    expect(warnings.every(w => w.length > 0)).toBe(true);
  });
});

describe('truncateChords policy', () => {
  const note = (step, pitch, velocity) => ({ step, pitch, velocity, len: 1, micro: 0 });

  it('leaves chords that already fit completely alone', () => {
    const notes = [note(0, 60, 100), note(0, 64, 90), note(4, 67, 80)];
    const { notes: kept, drops } = truncateChords(notes, 4);
    expect(kept).toEqual(notes);
    expect(drops).toEqual([]);
  });

  it('ranks by velocity, then by lower pitch', () => {
    const notes = [note(0, 60, 50), note(0, 64, 90), note(0, 67, 90), note(0, 72, 10)];
    const { notes: kept, drops } = truncateChords(notes, 2);
    expect(kept.map(n => n.pitch)).toEqual([64, 67]); // both vel 90
    expect(drops[0].dropped.map(n => n.pitch)).toEqual([60, 72]);
  });

  it('truncates each step independently', () => {
    const notes = [
      note(0, 60, 100), note(0, 64, 90), note(0, 67, 80),
      note(8, 36, 100),
    ];
    const { notes: kept, drops } = truncateChords(notes, 2);
    expect(kept.map(n => [n.step, n.pitch])).toEqual([[0, 60], [0, 64], [8, 36]]);
    expect(drops).toHaveLength(1);
    expect(drops[0].step).toBe(0);
  });

  it('returns notes sorted by step then pitch, as the encoder expects', () => {
    const notes = [note(8, 40, 100), note(0, 67, 100), note(0, 36, 100)];
    expect(truncateChords(notes, 4).notes.map(n => [n.step, n.pitch]))
      .toEqual([[0, 36], [0, 67], [8, 40]]);
  });

  it('describes drops in words a human can act on', () => {
    const { drops } = truncateChords(
      [note(3, 60, 100), note(3, 64, 90), note(3, 67, 80)], 2);
    expect(describeChordDrops(drops, 'the Digitakt II')).toEqual([
      'step 4: the Digitakt II holds 2 notes per trig, so note 67 (vel 80) was dropped',
    ]);
  });
});
