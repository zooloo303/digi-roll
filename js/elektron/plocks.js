// Parameter locks: the 80-lane pool that holds per-step automation.
//
// Same discipline as trig-cond.js — pure functions over a pattern-kit payload
// plus a device spec, composed *after* the hardware-verified encodeTrackNotes
// rather than reaching into it. The caller runs encodeTrackNotes first and hands
// the fresh payload it returns to applyTrackPLocks.
//
// Layout (`spec.pattern.pLocksIndex`, `numPLocks`, `pLockSize`), from elk-herd's
// CppStructs.elm and corroborated by every committed fixture:
//
//   80 lanes × 258 bytes, each lane:
//     +0    paramId  u8    which parameter this lane automates, FF = lane free
//     +1    track    u8    which track it belongs to, FF = lane free
//     +2    128 × uint16be, one value per step
//
// A lane is keyed by (paramId, track): one lane automates one parameter on one
// track, so a track using four p-locked parameters holds four lanes, and all
// sixteen tracks share the same pool of 80.
//
// What is measured and what is inferred — this matters, because none of it is
// hardware-verified yet and the write path below acts on it:
//
//   [measured] A free lane is `FF FF` followed by 256 **zero** bytes. Exactly
//     160 FFs and 20480 zeros across the whole region, in all 128 patterns of
//     the DT2 project fixture and in every DN2 fixture. Both format docs said
//     `FFFF` for unused values; the fixtures say otherwise, and they are what
//     `freeLane` below imitates.
//   [measured] The region ends exactly at `pattern.nameOffset` — 80 × 258 fills
//     it with no slack, on both boxes.
//   [measured] Within an *allocated* lane, `FFFF` marks a step with no lock. This
//     was an inference until the first real lane was captured (a DN2, 2026-08-04,
//     logged in docs/dn2-pattern-format.md): one locked step held a value and the
//     other 127 read `FFFF`. It could never have been 0x0000 — 0 is a legal value
//     for most parameters — and it is what `writeLane` below stores.
//   [measured] A lane value is **wider than 7 bits**. That same lane held
//     `0x3F29`, just under the 14-bit ceiling of 16383, which is what NRPN
//     carries. So a lane is not storing the 0–127 number a CC would.
//   [unknown] What paramId numbers mean on each box, what the u16 values scale
//     to, and whether the box compacts lanes when it frees one. The first two are
//     the `plock` half of the parameter tables in dt2/params.js and dn2/params.js
//     (null on every entry, pending the hardware experiments in PLAN.md's Phase
//     0 — the leading hypothesis is that paramId is the parameter's NRPN LSB);
//     the third is why `applyTrackPLocks` keeps a lane at the index it already
//     occupies instead of repacking.

const FREE = 0xff;

// Per-step "no lock here" inside an allocated lane. Measured; see the header.
export const NO_VALUE = 0xffff;

// The largest value a step can hold, since NO_VALUE takes the top of the range.
export const VALUE_MAX = 0xfffe;

const laneStart = (spec, lane) => spec.pattern.pLocksIndex + lane * spec.pattern.pLockSize;

function assertLanes(spec) {
  const { pLocksIndex, numPLocks, pLockSize } = spec.pattern;
  if (pLocksIndex == null || numPLocks == null || pLockSize == null) {
    throw new Error(`${spec.device} spec has no p-lock pool offsets`);
  }
  return { pLocksIndex, numPLocks, pLockSize };
}

function assertTrack(spec, trackIndex) {
  if (trackIndex < 0 || trackIndex >= spec.pattern.numTracks) {
    throw new Error(`no track ${trackIndex}`);
  }
}

// --- Reading ------------------------------------------------------------------

// One lane, or null when the lane is free.
//
// `values` is always `spec.track.numSteps` long, holding the stored u16 for
// steps that carry a lock and `null` for steps that don't. Stored numbers, not
// display values: scaling belongs to the param table, and a lane whose paramId
// isn't curated has no scaling at all — it still has to survive a round trip.
export function readLane(spec, payload, lane) {
  assertLanes(spec);
  const o = laneStart(spec, lane);
  const paramId = payload[o];
  const track = payload[o + 1];
  if (paramId === FREE && track === FREE) return null;
  const values = [];
  for (let step = 0; step < spec.track.numSteps; step++) {
    const v = (payload[o + 2 + step * 2] << 8) | payload[o + 3 + step * 2];
    values.push(v === NO_VALUE ? null : v);
  }
  return { lane, paramId, track, values };
}

// Every allocated lane in the pattern, in lane order. The diff lab's raw view,
// and how the write path finds out what it must not disturb.
export function readAllPLocks(spec, payload) {
  const { numPLocks } = assertLanes(spec);
  const lanes = [];
  for (let lane = 0; lane < numPLocks; lane++) {
    const read = readLane(spec, payload, lane);
    if (read) lanes.push(read);
  }
  return lanes;
}

// One track's lanes, in lane order.
//
// A lane whose header is half-free (`paramId` set, `track` FF, or the reverse)
// is not this track's business and is left for readAllPLocks to report: this
// function answers "what automation does track N carry", and a malformed lane
// carries none.
export function readTrackPLocks(spec, payload, trackIndex) {
  assertTrack(spec, trackIndex);
  return readAllPLocks(spec, payload).filter(l => l.track === trackIndex);
}

// How many lanes are free right now — the budget a write has to fit inside.
export function freeLaneCount(spec, payload) {
  const { numPLocks } = assertLanes(spec);
  return numPLocks - readAllPLocks(spec, payload).length;
}

// Does this lane hold a value on a step with no trig? A "trigless lock" — the
// box can hold them and digi-roll's v1 deliberately doesn't model them, so a
// lane like this is shown read-only and passed through byte-exact instead of
// being edited into a lie. `liveSteps` is a Set of steps that have trigs.
export function laneHasTriglessValues(lane, liveSteps) {
  return lane.values.some((v, step) => v != null && !liveSteps.has(step));
}

// --- Writing ------------------------------------------------------------------

// Reset one lane to the form the boxes leave a never-used lane in: `FF FF` and
// 256 zero bytes. Measured across every fixture; see the header.
function freeLane(spec, payload, lane) {
  const o = laneStart(spec, lane);
  payload[o] = FREE;
  payload[o + 1] = FREE;
  payload.fill(0, o + 2, o + spec.pattern.pLockSize);
}

// Write one lane's header and values. `values` is an array of stored u16 /
// null, shorter arrays leaving the rest of the steps unlocked.
function writeLane(spec, payload, lane, paramId, trackIndex, values) {
  const o = laneStart(spec, lane);
  payload[o] = paramId & 0xff;
  payload[o + 1] = trackIndex & 0xff;
  for (let step = 0; step < spec.track.numSteps; step++) {
    const v = values[step];
    const word = v == null ? NO_VALUE : Math.max(0, Math.min(VALUE_MAX, Math.round(v)));
    payload[o + 2 + step * 2] = (word >> 8) & 0xff;
    payload[o + 3 + step * 2] = word & 0xff;
  }
}

// Does a lane carry anything worth storing?
const laneIsEmpty = lane => !lane.values?.some(v => v != null);

// Write one track's p-lock lanes into a payload, in place.
//
// `lanes` is an iterable of `{ paramId, values }` — stored u16 / null per step,
// exactly what readTrackPLocks produced. Returns `{ payload, warnings }`;
// warnings are written to be shown to the user verbatim, like copy-track's
// chord drops, and are the only way this function reports trouble. It does not
// throw on a full pool: a write that can't fit every lane should still land the
// notes, loudly.
//
// The policy, and why:
//
//   * A lane the track already has for the same paramId is **rewritten where it
//     is**. Whether the box cares about lane order is unknown (Phase 0 step 6),
//     so the safest write is the one that moves fewest bytes.
//   * A lane the track has for a paramId no longer wanted is **freed** to the
//     measured empty form.
//   * A new paramId claims the **lowest-numbered free lane**, after the frees,
//     so emptying one param and adding another reuses the same slot.
//   * Lanes belonging to other tracks are never read, moved or written. A
//     one-track write must not disturb the other fifteen.
//   * A lane with no values at all is not allocated — storing an all-`FFFF`
//     lane would claim a slot to say nothing.
//
// Like applyTrackTrigSettings this scrubs before it writes, and for the same
// reason: a step that lost its trig must not leave a lock behind for the next
// trig to inherit. Unlike that function the scrub is per lane rather than
// wholesale, because the pool is shared with fifteen other tracks.
export function applyTrackPLocks(spec, payload, trackIndex, lanes) {
  assertLanes(spec);
  assertTrack(spec, trackIndex);
  const warnings = [];

  // What we want this track to end up with, keyed by paramId.
  const wanted = new Map();
  for (const lane of lanes ?? []) {
    if (lane?.paramId == null || lane.paramId === FREE) continue;
    if (laneIsEmpty(lane)) continue;
    if (wanted.has(lane.paramId)) {
      warnings.push(`p-lock parameter ${lane.paramId} appears twice for track ${trackIndex + 1} — `
        + 'the box holds one lane per parameter per track, so only the first was written');
      continue;
    }
    wanted.set(lane.paramId, lane.values);
  }

  // Existing lanes: rewrite the ones still wanted, free the rest.
  const reused = new Map();
  for (const existing of readTrackPLocks(spec, payload, trackIndex)) {
    if (wanted.has(existing.paramId) && !reused.has(existing.paramId)) {
      reused.set(existing.paramId, existing.lane);
      writeLane(spec, payload, existing.lane, existing.paramId, trackIndex, wanted.get(existing.paramId));
    } else {
      freeLane(spec, payload, existing.lane);
    }
  }

  // New params claim free lanes. Recomputed after the frees, so a param that
  // just went away hands its slot to a param that just arrived.
  const taken = new Set(readAllPLocks(spec, payload).map(l => l.lane));
  const freeLanes = [];
  for (let lane = 0; lane < spec.pattern.numPLocks; lane++) if (!taken.has(lane)) freeLanes.push(lane);

  const dropped = [];
  for (const [paramId, values] of wanted) {
    if (reused.has(paramId)) continue;
    const lane = freeLanes.shift();
    if (lane == null) { dropped.push(paramId); continue; }
    writeLane(spec, payload, lane, paramId, trackIndex, values);
  }
  if (dropped.length) {
    warnings.push(`the pattern's ${spec.pattern.numPLocks} p-lock lanes are all in use, so `
      + `${dropped.length} lane${dropped.length === 1 ? '' : 's'} `
      + `(parameter${dropped.length === 1 ? '' : 's'} ${dropped.join(', ')}) `
      + `${dropped.length === 1 ? 'was' : 'were'} not written — free some p-locks on the box first`);
  }

  return { payload, warnings };
}
