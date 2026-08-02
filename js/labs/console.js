// Device console page: SysEx hex log + identity handshake + project backup.
//
// This page requests its own MIDI access with sysex enabled — the piano roll
// (index.html) deliberately stays on sysex-free access so it never triggers
// the scarier browser permission prompt.

import { ElektronDevice } from '../elektron/device.js';
import { splitSysExStream, buildDumpMessage, DUMP, FAMILY } from '../elektron/protocol.js';
import {
  decodePatternKit, trackNotes, trackTrigCount, bankName, encodeTrackNotes, diffPayloads,
} from '../elektron/dt2/pattern.js';
import { loadState, saveState, makeNote, NUM_SLOTS } from '../state.js';
import { PITCH_MIN, PITCH_MAX } from '../pianoroll.js';

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
      // Pattern decode only exists for the DT2 so far (Digitone II is Phase 3).
      $('impFetch').disabled = id.slug !== 'digitakt2';
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

let imported = null; // { patternKit, label } once something is decoded

for (let i = 0; i < 128; i++) $('impPattern').add(new Option(bankName(i), i));
for (let i = 0; i < NUM_SLOTS; i++) $('impSlot').add(new Option(`Pattern ${i + 1}`, i));

function showPatternKit(patternKit, label) {
  imported = { patternKit, label };
  const named = patternKit.name ? ` “${patternKit.name}”` : '';
  $('impPatternInfo').textContent =
    `${label}${named} · kit ${patternKit.kit.name || '—'} · ${patternKit.tempoBpm} BPM`;
  const trackSel = $('impTrack');
  trackSel.innerHTML = '';
  for (let t = 0; t < patternKit.tracks.length; t++) {
    const kind = patternKit.kit.midiMask & (1 << t) ? 'MIDI' : patternKit.kit.soundNames[t] || 'sample';
    const trigs = trackTrigCount(patternKit, t);
    trackSel.add(new Option(`T${t + 1} · ${kind} · ${trigs} trig${trigs === 1 ? '' : 's'}`, t));
    if (trigs === 0) trackSel.options[t].disabled = true;
  }
  const first = [...trackSel.options].find(o => !o.disabled);
  if (first) trackSel.value = first.value;
  trackSel.disabled = false;
  $('impGo').disabled = !first;
  if (!first) setStatus(`${label} decoded, but no track has any trigs`, true);
}

$('impFetch').onclick = async () => {
  if (!device) return;
  const index = +$('impPattern').value;
  $('impFetch').disabled = true;
  try {
    logNote(`Requesting pattern-kit ${bankName(index)}…`);
    const payload = await device.fetchPatternKit(index);
    showPatternKit(decodePatternKit(payload), bankName(index));
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
      .filter(m => m.kind === 'dump' && m.family === FAMILY.DIGITAKT_2 && m.type === DUMP.PATTERN_KIT);
    if (!kits.length) throw new Error('no Digitakt II pattern-kit messages in this file');
    const wanted = +$('impPattern').value;
    const msg = kits.find(m => m.index === wanted) ?? kits[0];
    if (!msg.checksumOk || !msg.countOk) throw new Error(`pattern ${bankName(msg.index)} is corrupt in this file`);
    $('impPattern').value = msg.index;
    showPatternKit(decodePatternKit(msg.payload), bankName(msg.index));
    setStatus(`Decoded ${bankName(msg.index)} from ${file.name} (${kits.length} pattern${kits.length > 1 ? 's' : ''} in file) — pick a track`);
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
  const lengthSteps = Math.min(128, Math.max(16, Math.ceil(track.lengthSteps / 16) * 16));
  const notes = trackNotes(imported.patternKit, t).filter(n => n.step < track.lengthSteps);

  const st = loadState(); // fresh — the piano-roll tab may have written since we loaded
  const p = st.patterns[slot];
  p.name = `${imported.label} T${t + 1}`;
  p.lengthSteps = lengthSteps;
  p.notes = notes.map(n => makeNote(
    n.step,
    Math.max(PITCH_MIN, Math.min(PITCH_MAX, n.pitch)),
    Math.max(1, Math.min(Math.round(n.lenSteps), lengthSteps - n.step)),
    n.velocity,
    n.micro,
  ));
  saveState(st);

  setStatus(`Imported ${notes.length} note${notes.length === 1 ? '' : 's'} from ${imported.label} T${t + 1} into Pattern ${slot + 1} — open the piano roll`);
  logNote(`Imported ${imported.label} T${t + 1} → piano-roll slot ${slot + 1} (${notes.length} notes)`);
};

// --- Write to box: piano-roll pattern → DT2 track --------------------------------
// The Phase 2 milestone. Safety rules from PLAN.md, enforced here:
//   1. the target pattern is fetched and downloaded as a backup before writing;
//   2. the encoder only touches the track's step words + the trig-record pool
//      (everything else round-trips byte-identical);
//   3. firmware allowlist — only OS builds the format was verified on;
//   4. verify-after-write: re-read, byte-compare, loud diff on mismatch.

// DT2 OS builds the pattern format has been verified against on real hardware.
const WRITE_ALLOWED_BUILDS = ['0070']; // 1.15B

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
  const writable = !!device && device.identity?.slug === 'digitakt2'
    && WRITE_ALLOWED_BUILDS.includes(device.identity.build);
  $('wrGo').disabled = !writable;
  $('wrRestore').disabled = !writable || !lastBackup;
  $('wrInfo').textContent = device && device.identity?.slug === 'digitakt2' && !writable
    ? `OS build ${device.identity.build} isn't write-verified yet — read-only`
    : '';
}

function downloadPayloadBackup(index, payload) {
  const bytes = buildDumpMessage(FAMILY.DIGITAKT_2, DUMP.PATTERN_KIT, index, payload);
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
  const name = `digitakt2-${bankName(index)}-backup-${stamp}.syx`;
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
    const target = decodePatternKit(original);
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

    const { payload, dropped } = encodeTrackNotes(original, t, rollPattern.notes);
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
