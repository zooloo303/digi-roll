// Dump diffing lab: the Phase 3 reverse-engineering workbench.
//
// The methodology that mapped the DT2 trig format and the whole DN2 pattern
// struct, automated: capture a pattern as a baseline, make exactly one edit
// on the box, capture again, and read the annotated byte diff. Bytes in
// regions the specs already understand get named ("trig-record pool, record
// #3, velocity"); bytes in unmapped regions stand out as `unknown` — those
// are the ones an experiment is trying to pin down. Findings accumulate in a
// lab notebook (localStorage) and export as Markdown for the docs/ format
// files.

import { ElektronDevice } from '../elektron/device.js';
import { bankName, diffAnnotatedRanges } from '../elektron/pattern-core.js';
import * as dt2 from '../elektron/dt2/pattern.js';
import * as dn2 from '../elektron/dn2/pattern.js';

const DESCRIBERS = {
  digitakt2: dt2.describeOffset,
  digitone2: dn2.describeOffset,
};

const $ = id => document.getElementById(id);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const hex2 = b => b.toString(16).padStart(2, '0');

function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
}

// --- MIDI + device (same pairing dance as the console page) --------------------

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
}

function syncButtons() {
  const connected = !!device?.identity?.supported;
  $('capA').disabled = !connected;
  $('capB').disabled = !connected || !baseline;
  $('labSave').disabled = !lastDiff;
  $('labChain').disabled = !lastCapture;
}

$('port').onchange = () => { device?.close(); device = null; baseline = null; lastCapture = null; lastDiff = null; $('deviceInfo').textContent = ''; syncButtons(); };

$('connect').onclick = async () => {
  const pair = listPairs().find(p => p.out.id === $('port').value);
  if (!pair) { setStatus('Pick a device first', true); return; }
  device?.close();
  device = new ElektronDevice(pair.in, pair.out);
  setStatus(`Asking ${pair.out.name} to identify itself…`);
  try {
    const id = await device.identify();
    $('deviceInfo').innerHTML = `<b>${esc(id.name)}</b>&nbsp; OS ${esc(id.version)} (build ${esc(id.build)})`;
    if (!id.supported) {
      setStatus(`${id.name} identified, but its dump family byte is unknown — the lab can't fetch from it yet`, true);
    } else {
      setStatus(`Connected to ${id.name} — capture a baseline${DESCRIBERS[id.slug] ? '' : ' (no struct map for this box yet: diffs will be raw offsets)'}`);
    }
  } catch (err) {
    setStatus(`No identity reply: ${err.message}`, true);
    device.close();
    device = null;
  }
  baseline = null; lastCapture = null; lastDiff = null;
  syncButtons();
};

// --- Capture + diff -------------------------------------------------------------

for (let i = 0; i < 128; i++) $('labPattern').add(new Option(bankName(i), i));

let baseline = null;    // { index, payload, label }
let lastCapture = null; // the most recent B capture
let lastDiff = null;    // { device, build, version, index, ranges }

async function capture() {
  const index = +$('labPattern').value;
  setStatus(`Fetching ${bankName(index)}…`);
  const payload = await device.fetchPatternKit(index);
  return { index, payload, at: new Date().toISOString() };
}

$('capA').onclick = async () => {
  try {
    baseline = await capture();
    lastCapture = null; lastDiff = null;
    $('captureInfo').textContent = `baseline: ${bankName(baseline.index)}, ${baseline.payload.length} bytes`;
    setStatus(`Baseline captured — now make ONE edit on the box, then “Capture + diff”`);
    $('diffPane').innerHTML = '<span class="dim">Baseline captured. Make one edit on the box…</span>';
  } catch (err) {
    setStatus(`Capture failed: ${err.message}`, true);
  }
  syncButtons();
};

function renderDiff(diff, a, b) {
  if (!diff.ranges.length) {
    $('diffPane').innerHTML = '<span class="dim">No differences — the edit didn\'t reach this pattern (or there was no edit).</span>';
    return;
  }
  const parts = [`<div class="region"><span class="label">${diff.ranges.length} changed region${diff.ranges.length > 1 ? 's' : ''}, ${diff.ranges.reduce((n, r) => n + r.end - r.start + 1, 0)} bytes</span></div>`];
  for (const r of diff.ranges) {
    const width = r.end - r.start + 1;
    const shown = Math.min(width, 64);
    const before = [...a.subarray(r.start, r.start + shown)].map(hex2).join(' ');
    const after = [...b.subarray(r.start, r.start + shown)].map(hex2).join(' ');
    parts.push(`<div class="region"><span class="label">[${r.start}..${r.end}] ${esc(r.label)}</span>\n` +
      `<span class="bytes">was <b>${before}</b>${width > shown ? ' …' : ''}\nnow <b>${after}</b>${width > shown ? ' …' : ''}</span></div>`);
  }
  $('diffPane').innerHTML = parts.join('');
}

$('capB').onclick = async () => {
  if (!baseline) return;
  try {
    const cap = await capture();
    if (cap.index !== baseline.index) throw new Error('pattern slot changed between captures');
    lastCapture = cap;
    const id = device.identity;
    lastDiff = {
      device: id.name, slug: id.slug, build: id.build, version: id.version,
      index: cap.index, at: cap.at,
      ranges: diffAnnotatedRanges(baseline.payload, cap.payload, DESCRIBERS[id.slug]),
      a: baseline.payload, b: cap.payload,
    };
    renderDiff(lastDiff, baseline.payload, cap.payload);
    setStatus(lastDiff.ranges.length
      ? `${lastDiff.ranges.length} region(s) changed — describe the edit and save it to the notebook`
      : 'No differences found');
  } catch (err) {
    setStatus(`Capture failed: ${err.message}`, true);
  }
  syncButtons();
};

$('labChain').onclick = () => {
  if (!lastCapture) return;
  baseline = lastCapture;
  lastCapture = null; lastDiff = null;
  $('captureInfo').textContent = `baseline: ${bankName(baseline.index)} (chained)`;
  $('diffPane').innerHTML = '<span class="dim">Chained: the last capture is the new baseline. Make the next edit…</span>';
  setStatus('Chained — make the next edit on the box');
  syncButtons();
};

// --- Notebook --------------------------------------------------------------------

const NOTEBOOK_KEY = 'digiroll-difflab-v1';
const loadNotebook = () => JSON.parse(localStorage.getItem(NOTEBOOK_KEY) ?? '[]');
const saveNotebook = nb => localStorage.setItem(NOTEBOOK_KEY, JSON.stringify(nb));

function renderNotebook() {
  const nb = loadNotebook();
  $('notebook').innerHTML = nb.length ? '' : '<span class="dim">No experiments saved yet.</span>';
  nb.forEach((e, i) => {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML =
      `<button data-del="${i}">✕</button>` +
      `<h3>${esc(e.note || '(unlabelled experiment)')}</h3>` +
      `<span class="meta">${esc(e.device)} OS ${esc(e.version)} (build ${esc(e.build)}) · ${bankName(e.index)} · ${esc(e.at.slice(0, 19).replace('T', ' '))}</span>` +
      `<ul>${e.ranges.map(r => `<li>[${r.start}..${r.end}] ${esc(r.label)}: <code>${esc(r.was)}</code> → <code>${esc(r.now)}</code></li>`).join('')}</ul>`;
    $('notebook').appendChild(div);
  });
  $('notebook').querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = () => {
      const nb2 = loadNotebook();
      nb2.splice(+btn.dataset.del, 1);
      saveNotebook(nb2);
      renderNotebook();
    };
  });
}

$('labSave').onclick = () => {
  if (!lastDiff) return;
  const nb = loadNotebook();
  nb.unshift({
    note: $('labNote').value.trim(),
    device: lastDiff.device, build: lastDiff.build, version: lastDiff.version,
    index: lastDiff.index, at: lastDiff.at,
    ranges: lastDiff.ranges.map(r => ({
      start: r.start, end: r.end, label: r.label,
      was: [...lastDiff.a.subarray(r.start, Math.min(r.end + 1, r.start + 16))].map(hex2).join(' ') + (r.end - r.start >= 16 ? ' …' : ''),
      now: [...lastDiff.b.subarray(r.start, Math.min(r.end + 1, r.start + 16))].map(hex2).join(' ') + (r.end - r.start >= 16 ? ' …' : ''),
    })),
  });
  saveNotebook(nb);
  $('labNote').value = '';
  setStatus('Saved to the notebook — chain the capture or start a fresh baseline');
  renderNotebook();
};

$('labExport').onclick = () => {
  const nb = loadNotebook();
  if (!nb.length) { setStatus('Nothing in the notebook yet', true); return; }
  const md = [
    '# Dump diffing lab notebook',
    '',
    ...nb.flatMap(e => [
      `## ${e.note || '(unlabelled experiment)'}`,
      '',
      `${e.device} OS ${e.version} (build ${e.build}), pattern ${bankName(e.index)}, ${e.at}`,
      '',
      ...e.ranges.map(r => `- \`[${r.start}..${r.end}]\` ${r.label}: \`${r.was}\` → \`${r.now}\``),
      '',
    ]),
  ].join('\n');
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `difflab-notebook-${new Date().toISOString().slice(0, 10)}.md` });
  a.click();
  URL.revokeObjectURL(url);
};

// --- Boot -------------------------------------------------------------------------

(async () => {
  renderNotebook();
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
  setStatus('Pick your box and hit Connect.');
})();
