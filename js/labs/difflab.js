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

import { identifyWithConnectionHelp } from '../midi-connection-help.js';
import { ElektronDevice } from '../elektron/device.js';
import { bankName, diffAnnotatedRanges } from '../elektron/pattern-core.js';
import { readAllPLocks } from '../elektron/plocks.js';
import { PRODUCT_BY_FAMILY } from '../elektron/safe-write.js';
import { downloadText } from '../download.js';
import {
  sweepPlan, deepPlan, summarizeFindings, contributorReport, requestTypesFor, defaultRequestFor,
  objectName,
} from './probe.js';
import { buildCapturePair, parseCapturePair } from './capture-pair.js';
import { plainDiffSummary } from './guide.js';
import { captureIdentity } from './capture-identity.js';
import { experimentPanel } from './experiment-panel.js';
import { describerFor } from './describers.js';
import * as dt2 from '../elektron/dt2/pattern.js';
import * as dn2 from '../elektron/dn2/pattern.js';

// Specs, for the readouts that need to know the struct rather than just how to
// name an offset — the p-lock lane report below.
const SPECS = {
  digitakt2: dt2.SPEC,
  digitone2: dn2.SPEC,
};

// Struct knowledge is keyed off what was actually captured — the family byte
// and request type — not off the connected box, so a donated capture pair from
// a DT2 gets the full annotation with no box attached, and a probe-discovered
// dump from an unmapped box gets honest raw offsets instead of the wrong map.
const slugForFamily = family => PRODUCT_BY_FAMILY[family]?.slug ?? null;
const specFor = (family, requestType) =>
  (requestType === 0x60 ? SPECS[slugForFamily(family)] ?? null : null);

const $ = id => document.getElementById(id);
// Tolerant of anything: notebook entries and imported donations are user data,
// and an undefined reaching a bare .replace() here once kept the whole page
// from booting.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
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

// What a capture will fetch: family byte + request type, editable so a box the
// code has never met can be captured the moment a probe finds its family byte.
// For a known box these fill themselves from the identity and nothing changes.
// 0x10 is refused — a message with that family byte parses as API traffic, not
// a dump, so nothing useful can ever be captured with it.
function captureTarget() {
  const family = parseInt($('labFamily').value, 16);
  const requestType = +$('labType').value;
  if (!Number.isInteger(family) || family < 0x01 || family > 0x7f || family === 0x10) return null;
  if (!requestTypesFor(family)[requestType]) return null;
  return { family, requestType };
}

// The request menu is rebuilt whenever the family byte changes, because an
// opcode does not mean the same thing on every box: 0x64 fetches project
// settings from a Digitakt II and *the pattern* from an Analog Four. Offering
// one generation's names for the other's box is how a contributor's first
// experiment teaches them something false — the same rule `describerFor`
// follows for struct annotation. A family we have never met gets bare
// "request 0x6n" labels and the full 0x60–0x6e range to try.
function refreshTypeMenu() {
  const sel = $('labType');
  const family = parseInt($('labFamily').value, 16);
  const types = requestTypesFor(family);
  const prev = +sel.value;
  sel.innerHTML = '';
  for (const [type, label] of Object.entries(types)) {
    sel.add(new Option(`0x${(+type).toString(16)} ${label}`, type));
  }
  // Keep the selection across a family change when the new box serves that
  // opcode too; otherwise fall back to whatever it does serve first.
  sel.value = types[prev] ? String(prev) : sel.options[0]?.value ?? '';
}

function syncButtons() {
  const connected = !!device;
  const target = captureTarget();
  $('labProbe').disabled = busy || !connected || (guided && !!baseline);
  $('capA').disabled = busy || !connected || !target || (guided && !experiments.canBaseline());
  $('capB').disabled = busy || !connected || !baseline || (guided && !experiments.canAfter());
  $('labSave').disabled = busy || !lastDiff;
  $('labChain').disabled = busy || !lastCapture || !connected || !!lastDiff?.fromFile;
  // A pair is exportable once both sides exist and came off a box in this
  // session — re-exporting an imported file would only launder its metadata.
  $('labExportPair').disabled = busy || !(baseline && lastCapture && lastDiff && !lastDiff.fromFile);
  for (const id of ['connect', 'port', 'guideToggle', 'labImportPair']) $(id).disabled = busy;
  for (const id of ['labPattern', 'labFamily', 'labType']) $(id).disabled = busy || (guided && !!baseline);
  renderGuide();
}

$('labFamily').oninput = () => { refreshTypeMenu(); syncButtons(); };
$('labType').onchange = syncButtons;

// --- Guided mode -------------------------------------------------------------------
//
// Two audiences, one page. The controls are named for the protocol because that
// is what the mapping work needs, and a contributor with a Syntakt reads
// "family (hex)" as a form field they can't fill. Guided mode hides everything
// the contributor path doesn't touch (`.expert` in difflab.html) and replaces the
// one-line hint with a step panel that says one thing at a time.
//
// Guided mode also enforces an explicit before/after/save/next cycle. Hidden
// target controls retain the probe selection; both modes use the same read-only
// device methods and preserve the complete received messages.

// Guided by default: a first-time contributor is the whole reason this page is
// public, and a returning developer flips it once and is remembered.
const GUIDE_KEY = 'digiroll-difflab-guided-v1';
let guided = localStorage.getItem(GUIDE_KEY) !== 'off';
let busy = false;

function renderGuide() {
  $('guideToggle').textContent = guided ? 'Show all controls' : 'Guided mode';
  document.body.classList.toggle('guided', guided);
  experiments.render();
}

$('guideToggle').onclick = () => {
  guided = !guided;
  localStorage.setItem(GUIDE_KEY, guided ? 'on' : 'off');
  experiments.reset();
  setStatus('Mode changed — saved session pairs are retained; start with a fresh baseline.');
};

// Notes are optional except for custom experiments; structured values carry
// the required before/after evidence in guided mode.
$('labNote').oninput = syncButtons;

$('port').onchange = () => { device?.close(); device = null; experiments.reset(); $('deviceInfo').textContent = ''; syncButtons(); };

$('connect').onclick = async () => {
  const pair = listPairs().find(p => p.out.id === $('port').value);
  if (!pair) { setStatus('Pick a device first', true); return; }
  device?.close();
  device = new ElektronDevice(pair.in, pair.out);
  $('labFamily').value = ''; refreshTypeMenu();
  $('deviceInfo').textContent = '';
  setStatus(`Asking ${pair.out.name} to identify itself…`);
  try {
    const id = await identifyWithConnectionHelp(device);
    $('deviceInfo').innerHTML = `<b>${esc(id.name)}</b>&nbsp; OS ${esc(id.version)} (build ${esc(id.build)})`;
    // The capture target follows the identity when we have one; for an unknown
    // box it stays blank until the probe (or the user) supplies a family byte.
    $('labFamily').value = id.family != null ? id.family.toString(16).padStart(2, '0') : '';
    refreshTypeMenu();
    // The pattern request, in this box's dialect — 0x60 on the digis, 0x64 on
    // an Analog Four.
    $('labType').value = String(defaultRequestFor(id.family));
    if (!id.supported) {
      setStatus(`${id.name} identified, but its dump family byte is unknown — hit “Probe dump protocol” to look for one (read-only)`, true);
    } else {
      setStatus(`Connected to ${id.name} — choose a scratch pattern and capture a baseline`);
    }
  } catch (err) {
    // Identity and dump reads are independent. Keep the selected transport so
    // the contributor can probe even when the identity API stays silent.
    $('deviceInfo').textContent = 'MIDI port selected · identity and firmware unavailable';
    setStatus(`${pair.out.name} did not identify itself (${err.message}). `
      + 'The MIDI port is still selected. Click “Probe dump protocol” to check for read-only dump replies. '
      + 'If that is silent too, check the box’s USB/MIDI routing and retry.', true);
  }
  experiments.reset();
  syncButtons();
};

// --- Capture + diff -------------------------------------------------------------

for (let i = 0; i < 128; i++) $('labPattern').add(new Option(bankName(i), i));

let baseline = null;    // { index, payload, raw, family, requestType, at }
let lastCapture = null; // the most recent B capture, same shape
let lastDiff = null;    // { device, build, version, index, ranges, … }

const experiments = experimentPanel({
  getState: () => ({ connected: !!device, identity: device ? captureIdentity(device) : null, exported: !!lastDiff?.exported, target: !!captureTarget(), busy, guided,
    hasBaseline: !!baseline, hasDiff: !!lastDiff, fromFile: !!lastDiff?.fromFile }),
  resetCapture: () => {
    baseline = null; lastCapture = null; lastDiff = null;
    $('captureInfo').textContent = '';
    $('diffPane').textContent = 'Prepare the next experiment, then capture a fresh before snapshot.';
  },
  pairText: note => buildCapturePair({
    device: baseline.identity, family: baseline.family, requestType: baseline.requestType,
    index: baseline.index, note, capturedAt: lastCapture.at,
    baselineRaw: baseline.raw, afterRaw: lastCapture.raw,
  }),
  status: setStatus, sync: syncButtons,
});

// "family 0x1a · request 0x61" for anything that isn't a mapped box's
// pattern-kit — the notebook and the export need to say what was captured,
// because for a new box that *is* the finding.
function targetLabel(family, requestType) {
  if (describerFor(family, requestType)) return null;
  const object = objectName(family, requestType);
  return `family 0x${family.toString(16).padStart(2, '0')} · request 0x${requestType.toString(16)}`
    + (object ? ` (${object})` : '');
}

// Fetch through the capture target. The target is pinned per experiment: a
// baseline remembers what it was fetched with, and B reuses that rather than
// the UI fields — otherwise editing the target mid-experiment would diff two
// different structs and call the whole file a change.
async function capture(target) {
  const asked = target.index ?? +$('labPattern').value;
  setStatus(`Fetching ${bankName(asked)} (family 0x${target.family.toString(16)}, request 0x${target.requestType.toString(16)})…`);
  const { payload, raw, msg } = await device.fetchDump(target.family, target.requestType, asked);
  // Record the slot the box *answered* with. A working-state request ignores
  // the index you send and reports the loaded slot instead (the Analog Four's
  // 0x68/0x6a/0x6b/0x6c/0x6d do), and that answer is a finding: it is how you
  // know which slot the edit you are about to make will land in.
  return { index: msg.index, asked, payload, raw, family: target.family, requestType: target.requestType, identity: { ...captureIdentity(device) }, at: new Date().toISOString() };
}

$('capA').onclick = async () => {
  const target = captureTarget();
  if (!target || (guided && !experiments.canBaseline())) return;
  try {
    baseline = await capture(target);
    if (guided) experiments.beforeCaptured();
    lastCapture = null; lastDiff = null;
    $('captureInfo').textContent = `baseline: ${bankName(baseline.index)}, ${baseline.payload.length} bytes`
      + (baseline.index !== baseline.asked ? ` (the box answered with its loaded slot, not ${bankName(baseline.asked)})` : '');
    setStatus(`Baseline captured — now make ONE edit on the box, then “Capture + diff”`);
    $('diffPane').innerHTML = '<span class="dim">Baseline captured. Make one edit on the box…</span>';
  } catch (err) {
    setStatus(`Capture failed: ${err.message}`, true);
  }
  syncButtons();
};

// --- P-lock lane report ----------------------------------------------------------
//
// The 80-lane p-lock pool is 20,640 bytes of uint16 words, so a raw byte diff of
// it is unreadable — "[68100..68359] p-lock lane 0" tells you a lane changed and
// nothing about what. This reads the pool as *lanes* on both sides and says what
// happened in the terms the experiment is asking about: which lane got claimed,
// what paramId and track it holds, and which steps hold which value words.
//
// That is exactly the readout PLAN.md's Phase 0 needs. What it cannot do is tell
// you what a paramId *means* — that comes from you knowing which knob you just
// turned, which is why the experiments are one edit at a time. Write the answer
// into js/elektron/dt2/params.js or dn2/params.js and the lane stops being
// read-only everywhere else in digi-roll.

const laneKey = l => `${l.paramId}:${l.track}`;

// Steps whose value word differs between two lanes, as { step, was, now }.
function laneValueChanges(before, after) {
  const out = [];
  const n = Math.max(before?.values.length ?? 0, after?.values.length ?? 0);
  for (let step = 0; step < n; step++) {
    const was = before?.values[step] ?? null;
    const now = after?.values[step] ?? null;
    if (was !== now) out.push({ step, was, now });
  }
  return out;
}

const word = v => (v == null ? '—' : `0x${v.toString(16).padStart(4, '0')} (${v})`);

// A lane's non-empty steps, short enough to read at a glance.
function laneSummary(lane) {
  const set = lane.values.flatMap((v, step) => (v == null ? [] : [`${step + 1}:${word(v)}`]));
  return set.length ? set.slice(0, 12).join(', ') + (set.length > 12 ? ` … (${set.length} steps)` : '') : 'no values';
}

// Compare the pools of two payloads. Returns null when the box has no spec here
// (nothing to read the pool with) or when nothing about the pool changed.
export function plockReport(spec, a, b) {
  if (!spec) return null;
  const before = readAllPLocks(spec, a);
  const after = readAllPLocks(spec, b);
  const byLaneBefore = new Map(before.map(l => [l.lane, l]));
  const byLaneAfter = new Map(after.map(l => [l.lane, l]));

  const lines = [];
  for (let lane = 0; lane < spec.pattern.numPLocks; lane++) {
    const wasLane = byLaneBefore.get(lane);
    const nowLane = byLaneAfter.get(lane);
    if (!wasLane && !nowLane) continue;

    if (!wasLane) {
      lines.push({ kind: 'new', lane, text:
        `lane ${lane} <b>allocated</b>: paramId <code>0x${nowLane.paramId.toString(16).padStart(2, '0')}</code> `
        + `(${nowLane.paramId}), track ${nowLane.track + 1} — ${laneSummary(nowLane)}` });
      continue;
    }
    if (!nowLane) {
      lines.push({ kind: 'gone', lane, text:
        `lane ${lane} <b>freed</b>: was paramId <code>0x${wasLane.paramId.toString(16).padStart(2, '0')}</code>, `
        + `track ${wasLane.track + 1}` });
      continue;
    }
    const header = wasLane.paramId !== nowLane.paramId || wasLane.track !== nowLane.track
      ? ` — header changed: paramId 0x${wasLane.paramId.toString(16)}→0x${nowLane.paramId.toString(16)}, `
        + `track ${wasLane.track + 1}→${nowLane.track + 1}`
      : '';
    const changes = laneValueChanges(wasLane, nowLane);
    if (!header && !changes.length) continue;
    lines.push({ kind: 'changed', lane, text:
      `lane ${lane} (paramId <code>0x${nowLane.paramId.toString(16).padStart(2, '0')}</code>, track ${nowLane.track + 1})${header}`
      + (changes.length
        ? `: ${changes.slice(0, 16).map(c => `step ${c.step + 1} ${word(c.was)} → ${word(c.now)}`).join(', ')}`
          + (changes.length > 16 ? ` … (${changes.length} steps)` : '')
        : '') });
  }

  return {
    changed: lines,
    // Standing state, so a capture with no p-lock change still says what the
    // pool holds — "nothing was allocated" is itself a finding, and it is the one
    // the conditions experiments recorded.
    lanesBefore: before.map(l => ({ lane: l.lane, key: laneKey(l), text: `lane ${l.lane}: paramId 0x${l.paramId.toString(16)}, track ${l.track + 1} — ${laneSummary(l)}` })),
    lanesAfter: after.map(l => ({ lane: l.lane, key: laneKey(l), text: `lane ${l.lane}: paramId 0x${l.paramId.toString(16)}, track ${l.track + 1} — ${laneSummary(l)}` })),
    free: spec.pattern.numPLocks - after.length,
  };
}

function renderPLockReport(report) {
  if (!report) return '';
  const body = report.changed.length
    ? `<ul>${report.changed.map(l => `<li class="${l.kind}">${l.text}</li>`).join('')}</ul>`
    : report.lanesAfter.length
      ? `<ul><li>No lane changed. The pool currently holds:</li>${report.lanesAfter.map(l => `<li>${l.text}</li>`).join('')}</ul>`
      : '<ul><li>No lane changed, and the pool is completely empty — whatever you edited, '
        + 'the box did not use a p-lock lane for it.</li></ul>';
  return `<div class="plockReport"><h4>P-lock lanes — ${report.free} of `
    + `${report.free + report.lanesAfter.length} free</h4>${body}</div>`;
}

function renderDiff(diff, a, b) {
  // The lane report goes above the byte ranges even when nothing else changed:
  // on a p-lock experiment it is the answer and the ranges are the working. It
  // is also a readout for whoever is mapping the pool, so guided mode drops it —
  // "paramId 0x3f, track 1" is precisely the vocabulary the panel exists to keep
  // out of a contributor's way, and hiding it costs nothing, because it is
  // display only: the lane findings still reach the notebook and the exported
  // pair either way.
  const plocks = guided || !$('labPLocks').checked ? '' : renderPLockReport(diff.plocks);
  // In guided mode the hex gets a plain-language header, because the moment a
  // contributor's first capture lands the screen fills with bytes and the
  // reasonable conclusion is that they've done something wrong. They haven't,
  // and they don't need to read any of it — the export carries it all.
  const plain = guided
    ? `<div class="plainSummary">${plainDiffSummary({
        regions: diff.ranges.length,
        bytes: diff.ranges.reduce((n, r) => n + r.end - r.start + 1, 0),
        annotated: !!describerFor(diff.family, diff.requestType, a),
      })}</div>`
    : '';
  if (!diff.ranges.length) {
    $('diffPane').innerHTML = plain + plocks
      + '<span class="dim">No byte differences — the edit didn\'t reach this pattern (or there was no edit).</span>';
    return;
  }
  const parts = [plain, plocks,
    `<div class="region"><span class="label">${diff.ranges.length} changed region${diff.ranges.length > 1 ? 's' : ''}, ${diff.ranges.reduce((n, r) => n + r.end - r.start + 1, 0)} bytes</span></div>`];
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

// Build the diff record from any A/B pair — a live capture or an imported
// donation; `deviceInfo` is either the connected identity or the pair file's.
function makeDiff(a, b, deviceInfo, { fromFile = false } = {}) {
  return {
    device: deviceInfo.name, slug: deviceInfo.slug, build: deviceInfo.build,
    version: deviceInfo.version, productId: deviceInfo.productId,
    index: b.index, at: b.at, family: a.family, requestType: a.requestType,
    target: targetLabel(a.family, a.requestType),
    fromFile,
    ranges: diffAnnotatedRanges(a.payload, b.payload, describerFor(a.family, a.requestType, a.payload)),
    plocks: plockReport(specFor(a.family, a.requestType), a.payload, b.payload),
    a: a.payload, b: b.payload,
  };
}

function reportDiff() {
  if (guided) {
    setStatus(lastDiff.ranges.length
      ? 'Got it — enter the after value and click “Save experiment”'
      : "Nothing moved between the two snapshots — check the read-out below");
    return;
  }
  const laneChanges = lastDiff.plocks?.changed.length ?? 0;
  setStatus(lastDiff.ranges.length
    ? `${lastDiff.ranges.length} region(s) changed`
      + (laneChanges ? `, including ${laneChanges} p-lock lane(s)` : '')
      + ' — describe the edit and save it to the notebook'
    : 'No differences found');
}

$('capB').onclick = async () => {
  if (!baseline || (guided && !experiments.canAfter())) return;
  try {
    const cap = await capture({ family: baseline.family, requestType: baseline.requestType, index: baseline.index });
    // Both sides must be the same slot or the diff is between two different
    // objects. This compares what the box *answered*, which also catches a
    // working-state capture where the box was made to load a different slot
    // between A and B — a real way to ruin an experiment without touching the
    // lab's controls.
    if (cap.family !== baseline.family || cap.requestType !== baseline.requestType
        || cap.payload.length !== baseline.payload.length) {
      throw new Error('The snapshots have different targets or sizes — take a fresh baseline');
    }
    if (cap.index !== baseline.index) {
      throw new Error(`the box answered with ${bankName(cap.index)}, but the baseline is ${bankName(baseline.index)}`
        + ' — capture a fresh baseline');
    }
    lastCapture = cap;
    lastDiff = makeDiff(baseline, cap, baseline.identity);
    renderDiff(lastDiff, baseline.payload, cap.payload);
    reportDiff();
  } catch (err) {
    setStatus(`Capture failed: ${err.message}`, true);
  }
  syncButtons();
};

$('labChain').onclick = () => {
  if (!lastCapture || lastDiff?.fromFile) return;
  baseline = lastCapture;
  lastCapture = null; lastDiff = null;
  $('captureInfo').textContent = `baseline: ${bankName(baseline.index)} (chained)`;
  $('diffPane').innerHTML = '<span class="dim">Chained: the last capture is the new baseline. Make the next edit…</span>';
  setStatus('Chained — make the next edit on the box');
  syncButtons();
};

// --- Probe: find an unmapped box's dump protocol -----------------------------------
//
// The recipe that found the DN2's family byte (a 0x60 request sweep across
// candidate bytes — only 0x15 answered), as a button, because it is the first
// thing a contributor with a Syntakt or an Analog Rytm has to do and it used to
// live only in a session log. Two passes: sweep every candidate family with the
// two pattern-shaped requests, then ask any family that answered for all five
// dump types. Requests only — the device layer refuses to send anything else.

const hexByte = v => `0x${v.toString(16).padStart(2, '0')}`;

function renderProbeReport(report, summary) {
  const fam = summary[0];
  const pick = fam && !fam.streamed
    && fam.replies.find(r => requestTypesFor(fam.family)[r.requestType]);
  $('diffPane').innerHTML =
    `<div class="region"><span class="label">Probe report — post this to the digi-roll thread</span></div>`
    + `<pre class="probeReport">${esc(report)}</pre>`
    + `<button id="copyReport">Copy report</button>`
    + (pick
      ? `<span class="dim">  The capture target above is set to what answered — capture a baseline, `
        + `make ONE edit on the box, capture again, then “Export pair”.</span>`
      : '');
  $('copyReport').onclick = async () => {
    await navigator.clipboard.writeText(report);
    setStatus('Report copied — paste it into the forum thread');
  };
}

$('labProbe').onclick = async () => {
  if (!device) return;
  $('labProbe').disabled = true;
  try {
    const plan = sweepPlan({ index: +$('labPattern').value });
    setStatus(`Probing: ${plan.length} dump requests, read-only — this takes ~20 seconds…`);
    const onProgress = p => { if (p.sent) setStatus(`Probing… request ${p.sent}/${plan.length} (read-only)`); };
    const first = await device.probeDumpRequests(plan, { onProgress });
    let findings = first;
    let probed = plan.length;

    const answered = [...new Set(first.map(f => f.family))];
    if (answered.length) {
      const plan2 = deepPlan(answered, { index: +$('labPattern').value });
      setStatus(`Family ${answered.map(hexByte).join(', ')} answered — asking it for every dump type…`);
      findings = [...first, ...await device.probeDumpRequests(plan2)];
      probed += plan2.length;
    }

    const summary = summarizeFindings(findings);
    const report = contributorReport({
      identity: captureIdentity(device),
      portName: [...access.outputs.values()].find(o => o.id === $('port').value)?.name ?? '',
      summary, probed,
    });
    experiments.addReport(report, captureIdentity(device));
    renderProbeReport(report, summary);

    // Point the capture target at the best thing that answered, so the next
    // click is a capture rather than a hex-typing exercise.
    const fam = summary[0];
    const reply = fam && !fam.streamed
      && fam.replies.find(r => r.ok && requestTypesFor(fam.family)[r.requestType]);
    if (reply) {
      $('labFamily').value = fam.family.toString(16).padStart(2, '0');
      refreshTypeMenu();
      // Prefer the family's pattern request when it answered; otherwise take
      // whatever did.
      const wanted = defaultRequestFor(fam.family);
      $('labType').value = String(fam.replies.some(r => r.ok && r.requestType === wanted)
        ? wanted : reply.requestType);
      setStatus(`Probe done: family ${hexByte(fam.family)} answers — capture target set, copy the report to the thread`);
    } else {
      setStatus('Probe done: no family byte answered — copy the report to the thread anyway, silence is a finding too', true);
    }
  } catch (err) {
    setStatus(`Probe failed: ${err.message}`, true);
  }
  syncButtons();
};

// --- Capture pairs: the shareable experiment ---------------------------------------
//
// Export writes baseline + after + the note into one JSON file; import reads
// one back and diffs it with no box attached. This is the whole contribution
// loop: someone who owns the box runs the experiment, we read the bytes.

$('labExportPair').onclick = () => {
  if (!(baseline && lastCapture && lastDiff) || lastDiff.fromFile) return;
  const id = baseline.identity;
  const name = `digiroll-capture-${id.slug !== 'elektron' ? id.slug : `product${id.productId}`}`
    + `-${bankName(baseline.index)}-${lastCapture.at.slice(0, 19).replaceAll(':', '-')}.json`;
  downloadText(name, buildCapturePair({
    device: id,
    family: baseline.family, requestType: baseline.requestType, index: baseline.index,
    note: $('labNote').value.trim(),
    capturedAt: lastCapture.at,
    baselineRaw: baseline.raw, afterRaw: lastCapture.raw,
  }));
  lastDiff.exported = true;
  setStatus(`Capture pair saved: ${name} — attach it to the thread with the probe report`);
  syncButtons();
};

$('labImportPair').onclick = () => $('labImportPairInput').click();
$('labImportPairInput').onchange = async () => {
  const file = $('labImportPairInput').files[0];
  if (!file) return;
  try {
    const pair = parseCapturePair(await file.text());
    const meta = { at: pair.capturedAt ?? '', index: pair.index, family: pair.family, requestType: pair.requestType };
    baseline = { ...meta, payload: pair.baseline.payload, raw: pair.baseline.raw };
    lastCapture = { ...meta, payload: pair.after.payload, raw: pair.after.raw };
    lastDiff = makeDiff(baseline, lastCapture, pair.device, { fromFile: true });
    $('labNote').value = pair.note;
    $('labFamily').value = pair.family.toString(16).padStart(2, '0');
    refreshTypeMenu();
    if (requestTypesFor(pair.family)[pair.requestType]) $('labType').value = String(pair.requestType);
    $('captureInfo').textContent = `from ${file.name}: ${bankName(pair.index)}, ${pair.baseline.payload.length} bytes`
      + ` · ${pair.device.name ?? 'unknown device'}${pair.device.build ? ` build ${pair.device.build}` : ''}`;
    renderDiff(lastDiff, baseline.payload, lastCapture.payload);
    reportDiff();
  } catch (err) {
    setStatus(`Couldn't read ${file.name}: ${err.message}`, true);
  }
  $('labImportPairInput').value = '';
  syncButtons();
};

// --- Notebook --------------------------------------------------------------------

const NOTEBOOK_KEY = 'digiroll-difflab-v1';
const loadNotebook = () => {
  try {
    const v = JSON.parse(localStorage.getItem(NOTEBOOK_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return []; // unreadable storage shows an empty notebook rather than no page
  }
};
const saveNotebook = nb => localStorage.setItem(NOTEBOOK_KEY, JSON.stringify(nb));

function renderNotebook() {
  const nb = loadNotebook();
  $('notebook').innerHTML = nb.length ? '' : '<span class="dim">No experiments saved yet.</span>';
  nb.forEach((e, i) => {
    const div = document.createElement('div');
    div.className = 'entry';
    // An entry can be missing anything — saved from a hand-edited donation, or
    // by an older version of this page — and this renderer runs before MIDI
    // init at boot. A bad entry becomes a deletable stub; it never takes the
    // page down with it.
    let body;
    try {
      const meta = [
        esc(e.device || 'unknown device'),
        e.version ? `OS ${esc(e.version)}` : '',
        e.build ? `(build ${esc(e.build)})` : '',
        Number.isInteger(e.index) ? bankName(e.index) : '',
        e.target ? esc(e.target) : '',
        esc(String(e.at ?? '').slice(0, 19).replace('T', ' ')),
      ].filter(Boolean).join(' · ');
      body =
        `<h3>${esc(e.note || '(unlabelled experiment)')}</h3>` +
        `<span class="meta">${meta}</span>` +
        (e.plocks?.length ? `<ul>${e.plocks.map(l => `<li>p-lock: ${esc(l)}</li>`).join('')}</ul>` : '') +
        `<ul>${(e.ranges ?? []).map(r => `<li>[${esc(r.start)}..${esc(r.end)}] ${esc(r.label)}: <code>${esc(r.was)}</code> → <code>${esc(r.now)}</code></li>`).join('')}</ul>`;
    } catch (err) {
      body = `<h3>(unreadable notebook entry)</h3><span class="meta">${esc(err.message)} — the ✕ removes it</span>`;
    }
    div.innerHTML = `<button data-del="${i}">✕</button>` + body;
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
    // Named when this wasn't a mapped box's pattern-kit — for a new box, what
    // was captured is itself part of the finding.
    target: lastDiff.target ?? undefined,
    // Lane findings, tags stripped: these go straight into the format docs, and
    // they're the whole point of a p-lock capture.
    plocks: (lastDiff.plocks?.changed ?? []).map(l => l.text.replace(/<[^>]+>/g, '')),
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
      `${e.device} OS ${e.version} (build ${e.build}), pattern ${bankName(e.index)}${e.target ? ` (${e.target})` : ''}, ${e.at}`,
      '',
      ...(e.plocks?.length ? [...e.plocks.map(l => `- **p-lock** ${l}`), ''] : []),
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

for (const id of ['connect', 'capA', 'capB', 'labProbe']) {
  const handler = $(id).onclick;
  $(id).onclick = async event => {
    if (busy) return;
    busy = true; syncButtons();
    try { await handler(event); }
    finally { busy = false; syncButtons(); }
  };
}

(async () => {
  // The notebook must never keep MIDI from coming up: renderNotebook is already
  // defensive per entry, but if it still throws, the lab has to stay usable —
  // this is the contributor-facing page, and "clear your localStorage" is not a
  // first impression.
  try {
    renderNotebook();
  } catch (err) {
    setStatus(`The notebook couldn't render (${err.message}) — captures still work`, true);
  }
  renderGuide();
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
  refreshTypeMenu();
  setStatus('Pick your box and hit Connect.');
})();
