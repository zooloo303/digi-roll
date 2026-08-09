// Device console page: SysEx hex log + identity handshake + project backup.
//
// This page requests its own MIDI access with sysex enabled — the piano roll
// (index.html) deliberately stays on sysex-free access so it never triggers
// the scarier browser permission prompt.

import { ElektronDevice } from '../elektron/device.js';
import { splitSysExStream, DUMP, FAMILY } from '../elektron/protocol.js';
import { trackNotes, trackTrigCount, bankName } from '../elektron/pattern-core.js';
import * as dt2 from '../elektron/dt2/pattern.js';
import * as dn2 from '../elektron/dn2/pattern.js';

// DECODERS (which boxes we can decode) comes from safe-write.js with the rest
// of the write flow; writing keeps its separate, stricter allowlist gate.
const DECODER_BY_FAMILY = {
  [FAMILY.DIGITAKT_2]: { mod: dt2, label: 'Digitakt II' },
  [FAMILY.DIGITONE_2]: { mod: dn2, label: 'Digitone II' },
};
import { loadState, saveState, NUM_SLOTS } from '../state.js';
import {
  deviceNotesToRoll, rollNotesToDevice, rollLengthForTrack, makeSource, attachTrigSettings,
  devicePLocksToRoll, rollPLocksToDevice,
} from '../roll-bridge.js';
import { readTrackTrigSettings, readTrackProb } from '../elektron/trig-cond.js';
import { readTrackPLocks } from '../elektron/plocks.js';
import { readSwing, SWING_MIN } from '../elektron/pattern-settings.js';
import {
  DECODERS, PRODUCT_BY_FAMILY, writeGate, safeWriteTrack, safeRestorePatternKit,
  writeResultMessage, writeImpactLines, patternKitFile, BACKUP_LINE,
} from '../elektron/safe-write.js';
import { stashedBackups } from '../elektron/backup-stash.js';
import { trackNotesForTarget, describeChordDrops, plockLanesForTarget } from '../elektron/copy-track.js';
import { downloadBytes } from '../download.js';
import { copyHintHtml } from './copy-hint.js';

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
// `identity` ({ slug, family, patternIndex }) is what "Save .syx" needs to wrap
// the payload back up as a message the box would accept — a file-decoded pattern
// has no handshake to ask, so it comes from the dump's own family byte.
function showPatternKit({
  patternKit, payload, spec, label, identity, kindFallback = 'sample', origin = null,
}) {
  imported = { patternKit, payload, spec, label, identity, origin };
  $('impPatternInfo').textContent = patternSummary(patternKit, label);
  const any = fillTrackOptions($('impTrack'), patternKit, kindFallback);
  $('impGo').disabled = !any;
  // Saving works whether or not a track has trigs — an empty pattern is still
  // worth keeping a copy of before you overwrite it.
  $('impSave').disabled = false;
  if (!any) setStatus(`${label} decoded, but no track has any trigs`, true);
}

// Save just this pattern as .syx. The whole-project backup is the safety net;
// this is the one you can hand to the *other* box's copy-source picker, and the
// one that makes a single slot restorable without replaying a whole project.
$('impSave').onclick = () => {
  if (!imported) return;
  const { slug, family, patternIndex } = imported.identity;
  const file = patternKitFile({ slug, family }, patternIndex, imported.payload, { kind: 'pattern' });
  downloadBytes(file.name, file.bytes);
  setStatus(`Saved ${imported.label} as ${file.name} (${file.bytes.length} bytes)`);
  logNote(`Saved single pattern: ${file.name}`);
};

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
      identity: { slug: device.identity.slug, family: device.identity.family, patternIndex: index },
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
      identity: { slug: product.slug, family: msg.family, patternIndex: msg.index },
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

// --- Write to box: piano-roll pattern → device track -----------------------------
// This row runs `safeWriteTrack`, the same flow as the piano roll's own "Send to
// box" and as cross-device copy below. It used to have its own inline copy of the
// sequence — the original Phase 2 implementation — which meant it wrote *only*
// notes: trig conditions, track PROB, p-lock lanes and swing were all silently
// dropped, so the same slot sent from the roll and sent from here landed
// differently. One flow, one set of surfaces, one confirm wording.

let lastBackup = null; // { index, payload, name } of the last pattern we overwrote

// What Restore would send: this session's last pre-write backup, or — after a
// reload, or a backup download that never reached disk — the newest backup
// stashed in the browser for the connected box (any page's writes land there).
function restoreCandidate() {
  if (lastBackup) return lastBackup;
  const slug = device?.identity?.slug;
  return slug ? stashedBackups(slug)[0] ?? null : null;
}

for (let i = 0; i < NUM_SLOTS; i++) $('wrSlot').add(new Option(`Pattern ${i + 1}`, i));
for (let i = 0; i < 128; i++) $('wrPattern').add(new Option(bankName(i), i));
for (let t = 0; t < 16; t++) $('wrTrack').add(new Option(`T${t + 1}`, t));

// Slot labels mirror the shared piano-roll state ("A01 T11", note counts) and
// name the p-lock lanes too, since this row now carries them.
function refreshWriteSlots() {
  const st = loadState();
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = st.patterns[i];
    const lanes = p.plocks?.length ?? 0;
    $('wrSlot').options[i].text = `${p.name} · ${p.notes.length} note${p.notes.length === 1 ? '' : 's'}`
      + (lanes ? ` · ${lanes} lane${lanes === 1 ? '' : 's'}` : '');
  }
}
window.addEventListener('storage', e => { if (e.key === 'digiroll-v1') refreshWriteSlots(); });
refreshWriteSlots();

function syncWriteButtons() {
  const gate = writeGate(device?.identity);
  $('wrGo').disabled = !gate.ok;
  $('wrRestore').disabled = !gate.ok || !restoreCandidate();
  // Only worth saying when we can decode the box but not write to it: "no device
  // connected" is already obvious from the toolbar.
  $('wrInfo').textContent = gate.mod && !gate.ok ? gate.reason : '';
  syncCopyButtons();
}

$('wrGo').onclick = async () => {
  if (!device) return;
  const slot = +$('wrSlot').value;
  const index = +$('wrPattern').value;
  const t = +$('wrTrack').value;
  const p = loadState().patterns[slot];
  const gate = writeGate(device.identity);
  if (!gate.ok) { setStatus(gate.reason, true); return; }

  $('wrGo').disabled = true;
  try {
    // Lanes belonging to the other box's parameter numbering can't be written
    // here — this row writes a roll slot as-is, and translating across devices is
    // the Copy track row's job. Reported rather than aimed at a guess.
    const { lanes, warnings: laneWarnings } = rollPLocksToDevice(p.plocks, gate.mod.SPEC.device);
    for (const w of laneWarnings) logError(`P-lock lane not written — ${w}`);

    const result = await safeWriteTrack(device, {
      index, trackIndex: t, notes: rollNotesToDevice(p.notes),
      trackProb: p.trackProb ?? 100,
      plocks: lanes,
      swing: p.swing ?? SWING_MIN,
      onStatus: setStatus,
      onLog: logNote,
      onBackup: b => downloadBytes(b.name, b.bytes),
      confirm: ({ label, existingTrigs, patternKit, swing: boxSwing, boxPLocks, freeLanes }) => {
        const lines = [
          `Write ${p.notes.length} note${p.notes.length === 1 ? '' : 's'} from “${p.name}” to `
          + `${label}${patternKit.name ? ` “${patternKit.name}”` : ''} track ${t + 1} on the ${device.identity.name}?`,
          '',
          existingTrigs
            ? `This replaces the ${existingTrigs} trig${existingTrigs === 1 ? '' : 's'} on that track.`
            : 'That track is currently empty.',
          ...writeImpactLines({
            label, trackIndex: t, lanes, boxPLocks, freeLanes,
            trackProb: p.trackProb ?? 100, swing: p.swing ?? SWING_MIN, boxSwing,
          }),
        ];
        for (const w of laneWarnings) lines.push(`Note: ${w}`);
        lines.push('', BACKUP_LINE);
        return confirm(lines.join('\n'));
      },
    });

    if (result.backup) lastBackup = { index: result.backup.index, payload: result.backup.payload, name: result.backup.name };
    const { text, isError } = writeResultMessage({
      ...result, warnings: [...(result.warnings ?? []), ...(result.cancelled ? [] : laneWarnings)],
    });
    setStatus(text, isError);
    // `isError` also covers "wrote it, but not all of it" — a lane that didn't
    // fit — so the byte-level report is gated on there actually being diffs.
    if (result.diffs.length) {
      logError('Verify mismatch (sent vs re-read): '
        + result.diffs.slice(0, 16).map(d => `@${d.offset} ${d.sent?.toString(16)}→${d.read?.toString(16)}`).join('  '));
    } else if (!result.cancelled) {
      logNote(`Write ${isError ? 'verified with warnings' : 'verified'}: ${result.label} T${t + 1}, `
        + `${result.written} note${result.written === 1 ? '' : 's'}`
        + (lanes.length ? `, ${lanes.length} p-lock lane${lanes.length === 1 ? '' : 's'}` : ''));
    }
  } catch (err) {
    setStatus(`Write failed: ${err.message}`, true);
    logError(`Write failed: ${err.message}`);
  } finally {
    syncWriteButtons();
  }
};

$('wrRestore').onclick = async () => {
  const entry = restoreCandidate();
  if (!device || !entry) return;
  $('wrRestore').disabled = true;
  try {
    // safe-write's restore flow: allowlist gate at send time, the slot's
    // current contents backed up first (it may be the evidence of what went
    // wrong), then send and byte-compare — not a bare sendPatternKit.
    const result = await safeRestorePatternKit(device, {
      index: entry.index,
      payload: entry.payload,
      onBackup: b => downloadBytes(b.name, b.bytes),
      onStatus: setStatus,
      onLog: logNote,
      confirm: ({ label }) => confirm(
        `Restore ${label} from ${entry.name ?? 'the pre-write backup'}`
        + (entry.at ? ` (stashed ${entry.at.slice(0, 19).replace('T', ' ')})` : '')
        + '?\n\nWhat the slot holds right now downloads first.'),
    });
    if (result.cancelled) {
      setStatus('Restore cancelled');
    } else {
      setStatus(result.ok
        ? `✓ ${result.label} restored from backup — verified`
        : `⚠ Restore verify failed for ${result.label} — check the log`, !result.ok);
      logNote(`Restore ${result.ok ? 'verified' : 'MISMATCH'}: ${result.label}`);
    }
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
  $('copySrcSave').disabled = !copySource;
  $('copyGo').disabled = !copySource || !gate.ok;
  // The destination is always the connected box — there is no target picker, and
  // that used to be invisible: the Connect button *is* the target selector. So
  // the row names whatever is plugged in, and says so when nothing is.
  $('copyDstBox').textContent = device?.identity?.name ?? 'no box connected';
  $('copyDstBox').classList.toggle('warn', !device?.identity);
  // Only the gate message is owned here — a chord-truncation warning from the
  // last copy must survive the button re-sync that follows it. "No box" isn't
  // worth saying: the destination label a few pixels away already says it.
  if (copySource && !gate.ok && device?.identity) {
    $('copyInfo').textContent = `Can't copy into this box: ${gate.reason}`;
    $('copyInfo').classList.remove('warn');
  }
  syncCopyHint();
}

// The hint under the row, from `copy-hint.js` — the state it describes lives
// here, the wording lives there where it can be tested.
function syncCopyHint() {
  const targetName = device?.identity?.name ?? null;
  $('copyHint').innerHTML = copyHintHtml({
    source: copySource,
    targetName,
    // Module identity: a source loaded off a DN2 and a connected DT2 resolve to
    // different pattern modules, which is exactly when lanes get translated.
    crossing: !!copySource && !!targetName && copySource.mod !== DECODERS[device.identity.slug],
  });
}

// `payload` comes along because the per-trig conditions live in per-step lanes
// that decodePatternKit doesn't surface — they are read from the raw bytes.
// `identity` ({ slug, family }) is what Save .syx needs to re-wrap the payload.
function setCopySource(patternKit, payload, mod, label, deviceName, identity, index) {
  copySource = { patternKit, payload, mod, label, deviceName, identity, index };
  $('copyInfo').textContent = '';
  $('copyInfo').classList.remove('warn');
  $('copySrcInfo').textContent = `${deviceName} · ${patternSummary(patternKit, label)}`;
  fillTrackOptions($('copySrcTrack'), patternKit, mod.SPEC.trackKindFallback, true);
  syncCopyButtons();
  setStatus(`Copy source: ${deviceName} ${label} — held in memory, so you can switch boxes before copying`);
}

// Save the held source, for the copy you'll want next week rather than next
// minute. In the row that has the source, so the flow never sends you to the
// import bar for a file.
$('copySrcSave').onclick = () => {
  if (!copySource) return;
  const file = patternKitFile(copySource.identity, copySource.index, copySource.payload, { kind: 'pattern' });
  downloadBytes(file.name, file.bytes);
  setStatus(`Saved copy source ${copySource.label} as ${file.name}`);
  logNote(`Saved copy source: ${file.name}`);
};

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
    setCopySource(
      decoder.decodePatternKit(payload), payload, decoder, bankName(index), device.identity.name,
      { slug: device.identity.slug, family: device.identity.family }, index,
    );
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
    setCopySource(
      mod.decodePatternKit(msg.payload), msg.payload, mod, bankName(msg.index), label,
      { slug: PRODUCT_BY_FAMILY[msg.family].slug, family: msg.family }, msg.index,
    );
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

    // The source track's PROB default is what its unlocked trigs run at, so it
    // travels with them rather than leaving them at the target's odds.
    const srcProb = readTrackProb(copySource.mod.SPEC, copySource.payload, srcTrack);

    const result = await safeWriteTrack(device, {
      index, trackIndex: dstTrack, notes,
      trackProb: srcProb,
      plocks: lanes,
      // Swing belongs to the whole destination pattern, not the track being
      // copied into it, so a track copy deliberately leaves the box's own feel
      // alone — hence no `swing` here and none in the confirm text.
      onStatus: setStatus,
      onLog: logNote,
      onBackup: b => downloadBytes(b.name, b.bytes),
      confirm: ({ label, existingTrigs, patternKit, boxPLocks, freeLanes }) => {
        const lines = [
          `Copy ${notes.length} note${notes.length === 1 ? '' : 's'} from ${from} to `
          + `${label}${patternKit.name ? ` “${patternKit.name}”` : ''} track ${dstTrack + 1} on the ${device.identity.name}?`,
          '',
          existingTrigs
            ? `This replaces the ${existingTrigs} trig${existingTrigs === 1 ? '' : 's'} on that track.`
            : 'That track is currently empty.',
          'Notes, trig conditions and p-lock lanes are copied — sounds, kit and the '
          + 'pattern\'s own settings (including its swing) stay exactly as they are.',
          ...writeImpactLines({
            label, trackIndex: dstTrack, lanes, boxPLocks, freeLanes, trackProb: srcProb,
          }),
        ];
        if (warnings.length) lines.push('', 'What won\'t copy:', ...warnings);
        lines.push('', BACKUP_LINE);
        return confirm(lines.join('\n'));
      },
    });

    if (result.backup) lastBackup = { index: result.backup.index, payload: result.backup.payload, name: result.backup.name };
    const { text, isError } = writeResultMessage(result);
    setStatus(text, isError);
    // Same gate as the write row: a warning can raise `isError` with nothing
    // having mismatched.
    if (result.diffs.length) {
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
