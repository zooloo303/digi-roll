// Device console page: SysEx hex log + identity handshake + project backup.
//
// This page requests its own MIDI access with sysex enabled — the piano roll
// (index.html) deliberately stays on sysex-free access so it never triggers
// the scarier browser permission prompt.

import { ElektronDevice } from '../elektron/device.js';
import { splitSysExStream, buildDumpMessage, DUMP, FAMILY } from '../elektron/protocol.js';
import { trackNotes, trackTrigCount, bankName, diffPayloads } from '../elektron/pattern-core.js';
import * as dt2 from '../elektron/dt2/pattern.js';
import * as dn2 from '../elektron/dn2/pattern.js';

// Devices whose pattern structs digi-roll can decode. Write stays a separate,
// stricter gate below — the DN2 format is read-verified but not write-verified.
const DECODERS = {
  digitakt2: dt2,
  digitone2: dn2,
};
const DECODER_BY_FAMILY = {
  [FAMILY.DIGITAKT_2]: { mod: dt2, label: 'Digitakt II' },
  [FAMILY.DIGITONE_2]: { mod: dn2, label: 'Digitone II' },
};
import { loadState, saveState, NUM_SLOTS } from '../state.js';
import {
  deviceNotesToRoll, rollLengthForTrack, makeSource, attachTrigSettings, devicePLocksToRoll,
} from '../roll-bridge.js';
import { readTrackTrigSettings, readTrackProb } from '../elektron/trig-cond.js';
import { readTrackPLocks } from '../elektron/plocks.js';
import { readSwing } from '../elektron/pattern-settings.js';
import { PRODUCT_BY_FAMILY, writeGate, safeWriteTrack, writeResultMessage } from '../elektron/safe-write.js';
import { trackNotesForTarget, describeChordDrops, plockLanesForTarget } from '../elektron/copy-track.js';
import { downloadBytes } from '../download.js';

const $ = id => document.getElementById(id);

const logEl = $('log');
const MAX_LOG_ENTRIES = 500;
let logCount = 0;

function hexDump(bytes, max = 512) {
  const shown = bytes.slice(0, max);
  let out = '';
  for (let i = 0; i < shown.length; i++) {
    out += shown[i].toString(16).padStart(2, '0');
    out += (i + 1) % 16 === 0 ? '\n' : ' ';
  }
  if (bytes.length > max) out += `\n… ${bytes.length - max} more bytes`;
  return out.trimEnd();
}

function addEntry(cls, html) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  logEl.appendChild(div);
  if (++logCount > MAX_LOG_ENTRIES) { logEl.firstChild.remove(); logCount--; }
  if ($('autoscroll').checked) logEl.scrollTop = logEl.scrollHeight;
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function logSysex(dir, bytes) {
  const arrow = dir === 'out' ? '→ sent' : '← recv';
  addEntry(dir, `<span class="meta"><b>${arrow}</b> ${bytes.length} bytes</span>\n<span class="hex">${hexDump(bytes)}</span>`);
}
const logNote = msg => addEntry('note', esc(msg));
const logError = msg => addEntry('error', esc(msg));

$('clearLog').onclick = () => { logEl.innerHTML = ''; logCount = 0; };

function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
}

// --- MIDI port pairing --------------------------------------------------------
// SysEx is a conversation, so we need an input and an output that belong to the
// same physical device. Elektron boxes expose matching port names over USB.

let access = null;
let device = null;

function listPairs() {
  const inputs = [...access.inputs.values()];
  return [...access.outputs.values()]
    .map(out => ({ out, in: inputs.find(i => i.name === out.name) }))
    .filter(p => p.in);
}

function refreshPorts() {
  const portSel = $('port');
  const prev = portSel.value;
  portSel.innerHTML = '';
  portSel.add(new Option('— device —', ''));
  for (const p of listPairs()) portSel.add(new Option(p.out.name, p.out.id));
  if ([...portSel.options].some(o => o.value === prev)) portSel.value = prev;
  if (!listPairs().length) setStatus('No two-way MIDI devices found — plug in your box via USB', true);
}

function disconnect() {
  device?.close();
  device = null;
  $('backup').disabled = true;
  $('impFetch').disabled = true;
  $('deviceInfo').textContent = '';
  syncWriteButtons();
}

$('port').onchange = disconnect;

// --- Connect: identity handshake ----------------------------------------------

$('connect').onclick = async () => {
  const pair = listPairs().find(p => p.out.id === $('port').value);
  if (!pair) { setStatus('Pick a device first', true); return; }
  disconnect();
  device = new ElektronDevice(pair.in, pair.out, { onSend: b => logSysex('out', b), onReceive: b => logSysex('in', b) });
  setStatus(`Asking ${pair.out.name} to identify itself…`);
  logNote(`Identity request → ${pair.out.name}`);
  try {
    const id = await device.identify();
    $('deviceInfo').innerHTML = `<b>${esc(id.name)}</b>&nbsp; OS ${esc(id.version)}`;
    logNote(`Identified: ${id.name}, OS ${id.version}`);
    if (id.supported) {
      setStatus(`Connected to ${id.name} (OS ${id.version})`);
      $('backup').disabled = false;
      $('impFetch').disabled = !DECODERS[id.slug];
      syncWriteButtons();
    } else {
      setStatus(`${id.name} identified, but digi-roll doesn't know its dump protocol — console stays read-only`, true);
    }
  } catch (err) {
    setStatus(`No identity reply: ${err.message}`, true);
    logError(`Identity request failed: ${err.message}`);
    disconnect();
  }
};

// --- Backup project -------------------------------------------------------------

$('backup').onclick = async () => {
  if (!device) return;
  $('backup').disabled = true;
  try {
    logNote('Fetching whole-project dump…');
    const t0 = performance.now();
    const dump = await device.fetchProjectDump(
      (received, total) => setStatus(`Backing up… ${received}${total ? ` / ${total}` : ''} messages`)
    );
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    logNote(`Project dump complete: ${dump.length} bytes in ${secs}s`);
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
    const name = `${device.identity.slug}-project-${stamp}.syx`;
    const url = URL.createObjectURL(new Blob([dump], { type: 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Backup saved: ${name} (${(dump.length / 1024).toFixed(1)} kB)`);
  } catch (err) {
    setStatus(`Backup failed: ${err.message}`, true);
    logError(`Project dump failed: ${err.message}`);
  } finally {
    $('backup').disabled = !device;
  }
};

// --- Import from box: DT2 pattern/track → piano roll ------------------------------
// Read-only Phase 2 milestone: fetch one pattern-kit (or decode one from a .syx
// file), pick a track, and its trigs land in a piano-roll slot via the shared
// localStorage state. Decoding lives in js/elektron/dt2/pattern.js.

let imported = null; // { patternKit, label, origin } once something is decoded

for (let i = 0; i < 128; i++) $('impPattern').add(new Option(bankName(i), i));
for (let i = 0; i < NUM_SLOTS; i++) $('impSlot').add(new Option(`Pattern ${i + 1}`, i));

// `origin` describes where the pattern came from ({ slug, productId,
// deviceName, patternIndex, origin }); it becomes the imported slot's
// provenance so the piano roll can write it back to the same place.
// Fill a track picker from a decoded pattern: "T3 · A_303_INNIT · 4 trigs".
// Tracks with no trigs are disabled unless `allowEmpty` (the copy bar allows
// them — copying an empty track is how you clear one). Returns whether any
// track is selectable.
function fillTrackOptions(sel, patternKit, kindFallback, allowEmpty = false) {
  sel.innerHTML = '';
  for (let t = 0; t < patternKit.tracks.length; t++) {
    const kind = patternKit.kit.midiMask & (1 << t) ? 'MIDI' : patternKit.kit.soundNames[t] || kindFallback;
    const trigs = trackTrigCount(patternKit, t);
    sel.add(new Option(`T${t + 1} · ${kind} · ${trigs} trig${trigs === 1 ? '' : 's'}`, t));
    if (trigs === 0 && !allowEmpty) sel.options[t].disabled = true;
  }
  const first = [...sel.options].find(o => !o.disabled);
  if (first) sel.value = first.value;
  sel.disabled = false;
  return !!first;
}

function patternSummary(patternKit, label) {
  const named = patternKit.name ? ` “${patternKit.name}”` : '';
  return `${label}${named} · kit ${patternKit.kit.name || '—'} · ${patternKit.tempoBpm} BPM`;
}

// `payload` and `spec` are kept alongside the decoded kit because the per-trig
// condition lanes are read straight off the raw bytes at import time.
function showPatternKit({ patternKit, payload, spec, label, kindFallback = 'sample', origin = null }) {
  imported = { patternKit, payload, spec, label, origin };
  $('impPatternInfo').textContent = patternSummary(patternKit, label);
  const any = fillTrackOptions($('impTrack'), patternKit, kindFallback);
  $('impGo').disabled = !any;
  if (!any) setStatus(`${label} decoded, but no track has any trigs`, true);
}

$('impFetch').onclick = async () => {
  if (!device) return;
  const decoder = DECODERS[device.identity?.slug];
  if (!decoder) return;
  const index = +$('impPattern').value;
  $('impFetch').disabled = true;
  try {
    logNote(`Requesting pattern-kit ${bankName(index)}…`);
    const payload = await device.fetchPatternKit(index);
    showPatternKit({
      patternKit: decoder.decodePatternKit(payload),
      payload,
      spec: decoder.SPEC,
      label: bankName(index),
      kindFallback: decoder.SPEC.trackKindFallback,
      origin: {
        slug: device.identity.slug,
        productId: device.identity.productId,
        deviceName: device.identity.name,
        patternIndex: index,
        origin: 'box',
      },
    });
    setStatus(`Fetched ${bankName(index)} — pick a track to import`);
  } catch (err) {
    setStatus(`Pattern fetch failed: ${err.message}`, true);
    logError(`Pattern fetch failed: ${err.message}`);
  } finally {
    $('impFetch').disabled = !device;
  }
};

$('impFile').onclick = () => $('impFileInput').click();
$('impFileInput').onchange = async () => {
  const file = $('impFileInput').files[0];
  if (!file) return;
  try {
    const kits = splitSysExStream(new Uint8Array(await file.arrayBuffer()))
      .filter(m => m.kind === 'dump' && DECODER_BY_FAMILY[m.family] && m.type === DUMP.PATTERN_KIT);
    if (!kits.length) throw new Error('no Digitakt II or Digitone II pattern-kit messages in this file');
    const wanted = +$('impPattern').value;
    const msg = kits.find(m => m.index === wanted) ?? kits[0];
    if (!msg.checksumOk || !msg.countOk) throw new Error(`pattern ${bankName(msg.index)} is corrupt in this file`);
    const { mod, label } = DECODER_BY_FAMILY[msg.family];
    const product = PRODUCT_BY_FAMILY[msg.family];
    $('impPattern').value = msg.index;
    showPatternKit({
      patternKit: mod.decodePatternKit(msg.payload),
      payload: msg.payload,
      spec: mod.SPEC,
      label: bankName(msg.index),
      kindFallback: mod.SPEC.trackKindFallback,
      origin: {
        slug: product.slug,
        productId: product.productId,
        deviceName: product.name,
        patternIndex: msg.index,
        origin: 'file',
      },
    });
    setStatus(`Decoded ${label} ${bankName(msg.index)} from ${file.name} (${kits.length} pattern${kits.length > 1 ? 's' : ''} in file) — pick a track`);
  } catch (err) {
    setStatus(`Couldn't decode ${file.name}: ${err.message}`, true);
    logError(`.syx decode failed: ${err.message}`);
  }
  $('impFileInput').value = '';
};

$('impGo').onclick = () => {
  if (!imported) return;
  const t = +$('impTrack').value;
  const slot = +$('impSlot').value;
  const track = imported.patternKit.tracks[t];
  const lengthSteps = rollLengthForTrack(track);
  const notes = attachTrigSettings(
    trackNotes(imported.patternKit, t).filter(n => n.step < track.lengthSteps),
    readTrackTrigSettings(imported.spec, imported.payload, t),
  );

  // p-lock lanes, off the raw payload like the condition lanes. `live` is every
  // step with a trig on the whole track, so a lane isn't called trigless merely
  // because the roll shows fewer bars than the track holds.
  const live = new Set(track.steps.flatMap((w, s) => (w & 1 ? [s] : [])));
  const lanes = devicePLocksToRoll(readTrackPLocks(imported.spec, imported.payload, t), imported.spec.device, live);

  const st = loadState(); // fresh — the piano-roll tab may have written since we loaded
  const p = st.patterns[slot];
  p.name = `${imported.label} T${t + 1}`;
  p.lengthSteps = lengthSteps;
  p.trackProb = readTrackProb(imported.spec, imported.payload, t);
  p.swing = readSwing(imported.spec, imported.payload); // per pattern, like the roll models it
  p.plocks = lanes;
  p.notes = deviceNotesToRoll(notes, lengthSteps);
  // Provenance: the roll's "Send to box" button starts aimed at exactly this
  // pattern and track, and refuses if a different box is plugged in.
  p.source = imported.origin
    ? makeSource({ ...imported.origin, trackIndex: t, patternName: imported.patternKit.name })
    : null;
  p.dest = p.source
    ? { patternIndex: p.source.patternIndex, trackIndex: t }
    : null;
  saveState(st);

  const laneNote = lanes.length ? ` and ${lanes.length} p-lock lane${lanes.length === 1 ? '' : 's'}` : '';
  setStatus(`Imported ${notes.length} note${notes.length === 1 ? '' : 's'}${laneNote} from ${imported.label} T${t + 1} into Pattern ${slot + 1} — open the piano roll`);
  logNote(`Imported ${imported.label} T${t + 1} → piano-roll slot ${slot + 1} (${notes.length} notes${laneNote})`);
};

// --- Write to box: piano-roll pattern → DT2 track --------------------------------
// The original hardware-verified write path. Safety rules from CLAUDE.md,
// enforced here:
//   1. the target pattern is fetched and downloaded as a backup before writing;
//   2. the encoder only touches the track's step words + the trig-record pool
//      (everything else round-trips byte-identical);
//   3. firmware allowlist — only OS builds the format was verified on;
//   4. verify-after-write: re-read, byte-compare, loud diff on mismatch.

// OS builds the pattern write path has been verified against on real
// hardware, per device — a full encode → send → re-read → byte-compare
// cycle plus a controlled-experiment pass over the trig fields (see the
// format docs). Extend a list only after re-verifying on the new build.
const WRITE_ALLOWED_BUILDS = {
  digitakt2: ['0070'],  // 1.15B, verified 2026-08-01
  digitone2: ['0049'],  // 1.10D, verified 2026-08-01
};

let lastBackup = null; // { index, payload } of the last pattern we overwrote

for (let i = 0; i < NUM_SLOTS; i++) $('wrSlot').add(new Option(`Pattern ${i + 1}`, i));
for (let i = 0; i < 128; i++) $('wrPattern').add(new Option(bankName(i), i));
for (let t = 0; t < 16; t++) $('wrTrack').add(new Option(`T${t + 1}`, t));

// Slot labels mirror the shared piano-roll state ("A01 T11", note counts).
function refreshWriteSlots() {
  const st = loadState();
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = st.patterns[i];
    $('wrSlot').options[i].text = `${p.name} · ${p.notes.length} note${p.notes.length === 1 ? '' : 's'}`;
  }
}
window.addEventListener('storage', e => { if (e.key === 'digiroll-v1') refreshWriteSlots(); });
refreshWriteSlots();

function syncWriteButtons() {
  const slug = device?.identity?.slug;
  const writable = !!DECODERS[slug]
    && WRITE_ALLOWED_BUILDS[slug]?.includes(device.identity.build);
  $('wrGo').disabled = !writable;
  $('wrRestore').disabled = !writable || !lastBackup;
  $('wrInfo').textContent = DECODERS[slug] && !writable
    ? `OS build ${device.identity.build} isn't write-verified yet — read-only`
    : '';
  syncCopyButtons();
}

function downloadPayloadBackup(index, payload) {
  const bytes = buildDumpMessage(device.identity.family, DUMP.PATTERN_KIT, index, payload);
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const name = `${device.identity.slug}-${bankName(index)}-backup-${stamp}.syx`;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

$('wrGo').onclick = async () => {
  if (!device) return;
  const slot = +$('wrSlot').value;
  const index = +$('wrPattern').value;
  const t = +$('wrTrack').value;
  const rollPattern = loadState().patterns[slot];

  $('wrGo').disabled = true;
  try {
    setStatus(`Fetching ${bankName(index)} for backup…`);
    const original = await device.fetchPatternKit(index);
    const target = DECODERS[device.identity.slug].decodePatternKit(original);
    const existing = trackTrigCount(target, t);

    const named = target.name ? ` “${target.name}”` : '';
    if (!confirm(
      `Write ${rollPattern.notes.length} notes from “${rollPattern.name}” to ${bankName(index)}${named} track ${t + 1} ` +
      `on the ${device.identity.name}?\n\n` +
      (existing ? `This replaces the ${existing} trig${existing === 1 ? '' : 's'} on that track. ` : 'That track is currently empty. ') +
      `A backup of the whole pattern downloads first.`
    )) { setStatus('Write cancelled'); return; }

    const backupName = downloadPayloadBackup(index, original);
    lastBackup = { index, payload: original };
    logNote(`Pre-write backup saved: ${backupName}`);

    const { payload, dropped } = DECODERS[device.identity.slug].encodeTrackNotes(original, t, rollPattern.notes);
    setStatus(`Writing ${bankName(index)} T${t + 1}…`);
    await device.sendPatternKit(index, payload);

    setStatus('Verifying — reading the pattern back…');
    const reread = await device.fetchPatternKit(index);
    const diffs = diffPayloads(payload, reread);
    if (diffs.length === 0) {
      setStatus(`✓ Wrote ${rollPattern.notes.length - dropped} notes to ${bankName(index)} T${t + 1} — verified byte-identical` +
        (dropped ? ` (${dropped} notes didn't fit and were dropped)` : ''));
      logNote(`Write verified: ${bankName(index)} T${t + 1}, ${rollPattern.notes.length - dropped} notes`);
    } else {
      setStatus(`⚠ Write verify FAILED for ${bankName(index)}: ${diffs.length}+ bytes differ — check the log, backup is ready to restore`, true);
      logError(`Verify mismatch (sent vs re-read): ` +
        diffs.slice(0, 16).map(d => `@${d.offset} ${d.sent?.toString(16)}→${d.read?.toString(16)}`).join('  '));
    }
  } catch (err) {
    setStatus(`Write failed: ${err.message}`, true);
    logError(`Write failed: ${err.message}`);
  } finally {
    syncWriteButtons();
  }
};

$('wrRestore').onclick = async () => {
  if (!device || !lastBackup) return;
  const { index, payload } = lastBackup;
  if (!confirm(`Restore the pre-write backup of ${bankName(index)}?`)) return;
  $('wrRestore').disabled = true;
  try {
    await device.sendPatternKit(index, payload);
    const reread = await device.fetchPatternKit(index);
    const ok = diffPayloads(payload, reread).length === 0;
    setStatus(ok ? `✓ ${bankName(index)} restored from backup — verified` : `⚠ Restore verify failed for ${bankName(index)} — check the log`, !ok);
    logNote(`Restore ${ok ? 'verified' : 'MISMATCH'}: ${bankName(index)}`);
  } catch (err) {
    setStatus(`Restore failed: ${err.message}`, true);
    logError(`Restore failed: ${err.message}`);
  } finally {
    syncWriteButtons();
  }
};

// --- Cross-device copy: any pattern's track → a track on the connected box --------
// Phase 4's pattern librarian. The piano-roll note model is the interchange
// format: decode the source with its own device spec, hand those notes to the
// target device's encoder (js/elektron/copy-track.js). There is no bytes-level
// DT2↔DN2 converter and there shouldn't be — the structs only look alike.
//
// The source is either a pattern on the connected box (copy between slots) or a
// .syx file, which is how you copy from the *other* box: back it up once, then
// copy tracks out of the file into whatever is plugged in. The target is always
// the connected box, and the write runs the same safe flow as everything else:
// re-fetch, backup, minimal-diff encode, read back, verify.

let copySource = null; // { patternKit, payload, mod, label, deviceName }

for (let i = 0; i < 128; i++) $('copySrcPattern').add(new Option(bankName(i), i));
for (let i = 0; i < 128; i++) $('copyDstPattern').add(new Option(bankName(i), i));
for (let t = 0; t < 16; t++) $('copyDstTrack').add(new Option(`T${t + 1}`, t));
queueMicrotask(syncCopyButtons); // once the whole module has evaluated

function syncCopyButtons() {
  const fromFile = $('copySrcWhere').value === 'file';
  const gate = writeGate(device?.identity);
  $('copySrcLoad').disabled = !fromFile && !DECODERS[device?.identity?.slug];
  $('copyGo').disabled = !copySource || !gate.ok;
  // Only the gate message is owned here — a chord-truncation warning from the
  // last copy must survive the button re-sync that follows it.
  if (copySource && !gate.ok) {
    $('copyInfo').textContent = `Can't copy into this box: ${gate.reason}`;
    $('copyInfo').classList.remove('warn');
  }
}

// `payload` comes along because the per-trig conditions live in per-step lanes
// that decodePatternKit doesn't surface — they are read from the raw bytes.
function setCopySource(patternKit, payload, mod, label, deviceName) {
  copySource = { patternKit, payload, mod, label, deviceName };
  $('copyInfo').textContent = '';
  $('copyInfo').classList.remove('warn');
  $('copySrcInfo').textContent = `${deviceName} · ${patternSummary(patternKit, label)}`;
  fillTrackOptions($('copySrcTrack'), patternKit, mod.SPEC.trackKindFallback, true);
  syncCopyButtons();
  setStatus(`Copy source: ${deviceName} ${label} — pick the track to copy`);
}

$('copySrcWhere').onchange = syncCopyButtons;

$('copySrcLoad').onclick = async () => {
  if ($('copySrcWhere').value === 'file') { $('copySrcFileInput').click(); return; }
  const decoder = DECODERS[device?.identity?.slug];
  if (!decoder) return;
  const index = +$('copySrcPattern').value;
  $('copySrcLoad').disabled = true;
  try {
    logNote(`Copy source: requesting pattern-kit ${bankName(index)}…`);
    const payload = await device.fetchPatternKit(index);
    setCopySource(decoder.decodePatternKit(payload), payload, decoder, bankName(index), device.identity.name);
  } catch (err) {
    setStatus(`Couldn't load copy source: ${err.message}`, true);
    logError(`Copy source fetch failed: ${err.message}`);
  } finally {
    syncCopyButtons();
  }
};

$('copySrcFileInput').onchange = async () => {
  const file = $('copySrcFileInput').files[0];
  if (!file) return;
  try {
    const kits = splitSysExStream(new Uint8Array(await file.arrayBuffer()))
      .filter(m => m.kind === 'dump' && DECODER_BY_FAMILY[m.family] && m.type === DUMP.PATTERN_KIT);
    if (!kits.length) throw new Error('no Digitakt II or Digitone II pattern-kit messages in this file');
    const wanted = +$('copySrcPattern').value;
    const msg = kits.find(m => m.index === wanted) ?? kits[0];
    if (!msg.checksumOk || !msg.countOk) throw new Error(`pattern ${bankName(msg.index)} is corrupt in this file`);
    const { mod, label } = DECODER_BY_FAMILY[msg.family];
    $('copySrcPattern').value = msg.index;
    setCopySource(mod.decodePatternKit(msg.payload), msg.payload, mod, bankName(msg.index), label);
  } catch (err) {
    setStatus(`Couldn't read ${file.name}: ${err.message}`, true);
    logError(`Copy source decode failed: ${err.message}`);
  }
  $('copySrcFileInput').value = '';
};

$('copyGo').onclick = async () => {
  if (!device || !copySource) return;
  const gate = writeGate(device.identity);
  if (!gate.ok) { setStatus(gate.reason, true); return; }
  const srcTrack = +$('copySrcTrack').value;
  const index = +$('copyDstPattern').value;
  const dstTrack = +$('copyDstTrack').value;
  const from = `${copySource.deviceName} ${copySource.label} T${srcTrack + 1}`;

  $('copyGo').disabled = true;
  try {
    // Chord policy first, so the user is told what won't fit *before* deciding.
    const { notes, drops } = trackNotesForTarget(copySource.mod, copySource.patternKit, srcTrack, gate.mod, copySource.payload);
    const chordWarnings = describeChordDrops(drops, device.identity.name);
    for (const w of chordWarnings) logError(`Chord truncated — ${w}`);

    // p-lock lanes travel too, translated by parameter name when the boxes
    // differ. Anything untranslatable is dropped and said out loud — before the
    // decision, like the chord policy above it.
    const { lanes, warnings: laneWarnings } = plockLanesForTarget(
      readTrackPLocks(copySource.mod.SPEC, copySource.payload, srcTrack),
      copySource.mod.SPEC.device, gate.mod.SPEC.device,
    );
    for (const w of laneWarnings) logError(`P-lock lane dropped — ${w}`);

    const warnings = [...chordWarnings, ...laneWarnings];
    if (warnings.length) {
      $('copyInfo').textContent = `${warnings.length} thing${warnings.length === 1 ? '' : 's'} didn't copy — see the log`;
      $('copyInfo').classList.add('warn');
    }

    const result = await safeWriteTrack(device, {
      index, trackIndex: dstTrack, notes,
      // The source track's PROB default is what its unlocked trigs run at, so
      // it travels with them rather than leaving them at the target's odds.
      trackProb: readTrackProb(copySource.mod.SPEC, copySource.payload, srcTrack),
      plocks: lanes,
      onStatus: setStatus,
      onLog: logNote,
      onBackup: b => downloadBytes(b.name, b.bytes),
      confirm: ({ label, existingTrigs, patternKit, boxPLocks }) => confirm(
        `Copy ${notes.length} note${notes.length === 1 ? '' : 's'} from ${from} to ` +
        `${label}${patternKit.name ? ` “${patternKit.name}”` : ''} track ${dstTrack + 1} on the ${device.identity.name}?\n\n` +
        (existingTrigs ? `This replaces the ${existingTrigs} trig${existingTrigs === 1 ? '' : 's'} on that track. ` : 'That track is currently empty. ') +
        'Notes, trig conditions and p-lock lanes are copied — sounds, kit and the pattern\'s own settings stay exactly as they are.\n' +
        (lanes.length ? `\n${lanes.length} p-lock lane${lanes.length === 1 ? '' : 's'} come${lanes.length === 1 ? 's' : ''} across.` : '') +
        (boxPLocks.length ? `\nThat track's ${boxPLocks.length} existing p-lock lane${boxPLocks.length === 1 ? '' : 's'} on the box will be cleared.` : '') +
        (warnings.length ? `\n\nWhat won't copy:\n${warnings.join('\n')}\n` : '') +
        '\nA backup of the whole pattern downloads first.'
      ),
    });

    if (result.backup) lastBackup = { index: result.backup.index, payload: result.backup.payload };
    const { text, isError } = writeResultMessage(result);
    setStatus(text, isError);
    if (isError) {
      logError('Verify mismatch (sent vs re-read): ' +
        result.diffs.slice(0, 16).map(d => `@${d.offset} ${d.sent?.toString(16)}→${d.read?.toString(16)}`).join('  '));
    } else if (!result.cancelled) {
      logNote(`Copy verified: ${from} → ${result.label} T${dstTrack + 1}, ${result.written} notes` +
        (lanes.length ? `, ${lanes.length} p-lock lane${lanes.length === 1 ? '' : 's'}` : '') +
        (warnings.length ? ` (${warnings.length} thing${warnings.length === 1 ? '' : 's'} didn't copy — see above)` : ''));
    }
  } catch (err) {
    setStatus(`Copy failed: ${err.message}`, true);
    logError(`Copy failed: ${err.message}`);
  } finally {
    syncWriteButtons();
  }
};

// --- Boot -----------------------------------------------------------------------

(async () => {
  if (!navigator.requestMIDIAccess) {
    setStatus('Web MIDI not supported — use Chrome, Edge, or Brave', true);
    return;
  }
  try {
    access = await navigator.requestMIDIAccess({ sysex: true });
  } catch {
    setStatus('MIDI + SysEx access denied — allow the permission and reload', true);
    return;
  }
  access.onstatechange = refreshPorts;
  refreshPorts();
  logNote('SysEx access granted. Pick your box and hit Connect.');
})();
