import { loadState, saveState, defaultPattern, makeNote, NUM_SLOTS } from './state.js';
import { MidiEngine, patternToMidiFile, midiFileToNotes } from './midi.js';
import { PianoRoll, SCALES, PITCH_CLASSES, PITCH_MIN, PITCH_MAX } from './pianoroll.js';

const $ = id => document.getElementById(id);

const state = loadState();
const pattern = () => state.patterns[state.current];
const persist = () => saveState(state);

// --- Undo history -----------------------------------------------------------
// Snapshot-based: each entry is a deep copy of one slot's pattern, taken before
// a mutation (once per drag gesture, not per mousemove).

const HISTORY_MAX = 100;
const undoStack = [], redoStack = [];
const snapshot = slot => ({ slot, data: structuredClone(state.patterns[slot]) });

function pushUndo() {
  undoStack.push(snapshot(state.current));
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  syncHistory();
}

// A gesture that ended up changing nothing (e.g. click a note without moving it)
// shouldn't leave a dead undo step behind.
function dropUnchangedUndo() {
  const top = undoStack[undoStack.length - 1];
  if (top && top.slot === state.current &&
      JSON.stringify(top.data) === JSON.stringify(pattern())) {
    undoStack.pop();
    syncHistory();
  }
}

function step(from, to) {
  const entry = from.pop();
  if (!entry) return;
  to.push(snapshot(entry.slot));
  state.patterns[entry.slot] = entry.data;
  state.current = entry.slot;
  roll.clearSelection();
  syncToolbar();
  roll.resize();
  persist();
  syncHistory();
}

function syncHistory() {
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
}

const engine = new MidiEngine(() => ({
  pattern: pattern(),
  bpm: state.bpm,
  sendClock: state.sendClock,
  countIn: state.countIn,
}));

const roll = new PianoRoll($('roll'), {
  getPattern: pattern,
  getDefaultVelocity: () => state.defaultVelocity,
  onChange: () => { dropUnchangedUndo(); persist(); },
  onBeforeEdit: pushUndo,
  getScale: () => state.scale === 'off' ? null : { root: state.scaleRoot, set: new Set(SCALES[state.scale]) },
  onPreview: (pitch, vel) => { if (!engine.playing) engine.audition(pattern().channel, pitch, vel); },
  onSelect: note => {
    // Slider mirrors the touched note; its velocity becomes the default for new notes.
    state.defaultVelocity = note.velocity;
    $('velocity').value = note.velocity;
    $('velLabel').textContent = note.velocity;
  },
});

// --- Toolbar wiring ---------------------------------------------------------

const slotSel = $('slot');
for (let i = 0; i < NUM_SLOTS; i++) slotSel.add(new Option(`Pattern ${i + 1}`, i));

const chanSel = $('channel');
for (let i = 0; i < 16; i++) chanSel.add(new Option(`Ch ${i + 1}`, i));

const lenSel = $('length');
for (const bars of [1, 2, 3, 4, 5, 6, 7, 8]) lenSel.add(new Option(`${bars} bar${bars > 1 ? 's' : ''}`, bars * 16));

const countSel = $('countin');
for (const bars of [0, 1, 2, 4]) countSel.add(new Option(bars === 0 ? 'Off' : `${bars} bar${bars > 1 ? 's' : ''}`, bars));

const rootSel = $('root');
PITCH_CLASSES.forEach((n, i) => rootSel.add(new Option(n, i)));

const scaleSel = $('scale');
scaleSel.add(new Option('Scale: off', 'off'));
for (const name of Object.keys(SCALES)) scaleSel.add(new Option(name, name));

function syncToolbar() {
  slotSel.value = state.current;
  chanSel.value = pattern().channel;
  lenSel.value = pattern().lengthSteps;
  $('bpm').value = state.bpm;
  $('swing').value = pattern().swing ?? 50;
  $('clock').checked = state.sendClock;
  countSel.value = state.countIn;
  rootSel.value = state.scaleRoot;
  scaleSel.value = state.scale;
  $('velocity').value = state.defaultVelocity;
  $('velLabel').textContent = state.defaultVelocity;
}

slotSel.onchange = () => {
  if (engine.playing) togglePlay();
  state.current = +slotSel.value;
  roll.clearSelection();
  syncToolbar();
  roll.resize();
  persist();
};
chanSel.onchange = () => { pattern().channel = +chanSel.value; persist(); };
lenSel.onchange = () => {
  const len = +lenSel.value;
  pushUndo();
  pattern().lengthSteps = len;
  pattern().notes = pattern().notes.filter(n => n.step < len);
  for (const n of pattern().notes) n.len = Math.min(n.len, len - n.step);
  roll.resize();
  persist();
};
$('bpm').onchange = () => {
  state.bpm = Math.max(30, Math.min(300, +$('bpm').value || 120));
  $('bpm').value = state.bpm;
  persist();
};
$('swing').onchange = () => {
  pushUndo();
  pattern().swing = Math.max(50, Math.min(80, Math.round(+$('swing').value) || 50));
  dropUnchangedUndo();
  $('swing').value = pattern().swing;
  persist();
};
$('clock').onchange = () => { state.sendClock = $('clock').checked; persist(); };
countSel.onchange = () => { state.countIn = +countSel.value; persist(); };
rootSel.onchange = () => { state.scaleRoot = +rootSel.value; roll.draw(); persist(); };
scaleSel.onchange = () => { state.scale = scaleSel.value; roll.draw(); persist(); };
let velGesture = false; // one undo entry per slider drag, not per input event
$('velocity').oninput = () => {
  const sel = roll.selectedNotes();
  if (sel.length && !velGesture) { velGesture = true; pushUndo(); }
  state.defaultVelocity = +$('velocity').value;
  $('velLabel').textContent = state.defaultVelocity;
  for (const n of sel) n.velocity = state.defaultVelocity;
  if (sel.length) roll.draw();
  persist();
};
$('velocity').onchange = () => { velGesture = false; };
$('clear').onclick = () => {
  if (!pattern().notes.length || confirm(`Clear all notes in ${pattern().name}?`)) {
    pushUndo();
    state.patterns[state.current] = { ...defaultPattern(state.current), channel: pattern().channel, lengthSteps: pattern().lengthSteps, swing: pattern().swing };
    roll.clearSelection();
    roll.resize();
    persist();
  }
};
$('help').onclick = () => $('helpPanel').classList.toggle('hidden');
$('undo').onclick = () => step(undoStack, redoStack);
$('redo').onclick = () => step(redoStack, undoStack);

// --- Clipboard + duplicate bar --------------------------------------------------
// In-memory so it survives switching pattern slots.

let clipboard = [];

function copySelection(cut = false) {
  const sel = roll.selectedNotes();
  if (!sel.length) return;
  clipboard = sel.map(({ step, pitch, len, velocity, micro }) => ({ step, pitch, len, velocity, micro }));
  if (cut) {
    pushUndo();
    const p = pattern();
    p.notes = p.notes.filter(n => !roll.selected.has(n.id));
    roll.clearSelection();
    roll.draw();
    persist();
  }
  setStatus(`${cut ? 'Cut' : 'Copied'} ${clipboard.length} note${clipboard.length > 1 ? 's' : ''}`);
}

function paste() {
  if (!clipboard.length) return;
  const p = pattern();
  pushUndo();
  const added = clipboard.map(c => {
    const s = Math.min(c.step, p.lengthSteps - 1);
    return makeNote(s, c.pitch, Math.min(c.len, p.lengthSteps - s), c.velocity, c.micro);
  });
  p.notes.push(...added);
  roll.setSelection(added.map(n => n.id));
  roll.draw();
  persist();
  setStatus(`Pasted ${added.length} note${added.length > 1 ? 's' : ''}`);
}

$('export').onclick = () => {
  const p = pattern();
  const url = URL.createObjectURL(new Blob([patternToMidiFile(p, state.bpm)], { type: 'audio/midi' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${p.name.trim().replace(/[^\w -]+/g, '') || 'pattern'}.mid`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${a.download} — ${p.notes.length} notes at ${state.bpm} BPM`);
};

$('import').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const file = $('importFile').files[0];
  if (!file) return;
  try {
    const { notes, lengthSteps, dropped } = midiFileToNotes(new Uint8Array(await file.arrayBuffer()));
    if (!notes.length) { setStatus(`No notes found in ${file.name}`, true); return; }
    pushUndo();
    const p = pattern();
    p.lengthSteps = lengthSteps;
    p.notes = notes.map(n => makeNote(n.step, Math.max(PITCH_MIN, Math.min(PITCH_MAX, n.pitch)), n.len, n.velocity, n.micro));
    roll.clearSelection();
    syncToolbar();
    roll.resize();
    persist();
    setStatus(`Imported ${notes.length} notes from ${file.name}` + (dropped ? ` (${dropped} past 8 bars dropped)` : ''));
  } catch (err) {
    setStatus(`Couldn't read ${file.name}: ${err.message}`, true);
  }
  $('importFile').value = '';
};

$('dup').onclick = () => {
  const p = pattern();
  if (p.lengthSteps >= 128) { setStatus('Already 8 bars — can\'t duplicate further', true); return; }
  pushUndo();
  const from = p.lengthSteps - 16;
  const copies = p.notes.filter(n => n.step >= from);
  p.lengthSteps += 16;
  for (const n of copies) {
    p.notes.push(makeNote(n.step + 16, n.pitch, Math.min(n.len, p.lengthSteps - n.step - 16), n.velocity, n.micro));
  }
  syncToolbar();
  roll.resize();
  persist();
  setStatus(`Duplicated bar ${from / 16 + 1} into bar ${p.lengthSteps / 16}`);
};

// --- Keyboard shortcuts --------------------------------------------------------

const typing = e => e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA';

window.addEventListener('keydown', e => {
  if (typing(e) || !(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'z') {
    e.preventDefault();
    step(...(e.shiftKey ? [redoStack, undoStack] : [undoStack, redoStack]));
  } else if (k === 'c' || k === 'x') {
    e.preventDefault();
    copySelection(k === 'x');
  } else if (k === 'v') {
    e.preventDefault();
    paste();
  }
});

// --- Transport ---------------------------------------------------------------

function togglePlay() {
  if (engine.playing) {
    engine.stop();
    $('play').textContent = '▶ Play';
    $('play').classList.remove('active');
    roll.setPlayhead(null);
  } else {
    if (!engine.output) { setStatus('Select a MIDI output first', true); return; }
    engine.start();
    $('play').textContent = '■ Stop';
    $('play').classList.add('active');
    animate();
  }
}
$('play').onclick = togglePlay;
window.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    togglePlay();
  }
});

function animate() {
  if (!engine.playing) return;
  const pos = engine.playheadStep();
  roll.setPlayhead(pos);
  $('play').textContent = pos == null && state.countIn > 0 ? '■ Count-in…' : '■ Stop';
  requestAnimationFrame(animate);
}

// --- MIDI setup ---------------------------------------------------------------

const outSel = $('output');

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function refreshOutputs(outputs) {
  const prev = state.outputId;
  outSel.innerHTML = '';
  outSel.add(new Option('— MIDI output —', ''));
  for (const o of outputs) outSel.add(new Option(o.name, o.id));
  if (prev && outputs.some(o => o.id === prev)) {
    outSel.value = prev;
    engine.setOutput(prev);
    setStatus(`Connected: ${outputs.find(o => o.id === prev).name}`);
  } else if (outputs.length) {
    setStatus('Choose your Digitakt/Digitone in the MIDI output menu');
  } else {
    setStatus('No MIDI outputs found — plug in your box via USB', true);
  }
}

outSel.onchange = () => {
  state.outputId = outSel.value || null;
  if (state.outputId && engine.setOutput(state.outputId)) {
    setStatus(`Connected: ${outSel.options[outSel.selectedIndex].text}`);
  }
  persist();
};

(async () => {
  syncToolbar();
  syncHistory();
  roll.resize();
  roll.scrollToCenter($('rollWrap'));
  if (!navigator.requestMIDIAccess) {
    setStatus('Web MIDI not supported — use Chrome, Edge, or Brave', true);
    return;
  }
  try {
    const outputs = await engine.init();
    engine.onDevicesChanged = refreshOutputs;
    refreshOutputs(outputs);
  } catch {
    setStatus('MIDI access denied — allow MIDI permission and reload', true);
  }
})();
