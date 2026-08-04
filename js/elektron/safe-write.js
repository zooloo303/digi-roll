// The safe write flow, shared by every write path added in Phase 4.
//
// This is the Phase 2 "Write to pattern" sequence from js/labs/console.js —
// the hardware-verified reference implementation — lifted into one function so
// that a new caller physically cannot skip a step. CLAUDE.md's safety rules map
// onto it like this:
//
//   1. auto-backup    the untouched target pattern goes to onBackup (which the
//                     UI downloads as .syx) before a single byte is sent, and
//                     the write aborts if that hook throws. The hook is
//                     mandatory: no backup, no write.
//   2. minimal diff   only encodeTrackNotes, applyTrackTrigSettings,
//                     applyTrackProb, applyTrackPLocks and applySwing touch the
//                     payload, so every byte outside the track's step words, the
//                     trig-record pool, that track's three trig-condition lanes,
//                     its one track-PROB byte, the p-lock lanes belonging to
//                     that track and the pattern's one swing byte round-trips
//                     identically.
//   3. allowlist      writeGate() refuses any OS build the format hasn't been
//                     verified against.
//   4. verify         the pattern is read back and byte-compared; the caller
//                     gets the mismatching offsets to report loudly.
//   5. throwaway      a human rule — the confirm hook is where the UI spells
//                     out exactly what is about to be overwritten.
//
// The target payload is always re-fetched here, immediately before encoding.
// Callers never pass in bytes captured earlier: writing back a stale payload
// would silently revert everything changed on the box since.
//
// The console page's own Phase 2 button keeps its original inline flow
// untouched (it is the hardware-verified one); this module is what the Phase 4
// paths — write-back from the piano roll, and cross-device copy — run.

import { buildDumpMessage, DUMP, FAMILY } from './protocol.js';
import { bankName, diffPayloads, trackTrigCount } from './pattern-core.js';
import { applyTrackTrigSettings, applyTrackProb, trigSettingsFromNotes } from './trig-cond.js';
import { applyTrackPLocks, readTrackPLocks, freeLaneCount } from './plocks.js';
import { applySwing, readSwing } from './pattern-settings.js';
import * as dt2 from './dt2/pattern.js';
import * as dn2 from './dn2/pattern.js';

// Devices whose pattern structs digi-roll can decode.
export const DECODERS = {
  digitakt2: dt2,
  digitone2: dn2,
};

// Product identity by dump family byte, for the paths that read a .syx file
// and so never get an identity handshake to ask.
export const PRODUCT_BY_FAMILY = {
  [FAMILY.DIGITAKT_2]: { slug: 'digitakt2', productId: 42, name: 'Digitakt II' },
  [FAMILY.DIGITONE_2]: { slug: 'digitone2', productId: 43, name: 'Digitone II' },
};

// OS builds the pattern write path has been verified against on real hardware,
// per device — a full encode → send → re-read → byte-compare cycle plus a
// controlled-experiment pass over the trig fields (see the format docs).
// Extend a list only after re-verifying on the new build.
export const WRITE_ALLOWED_BUILDS = {
  digitakt2: ['0070'],  // 1.15B, verified 2026-08-01
  digitone2: ['0049'],  // 1.10D, verified 2026-08-01
};

export const decoderFor = slug => DECODERS[slug] ?? null;

// May we write to this device? Returns { ok, reason, mod } — `reason` is
// written to be shown to the user verbatim.
export function writeGate(identity) {
  if (!identity) return { ok: false, reason: 'no device connected', mod: null };
  const mod = decoderFor(identity.slug);
  if (!mod) {
    return { ok: false, reason: `digi-roll can't decode ${identity.name} patterns — read-only`, mod: null };
  }
  const builds = WRITE_ALLOWED_BUILDS[identity.slug] ?? [];
  if (!builds.includes(identity.build)) {
    return { ok: false, reason: `OS build ${identity.build} isn't write-verified yet — read-only`, mod };
  }
  return { ok: true, reason: '', mod };
}

// Wrap an untouched pattern payload back up as a replayable .syx message.
export function patternKitBackup(identity, index, payload, now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  return {
    index,
    payload,
    name: `${identity.slug}-${bankName(index)}-backup-${stamp}.syx`,
    bytes: buildDumpMessage(identity.family, DUMP.PATTERN_KIT, index, payload),
  };
}

// Replace one track's notes in one pattern on the box, safely.
//
//   device      a connected ElektronDevice (identified)
//   index       target pattern slot, 0–127
//   trackIndex  target track, 0–15
//   notes       encoder-shaped notes: { step, pitch, velocity, len, micro }
//   trackProb   optional 0–100 track-level PROB default; null leaves the byte
//               alone, which is what a caller with nothing to say should do
//   plocks      optional array of this track's p-lock lanes, { paramId, values }
//               with values as stored uint16 / null per step. `null` leaves the
//               lane pool completely alone; an array — **including an empty
//               one** — means "these are the track's lanes", so the track's
//               existing lanes on the box are freed. That is deliberate and
//               matches the conditions scrub: the notes are being replaced, and
//               automation left behind would belong to trigs that no longer
//               exist. A caller passing an array is expected to have said so in
//               its confirm text; `confirm` receives `boxPLocks` for exactly
//               that
//   swing       optional 50–80 pattern swing; null leaves the byte alone. This
//               one is per *pattern*, so it changes every track in the slot —
//               the confirm hook is where a caller says so
//   onBackup    required; receives { index, payload, name, bytes } before the
//               write. Throw from it to abort.
//   confirm     optional; receives a summary of what is about to be
//               overwritten, return falsy to cancel.
//   onStatus / onLog   progress strings for the UI.
//
// Resolves to { ok, cancelled, diffs, dropped, written, warnings, label, backup,
// payload }. `ok` false with an empty `diffs` never happens: a false `ok` always
// carries the offsets that mismatched, for a loud report. `warnings` is what
// landed differently from what was asked for while still being a successful
// write — a full lane pool, say — and callers show it alongside the result.
export async function safeWriteTrack(device, {
  index, trackIndex, notes, trackProb = null, plocks = null, swing = null,
  onBackup, confirm = null, onStatus = () => {}, onLog = () => {},
}) {
  const gate = writeGate(device?.identity);
  if (!gate.ok) throw new Error(gate.reason);
  if (typeof onBackup !== 'function') {
    throw new Error('refusing to write without a backup hook');
  }
  const mod = gate.mod;
  const label = bankName(index);

  // Rule: re-fetch. This payload is both the backup and the base we edit, so
  // the write can only ever differ from what is on the box right now by the
  // one track we were asked to change.
  onStatus(`Fetching ${label} for backup…`);
  const original = await device.fetchPatternKit(index);
  const target = mod.decodePatternKit(original);
  const existingTrigs = trackTrigCount(target, trackIndex);

  // `swing` here is what the box is holding right now, so a UI can say what the
  // write would change it to — it reaches every track in the slot, unlike
  // anything else in this function.
  const confirmArgs = {
    patternKit: target, label, index, trackIndex, existingTrigs,
    noteCount: notes.length, swing: readSwing(mod.SPEC, original),
    // What the box currently has on this track, and how much room the pool has
    // left — both only knowable here, after the re-fetch, and both things a
    // caller may need to warn about before anything is overwritten.
    boxPLocks: readTrackPLocks(mod.SPEC, original, trackIndex),
    freeLanes: freeLaneCount(mod.SPEC, original),
  };
  if (confirm && !await confirm(confirmArgs)) {
    return { ok: false, cancelled: true, diffs: [], dropped: 0, written: 0, warnings: [], label, index, trackIndex, backup: null, payload: null };
  }

  const backup = patternKitBackup(device.identity, index, original);
  await onBackup(backup);
  onLog(`Pre-write backup saved: ${backup.name}`);

  const { payload, dropped } = mod.encodeTrackNotes(original, trackIndex, notes);
  // Per-trig conditions live in three per-step lanes the encoder doesn't know
  // about, so they go on afterwards, into the fresh copy it just returned.
  // applyTrackTrigSettings scrubs all 128 steps of this track's lanes first —
  // the box does that when it creates a trig, and a write that skips it would
  // leave a new trig inheriting a deleted one's probability.
  applyTrackTrigSettings(mod.SPEC, payload, trackIndex, trigSettingsFromNotes(notes));
  // The track's own PROB default is one byte in the defaults tail. Only touched
  // when the caller has a value; a caller that doesn't model it leaves whatever
  // the box was already holding.
  if (trackProb != null) applyTrackProb(mod.SPEC, payload, trackIndex, trackProb);
  // p-lock lanes live in the pattern-wide pool of 80, shared with the other
  // fifteen tracks — so unlike the condition lanes this one scrubs per lane
  // rather than wholesale, and it can run out of room. When it does, the notes
  // still land and the shortfall comes back as a warning.
  const warnings = [];
  if (plocks != null) {
    warnings.push(...applyTrackPLocks(mod.SPEC, payload, trackIndex, plocks).warnings);
  }
  // Swing is one byte in the pattern's settings tail, and it belongs to the
  // whole slot rather than this track — so it only moves when the caller has a
  // value, and callers are expected to have warned about the reach.
  if (swing != null) applySwing(mod.SPEC, payload, swing);

  onStatus(`Writing ${label} T${trackIndex + 1}…`);
  await device.sendPatternKit(index, payload);

  onStatus('Verifying — reading the pattern back…');
  const reread = await device.fetchPatternKit(index);
  const diffs = diffPayloads(payload, reread);

  return {
    ok: diffs.length === 0,
    cancelled: false,
    diffs,
    dropped,
    written: notes.length - dropped,
    warnings,
    label, index, trackIndex, backup, payload,
  };
}

// The one-line report for a finished write, identical wording everywhere it is
// shown. `isError` tells the UI whether to shout.
export function writeResultMessage(result) {
  const where = `${result.label} T${result.trackIndex + 1}`;
  if (result.cancelled) return { text: 'Write cancelled', isError: false };
  if (result.ok) {
    // A warning means the write succeeded but not entirely as asked — a lane
    // that didn't fit, say. Flagged as an error so the UI shouts, because
    // "verified byte-identical" on its own would read as "all of it went".
    const warnings = result.warnings ?? [];
    return {
      text: `✓ Wrote ${result.written} note${result.written === 1 ? '' : 's'} to ${where} — verified byte-identical`
        + (result.dropped ? ` (${result.dropped} note${result.dropped === 1 ? '' : 's'} didn't fit and ${result.dropped === 1 ? 'was' : 'were'} dropped)` : '')
        + (warnings.length ? ` — but ${warnings.join('; ')}` : ''),
      isError: warnings.length > 0,
    };
  }
  return {
    text: `⚠ Write verify FAILED for ${where}: ${result.diffs.length}+ bytes differ — the box did not store what we sent. `
      + `The pre-write backup ${result.backup?.name ?? ''} was downloaded; send it back to restore.`,
    isError: true,
  };
}
