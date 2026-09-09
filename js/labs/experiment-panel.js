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
  let actionTarget = 'connect';
  const fields = () => ({ track: $('experimentTrack').value, step: $('experimentStep').value,
    before: selected === 'trig' ? ($('trigConfirm').checked ? 'empty' : '') : $('experimentBefore').value, beforeUnknown: selected !== 'trig' && $('beforeUnknown').checked,
    after: selected === 'trig' ? ($('trigConfirm').checked && getState().hasBaseline ? 'trig on' : '') : $('experimentAfter').value, afterUnknown: selected !== 'trig' && $('afterUnknown').checked, note: $('labNote').value });
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
    $('trigConfirm').checked = false;
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
    const patternHost = $(s.guided ? 'guidedPatternTarget' : 'expertPatternTarget');
    if ($('patternSelector').parentElement !== patternHost) patternHost.append($('patternSelector'));
    $('guidedPatternTarget').hidden = !s.connected || s.hasBaseline;
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
    $('experimentValidation').textContent = linkError || (saved || selected === 'trig' || !s.connected ? '' : errors.join(' '));
    $('saveExperiment').disabled = s.busy || !own || saved || !!errors.length;
    $('nextExperiment').disabled = s.busy || !saved;
    $('restartExperiment').disabled = s.busy || !active;
    const pending = checklist.find(id => !completed.has(id));
    $('experimentProgress').textContent = checklist.includes(selected)
      ? `Experiment ${checklist.indexOf(selected) + 1} of ${checklist.length}` : 'Optional experiment';
    const examples = {
      trig: ['empty', 'trig on'], velocity: ['100', '110'], length: ['1/16', '1/8'],
      micro: ['0', '1/384 earlier'], pitch: ['C3', 'D3'], layout: ['C3', 'D3'],
      'default-note': ['C3', 'D3'], 'pattern-length': ['16 steps', '32 steps'],
      tempo: ['120 BPM', '125 BPM'], swing: ['50%', '55%'],
    }[selected] ?? ['Exactly as displayed', 'Exactly as displayed'];
    $('experimentBefore').placeholder = `e.g. ${examples[0]}`;
    $('experimentAfter').placeholder = `e.g. ${examples[1]}`;
    $('nextExperiment').textContent = pending ? 'Next experiment' : 'Start another experiment';
    $('experimentInstruction').textContent = !s.connected ? 'Connect your box to begin. You can choose a checklist experiment first.'
      : !s.target ? 'Run Probe dump protocol to find a capture target. You can download and share the report even if nothing answers.'
      : saved ? (pending ? 'This pair is saved in this tab. Continue to the next experiment, or stop here and download your session ZIP.' : 'Checklist complete. Download your session ZIP below, then attach it to the issue. Thank you for helping!')
      : !s.hasBaseline ? `${r.prep} Select the same scratch pattern slot on the box and below. Enter the before value (or mark it unknown), then click Capture before. Do not make the test edit yet.`
      : !own ? `${r.track != null ? `On track ${details().track}${r.step != null ? `, step ${details().step}` : ''}: ` : ''}${r.edit} Then click Capture after and enter the after value.`
      : 'Enter the after value and any unexpected extra edits in the note, then click Save experiment. Several changed bytes are fine; a zero-change pair is also worth saving.';
    const preparing = !s.hasBaseline;
    $('experimentHeading').textContent = !s.connected ? 'Connect your instrument'
      : !s.target ? 'Find your box’s capture settings'
      : saved ? 'Your experiment is saved'
      : preparing ? (selected === 'trig' ? 'First, get an empty step ready' : `Read the starting value: ${r.title}`)
      : !own ? (selected === 'trig' ? 'Now add one trig on your box' : `Now make one change: ${r.title}`)
      : 'Keep this experiment';
    const locationText = `track ${details().track}, step ${details().step}`;
    const tasks = selected === 'trig' && s.connected && s.target && !saved
      ? preparing ? [
        'On your instrument, choose an empty pattern in a spare project.',
        'Select that same pattern in the “Pattern slot” menu below (for example, A01).',
        `Select ${locationText} on the instrument. Leave that step empty — do not add a trig yet.`,
        'Tick the confirmation below, then click Capture before. This reads the empty pattern.',
      ] : !own ? [
        `On the instrument, add one trig on ${locationText}. Leave all its other settings alone.`,
        'Tick the confirmation below, then click Capture after. This reads the pattern again.',
      ] : ['Click Save experiment to keep both snapshots in this tab.', 'Then download the ZIP to keep or share your work. One experiment is enough to help.']
      : [];
    $('experimentTasks').replaceChildren(...tasks.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
    if (tasks.length) $('experimentInstruction').textContent = preparing
      ? 'We will compare an empty step with a step containing a trig. Start with the empty step.'
      : !own ? 'The before snapshot is captured. You can make the edit now.' : 'Both snapshots are captured. No values need typing for this experiment.';
    $('trigConfirmField').hidden = selected !== 'trig' || !s.connected || !s.target || own || saved;
    $('trigConfirmText').textContent = preparing ? `I checked: ${locationText} is empty.` : `I added one trig on ${locationText}.`;
    $('trigConfirm').disabled = s.busy;
    for (const id of ['beforeValueField', 'beforeUnknownField']) $(id).hidden = selected === 'trig' || !preparing || !s.connected;
    for (const id of ['afterValueField', 'afterUnknownField']) $(id).hidden = selected === 'trig' || preparing || saved || !s.connected;
    const labels = ['Connect', 'Prepare + capture before', 'Edit + capture after', 'Save experiment', pending ? 'Next experiment' : 'Download + share'];
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
    actionTarget = !s.connected ? 'connect' : !s.target ? 'labProbe' : !s.hasBaseline ? 'capA'
      : !own ? 'capB' : !saved ? 'saveExperiment' : pending ? 'nextExperiment' : 'downloadSession';
    $('experimentAction').textContent = s.busy ? 'Reading your box…' : {
      connect: 'Connect your box', labProbe: 'Find capture settings', capA: 'Capture before',
      capB: 'Capture after', saveExperiment: 'Save experiment', nextExperiment: 'Next experiment',
      downloadSession: 'Download session ZIP',
    }[actionTarget];
    $('experimentAction').disabled = s.busy || $(actionTarget).disabled;
  }
  // Reuse the existing guarded actions; this button adds no hardware path.
  $('experimentAction').onclick = () => { if (!getState().busy) $(actionTarget).click(); };
  $('trigConfirm').oninput = sync;
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
      const filename = `digiroll-session-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.zip`;
      downloadBytes(filename, sessionZip(session.files()), 'application/zip');
      $('sessionDownload').textContent = `Look in Downloads for ${filename}. Attach that file in step 3. If it is missing, try Download session ZIP again.`;
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
    beforeCaptured() { const d = fields(); frozen = { track: d.track, step: d.step, before: d.before, beforeUnknown: d.beforeUnknown }; saved = false; $('trigConfirm').checked = false; },
    canAfter: () => !saved && !getState().hasDiff && !getState().fromFile && (selected !== 'trig' || $('trigConfirm').checked),
    reset,
    addReport(text, identity) { session.addReport(text, identity); },
  };
}
