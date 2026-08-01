// Device console page: SysEx hex log + identity handshake + project backup.
//
// This page requests its own MIDI access with sysex enabled — the piano roll
// (index.html) deliberately stays on sysex-free access so it never triggers
// the scarier browser permission prompt.

import { ElektronDevice } from '../elektron/device.js';

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
  $('deviceInfo').textContent = '';
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
