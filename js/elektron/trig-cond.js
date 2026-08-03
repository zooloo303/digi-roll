// Per-trig PROB / FILL / COND: reading and writing the three per-step lanes.
//
// These are pure functions over a pattern-kit payload plus a device spec. They
// compose with the hardware-verified decode/encode in pattern-core.js rather
// than reaching into it: the caller runs encodeTrackNotes first and hands the
// fresh payload it returns to applyTrackTrigSettings.
//
// Storage (hardware-mapped 2026-08-02, identical on DT2 and DN2 — see the [V2]
// sections of the format docs): three 128-byte lanes inside the track struct,
// one byte per step, `FF` = nothing stored.
//
//   track +256  COND   menu index 0-75
//   track +384  FILL   01 ON / 00 OFF
//   track +512  PROB   the percentage itself
//
// The lane offsets live in each device SPEC as `track.trigCond/trigFill/
// trigProb`, so this module never hard-codes a number.

import {
  NONE, condFromByte, condToByte, fillFromByte, fillToByte, probFromByte, probToByte,
  isDefaultTrigSetting,
} from './conditions.js';

// Byte offset of one step's byte in one of the three lanes.
const laneOffset = (spec, laneStart, trackIndex, step) =>
  spec.pattern.tracksOffset + trackIndex * spec.track.size + laneStart + step;

function lanesOf(spec) {
  const { trigCond, trigFill, trigProb } = spec.track;
  if (trigCond == null || trigFill == null || trigProb == null) {
    throw new Error(`${spec.device} spec has no trig-condition lane offsets`);
  }
  return { trigCond, trigFill, trigProb };
}

function assertTrack(spec, trackIndex) {
  if (trackIndex < 0 || trackIndex >= spec.pattern.numTracks) {
    throw new Error(`no track ${trackIndex}`);
  }
}

// Every stored trig setting on one track: Map(step → { prob, fill, cond }).
//
// Steps whose three lane bytes are all "none" are skipped, so a pattern with no
// conditions yields an empty map. Steps are *not* filtered by whether their trig
// is live — deleting a trig on the box leaves FILL and PROB bytes behind, and
// the caller (which knows the live steps) decides what to do with leftovers.
// The import path only ever asks about steps that have notes.
export function readTrackTrigSettings(spec, payload, trackIndex) {
  assertTrack(spec, trackIndex);
  const { trigCond, trigFill, trigProb } = lanesOf(spec);
  const out = new Map();
  for (let step = 0; step < spec.track.numSteps; step++) {
    const cond = condFromByte(payload[laneOffset(spec, trigCond, trackIndex, step)]);
    const fill = fillFromByte(payload[laneOffset(spec, trigFill, trackIndex, step)]);
    const prob = probFromByte(payload[laneOffset(spec, trigProb, trackIndex, step)]);
    if (cond === null && fill === null && prob === null) continue;
    out.set(step, { prob, fill, cond });
  }
  return out;
}

// One step's stored setting, or null when nothing is stored there.
export function readStepTrigSetting(spec, payload, trackIndex, step) {
  assertTrack(spec, trackIndex);
  const { trigCond, trigFill, trigProb } = lanesOf(spec);
  const setting = {
    prob: probFromByte(payload[laneOffset(spec, trigProb, trackIndex, step)]),
    fill: fillFromByte(payload[laneOffset(spec, trigFill, trackIndex, step)]),
    cond: condFromByte(payload[laneOffset(spec, trigCond, trackIndex, step)]),
  };
  return isDefaultTrigSetting(setting) ? null : setting;
}

// Write one track's trig settings into a payload, in place, and return it.
//
// `byStep` is a Map (or any iterable of [step, setting]) of step →
// { prob, fill, cond }. Callers pass the fresh copy encodeTrackNotes returned,
// so this is the only mutation of an already-cloned buffer.
//
// Every one of the track's 128 steps is cleared to `FF` first. That is not
// tidiness — the box scrubs these lanes when *it* creates a trig, and a write
// path that bypasses trig creation has to do the same, or a fresh trig silently
// inherits a deleted one's probability. Verified on hardware: deleting a trig
// clears its COND byte but leaves FILL and PROB behind.
//
// Nothing outside this track's three lanes is touched.
export function applyTrackTrigSettings(spec, payload, trackIndex, byStep) {
  assertTrack(spec, trackIndex);
  const { trigCond, trigFill, trigProb } = lanesOf(spec);
  const { numSteps } = spec.track;

  for (const lane of [trigCond, trigFill, trigProb]) {
    const start = laneOffset(spec, lane, trackIndex, 0);
    payload.fill(NONE, start, start + numSteps);
  }

  for (const [step, setting] of byStep ?? []) {
    if (!Number.isInteger(step) || step < 0 || step >= numSteps) continue;
    if (isDefaultTrigSetting(setting)) continue;
    payload[laneOffset(spec, trigCond, trackIndex, step)] = condToByte(setting.cond);
    payload[laneOffset(spec, trigFill, trackIndex, step)] = fillToByte(setting.fill);
    payload[laneOffset(spec, trigProb, trackIndex, step)] = probToByte(setting.prob);
  }
  return payload;
}

// Notes → the per-step settings the write path stores.
//
// All three fields are per trig, so a step's value comes from its first note in
// the encoder's own (step, pitch) order — mirroring exactly how encodeTrackNotes
// takes velocity/length/micro from the first note of a chord. Steps where all
// three are default are left out, so they stay `FF`.
export function trigSettingsFromNotes(notes) {
  const byStep = new Map();
  const seen = new Set(); // first note wins even when its setting is all-default
  for (const n of [...notes].sort((a, b) => a.step - b.step || a.pitch - b.pitch)) {
    if (!Number.isInteger(n.step) || seen.has(n.step)) continue;
    seen.add(n.step);
    const setting = { prob: n.prob ?? null, fill: n.fill ?? null, cond: n.cond ?? null };
    if (isDefaultTrigSetting(setting)) continue;
    byStep.set(n.step, setting);
  }
  return byStep;
}
