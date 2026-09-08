import { EXPERIMENTS, STANDARD, checklistFromURL, checklistLink, issueLink, detailErrors, experimentNote } from './experiments.js';
import { CaptureSession } from './session.js';
import { sessionZip } from './zip.js';
import { downloadBytes } from '../download.js';

// UI owns the experiment cycle; hardware and the immutable messages remain in
// difflab.js. No MIDI methods live here.
export function experimentPanel({ getState, resetCapture, pairText, status, sync }) {
  const $ = id => document.getElementById(id);
  const session = new CaptureSession();
  let checklist, linkError = '';
  try { checklist = checklistFromURL(location.href); }
  catch (err) { checklist = [...STANDARD]; linkError = err.message; }
  let selected = checklist[0], saved = false, frozen = null;
  const completions = new Map();
  let deviceKey = '', completed = new Set();
  const fields = () => ({ track: $('experimentTrack').value, step: $('experimentStep').value,
    before: $('experimentBefore').value, beforeUnknown: $('beforeUnknown').checked,
    after: $('experimentAfter').value, afterUnknown: $('afterUnknown').checked, note: $('labNote').value });
  const details = () => frozen ? { ...fields(), ...frozen } : fields();
  function populate() {
    $('experimentSelect').replaceChildren();
    for (const id of [...checklist, ...Object.keys(EXPERIMENTS).filter(id => !checklist.includes(id))]) {
      const suffix = completed.has(id) ? ' — saved' : checklist.includes(id) ? '' : ' — optional';
      $('experimentSelect').add(new Option(EXPERIMENTS[id].title + suffix, id));
    }
    $('experimentSelect').value = selected;
  }
  function reset(id = selected) {
    selected = id; saved = false; frozen = null; resetCapture();
    const r = EXPERIMENTS[id];
    $('experimentTrack').value = r.track ?? 1; $('experimentStep').value = r.step ?? 1;
    $('experimentBefore').value = ''; $('experimentAfter').value = ''; $('labNote').value = '';
    $('beforeUnknown').checked = false; $('afterUnknown').checked = false;
    populate(); sync();
  }
  function render() {
    const s = getState(), r = EXPERIMENTS[selected], active = s.hasBaseline || s.hasDiff;
    const key = JSON.stringify(s.identity ? [s.identity.productId, s.identity.name, s.identity.version, s.identity.build] : null);
    if (key !== deviceKey) {
      deviceKey = key;
      if (!completions.has(key)) completions.set(key, new Set());
      completed = completions.get(key); populate();
    }
    const own = s.hasDiff && !s.fromFile;
    $('trackField').hidden = r.track == null; $('stepField').hidden = r.step == null;
    $('experimentSelect').disabled = s.busy || active;
    $('checklistInclude').checked = checklist.includes(selected);
    $('checklistInclude').disabled = s.busy || active;
    for (const id of ['experimentTrack', 'experimentStep', 'experimentBefore', 'beforeUnknown']) $(id).disabled = s.busy || active;
    $('experimentBefore').disabled ||= $('beforeUnknown').checked;
    $('experimentAfter').disabled = s.busy || !active || saved || $('afterUnknown').checked;
    $('afterUnknown').disabled = s.busy || !active || saved;
    $('labNote').disabled = s.busy || (s.guided && saved);
    const errors = detailErrors(selected, details(), { after: own });
    $('experimentValidation').textContent = linkError || (saved ? '' : errors.join(' '));
    $('saveExperiment').disabled = s.busy || !own || saved || !!errors.length;
    $('nextExperiment').disabled = s.busy || !saved;
    $('restartExperiment').disabled = s.busy || !active;
    const pending = checklist.find(id => !completed.has(id));
    $('nextExperiment').textContent = pending ? 'Next experiment' : 'Start another experiment';
    $('experimentInstruction').textContent = !s.connected ? 'Connect your box to begin. You can choose a checklist experiment first.'
      : !s.target ? 'Run Probe dump protocol to find a capture target. You can download and share the report even if nothing answers.'
      : saved ? 'This pair is saved in your session. Choose Next experiment for a fresh before snapshot, or download your session ZIP.'
      : !s.hasBaseline ? `${r.prep} Enter the before value (or mark it unknown), then click Capture baseline. Do not make the test edit yet.`
      : !own ? `${r.edit} Then click Capture + diff and enter the after value.`
      : 'Enter the after value and any unexpected extra edits in the note, then click Save experiment. Several changed bytes are fine; a zero-change pair is also worth saving.';
    const labels = ['Connect', 'Prepare + capture before', 'Edit + capture after', 'Save experiment', 'Next experiment'];
    const current = !s.connected ? 0 : !s.hasBaseline ? 1 : !own ? 2 : !saved ? 3 : 4;
    $('guideSteps').replaceChildren(...labels.map((label, i) => {
      const li = document.createElement('li'); li.className = i < current ? 'done' : i === current ? 'now' : 'todo';
      li.textContent = `${i < current ? '✓' : i + 1} ${label}`;
      if (i === current) li.setAttribute('aria-current', 'step');
      return li;
    }));
    $('sessionSummary').textContent = `${session.pairs.length} experiment(s) and ${session.reports.length} probe report(s) saved in this tab. `
      + `${checklist.filter(id => completed.has(id)).length}/${checklist.length} checklist experiments saved. `
      + (session.hasUndownloaded ? 'Download to keep the latest additions.' : session.revision ? 'Latest session download requested; check your Downloads folder.' : '');
    $('downloadSession').disabled = s.busy || !session.revision;
  }
  $('experimentSelect').onchange = () => reset($('experimentSelect').value);
  $('checklistInclude').onchange = () => {
    checklist = $('checklistInclude').checked ? [...checklist, selected] : checklist.filter(id => id !== selected);
    populate(); render();
  };
  $('checklistLink').onclick = async () => {
    try { await navigator.clipboard.writeText(checklistLink(location.href, checklist)); status('Checklist link copied — share it with the contributor.'); }
    catch (err) { status(`Could not copy checklist link: ${err.message}`, true); }
  };
  for (const id of ['experimentTrack', 'experimentStep', 'experimentBefore', 'beforeUnknown', 'experimentAfter', 'afterUnknown']) $(id).oninput = () => { linkError = ''; sync(); };
  $('saveExperiment').onclick = () => {
    const s = getState(); if (s.busy || !s.hasDiff || s.fromFile || saved) return;
    const d = details(), errors = detailErrors(selected, d, { after: true });
    if (errors.length) { status(errors.join(' '), true); return; }
    try {
      session.addPair(pairText(experimentNote(selected, d)), { id: selected, ...d });
      saved = true; completed.add(selected); populate(); sync();
      status('Experiment saved in this tab. Next experiment starts with a fresh before snapshot.');
    } catch (err) { status(`Could not save experiment: ${err.message}`, true); }
  };
  $('nextExperiment').onclick = () => { if (saved && !getState().busy) reset(checklist.find(id => !completed.has(id)) ?? selected); };
  $('restartExperiment').onclick = () => { if (!getState().busy) reset(); };
  $('downloadSession').onclick = () => {
    try {
      downloadBytes(`digiroll-session-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.zip`, sessionZip(session.files()), 'application/zip');
      session.downloadedRevision = session.revision; render();
      status('ZIP download requested. Check Downloads, then attach the ZIP through the GitHub issue website.');
    } catch (err) { status(`Download failed: ${err.message}`, true); }
  };
  $('sessionIssue').href = issueLink(location.href);
  window.addEventListener('beforeunload', e => {
    const s = getState();
    if (session.hasUndownloaded || (s.hasBaseline && !s.fromFile && !s.exported && !saved)) { e.preventDefault(); e.returnValue = ''; }
  });
  $('experimentTrack').value = EXPERIMENTS[selected].track ?? 1;
  $('experimentStep').value = EXPERIMENTS[selected].step ?? 1;
  populate();
  return {
    render,
    canBaseline: () => !getState().hasBaseline && !detailErrors(selected, fields()).length,
    beforeCaptured() { const d = fields(); frozen = { track: d.track, step: d.step, before: d.before, beforeUnknown: d.beforeUnknown }; saved = false; },
    canAfter: () => !saved && !getState().hasDiff && !getState().fromFile,
    reset,
    addReport(text, identity) { session.addReport(text, identity); },
  };
}
