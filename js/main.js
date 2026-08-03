import { loadState, saveState, defaultPattern, makeNote, NUM_SLOTS } from './state.js';
import { MidiEngine, patternToMidiFile, midiFileToNotes } from './midi.js';
import { PianoRoll, SCALES, PITCH_CLASSES, PITCH_MIN, PITCH_MAX } from './pianoroll.js';
import { chordPitches, voiceChord, QUALITIES } from './chords.js';
import { ElektronDevice } from './elektron/device.js';
import { safeWriteTrack, writeGate, writeResultMessage } from './elektron/safe-write.js';
import { trackNotes, trackTrigCount, bankName } from './elektron/pattern-core.js';
import * as dt2 from './elektron/dt2/pattern.js';
import * as dn2 from './elektron/dn2/pattern.js';
import {
  rollNotesToDevice, deviceNotesToRoll, rollLengthForTrack,
  makeSource, sourceLabel, sourceMatchesIdentity, attachTrigSettings,
} from './roll-bridge.js';
import { readTrackTrigSettings } from './elektron/trig-cond.js';
import { downloadBytes, downloadText } from './download.js';
import {
  BANK_PREFIX, listBank, bankEntry, saveToBank, loadFromBank, deleteFromBank,
  renameInBank, exportBank, parseBankFile, importBank,
} from './bank.js';

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

// --- Chord draw --------------------------------------------------------------
// The pitch math is js/chords.js; this closes it over the toolbar settings.
// 'auto' quality means diatonic when the scale menu has a scale, so what you
// stamp always agrees with the tinted rows.

const STRUM_STEP = 0.12; // per-note micro stagger at Strum = 100

function chordSpecs(rootPitch, velocity, taper = true) {
  const c = state.chord;
  const diatonic = c.quality === 'auto' && state.scale !== 'off';
  const pitches = chordPitches(rootPitch, {
    scale: diatonic ? { root: state.scaleRoot, intervals: SCALES[state.scale] } : null,
    quality: c.quality === 'auto' ? 'Major' : c.quality,
    seventh: c.seventh,
    inversion: c.inversion,
    spread: c.spread,
    min: PITCH_MIN,
    max: PITCH_MAX,
  });
  return voiceChord(pitches, { velocity, strum: c.strum / 100 * STRUM_STEP, taper });
}

const roll = new PianoRoll($('roll'), {
  getPattern: pattern,
  getDefaultVelocity: () => state.defaultVelocity,
  onChange: () => { dropUnchangedUndo(); persist(); },
  onBeforeEdit: pushUndo,
  getScale: () => state.scale === 'off' ? null : { root: state.scaleRoot, set: new Set(SCALES[state.scale]) },
  getChord: pitch => state.chord.on ? chordSpecs(pitch, state.defaultVelocity) : null,
  onChordWheel: dir => {
    if (!state.chord.on) return false;
    state.chord.inversion = (state.chord.inversion + dir + 4) % 4;
    $('chordInv').value = state.chord.inversion;
    roll.draw();
    persist();
    return true;
  },
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
scaleSel.add(new Option('Off', 'off'));
for (const name of Object.keys(SCALES)) scaleSel.add(new Option(name, name));

const chordQualSel = $('chordQuality');
chordQualSel.add(new Option('In scale', 'auto'));
for (const name of Object.keys(QUALITIES)) chordQualSel.add(new Option(name, name));

const chordInvSel = $('chordInv');
['Root pos', '1st inv', '2nd inv', '3rd inv'].forEach((label, i) => chordInvSel.add(new Option(label, i)));

// --- Side panels -------------------------------------------------------------
// The rail is the whole settings surface: one icon per group, one panel open at
// a time (click the active icon, or the panel's ×, to get the width back). The
// open panel is remembered so a reload drops you where you were.

const railBtns = [...$('rail').querySelectorAll('button')];

// Panels that need to catch up on state they don't otherwise track.
const onPanelOpen = {
  bankPanel: () => {
    refreshBank();
    if (!$('bankName').value) $('bankName').value = pattern().name;
  },
};

function showPanel(id) {
  for (const btn of railBtns) {
    const target = btn.dataset.panel;
    const on = target === id;
    btn.classList.toggle('active', on);
    $(target).classList.toggle('hidden', !on);
  }
  state.panel = id;
  persist();
  if (id) onPanelOpen[id]?.();
}

// A dot on the rail icon for things that are armed while the panel is shut.
function railFlag(panelId, on) {
  railBtns.find(b => b.dataset.panel === panelId)?.classList.toggle('flag', on);
}

for (const btn of railBtns) {
  btn.onclick = () => showPanel(btn.classList.contains('active') ? null : btn.dataset.panel);
}
for (const x of document.querySelectorAll('.panel h2 .x')) x.onclick = () => showPanel(null);

// Clock + count-in live in a popover off the transport bar — set once, then
// out of the way.
$('sync').onclick = () => {
  const open = $('syncPop').classList.toggle('hidden');
  $('sync').classList.toggle('active', !open);
};
document.addEventListener('click', e => {
  if (!e.target.closest('.syncwrap') && !$('syncPop').classList.contains('hidden')) {
    $('syncPop').classList.add('hidden');
    $('sync').classList.remove('active');
  }
});

function syncToolbar() {
  // Slot labels follow pattern names, so imports from the box ("A01 T11") are
  // recognizable in the dropdown.
  for (let i = 0; i < NUM_SLOTS; i++) slotSel.options[i].text = state.patterns[i].name;
  slotSel.value = state.current;
  chanSel.value = pattern().channel;
  lenSel.value = pattern().lengthSteps;
  $('bpm').value = state.bpm;
  $('swing').value = pattern().swing ?? 50;
  $('clock').checked = state.sendClock;
  countSel.value = state.countIn;
  rootSel.value = state.scaleRoot;
  scaleSel.value = state.scale;
  $('chordMode').classList.toggle('active', state.chord.on);
  chordQualSel.value = state.chord.quality;
  $('chordSeventh').checked = state.chord.seventh;
  chordInvSel.value = state.chord.inversion;
  $('chordSpread').checked = state.chord.spread;
  $('chordStrum').value = state.chord.strum;
  $('velocity').value = state.defaultVelocity;
  $('velLabel').textContent = state.defaultVelocity;
  railFlag('harmonyPanel', state.chord.on);
  syncSend();
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
// Chord controls redraw the roll so the ghost preview tracks them live.
$('chordMode').onclick = () => {
  state.chord.on = !state.chord.on;
  $('chordMode').classList.toggle('active', state.chord.on);
  railFlag('harmonyPanel', state.chord.on);
  roll.draw();
  persist();
};
chordQualSel.onchange = () => { state.chord.quality = chordQualSel.value; roll.draw(); persist(); };
$('chordSeventh').onchange = () => { state.chord.seventh = $('chordSeventh').checked; roll.draw(); persist(); };
chordInvSel.onchange = () => { state.chord.inversion = +chordInvSel.value; roll.draw(); persist(); };
$('chordSpread').onchange = () => { state.chord.spread = $('chordSpread').checked; roll.draw(); persist(); };
$('chordStrum').oninput = () => { state.chord.strum = +$('chordStrum').value; roll.draw(); persist(); };

// Build a chord under each selected note. The melody notes are left exactly
// as drawn; added notes inherit their note's length and micro-timing (plus
// strum stagger) and come in softer so the line stays on top.
$('harmonize').onclick = () => {
  const sel = roll.selectedNotes();
  if (!sel.length) { setStatus('Select some notes to harmonize first', true); return; }
  pushUndo();
  const p = pattern();
  const added = [];
  for (const note of sel) {
    const specs = chordSpecs(note.pitch, note.velocity, false);
    for (const s of specs) {
      if (s.pitch === note.pitch) continue;
      if (p.notes.some(x => x.step === note.step && x.pitch === s.pitch)) continue;
      const micro = Math.max(-0.49, Math.min(0.49, (note.micro ?? 0) + s.micro));
      added.push(makeNote(note.step, s.pitch, note.len, Math.max(1, Math.round(note.velocity * 0.85)), micro));
    }
  }
  p.notes.push(...added);
  roll.setSelection([...roll.selected, ...added.map(n => n.id)]);
  roll.draw();
  dropUnchangedUndo();
  persist();
  setStatus(added.length
    ? `Harmonized ${sel.length} note${sel.length === 1 ? '' : 's'} — added ${added.length}`
    : 'Nothing to add — those chords are already there', !added.length);
};
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
    // Provenance survives a clear: emptying an imported slot and writing it
    // back is how you erase that track on the box.
    state.patterns[state.current] = {
      ...defaultPattern(state.current),
      channel: pattern().channel, lengthSteps: pattern().lengthSteps,
      swing: pattern().swing, source: pattern().source,
    };
    roll.clearSelection();
    syncToolbar();
    roll.resize();
    persist();
  }
};
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
    p.source = null; // these notes came from a file, not from a box track
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

// --- Pattern bank ------------------------------------------------------------------
// Named saves in localStorage, one key per pattern (js/bank.js). Eight slots is
// plenty to work in and nowhere near enough to keep ideas in.

function selectedBankName() {
  return $('bankList').value || null;
}

function refreshBank(keepSelection = selectedBankName()) {
  const list = $('bankList');
  list.innerHTML = '';
  for (const name of listBank()) list.add(new Option(name, name));
  if (keepSelection && [...list.options].some(o => o.value === keepSelection)) list.value = keepSelection;
  else list.value = '';
  syncBankButtons();
}

function syncBankButtons() {
  const name = selectedBankName();
  for (const id of ['bankLoad', 'bankRename', 'bankDelete']) $(id).disabled = !name;
  if (!name) { $('bankInfo').textContent = listBank().length ? 'Pick a saved pattern.' : 'Nothing saved yet — name the pattern you\'re editing and hit Save.'; return; }
  const entry = bankEntry(name);
  if (!entry?.pattern) { $('bankInfo').textContent = `“${name}” is unreadable — delete it.`; return; }
  const p = entry.pattern;
  const saved = (entry.savedAt || '').slice(0, 16).replace('T', ' ');
  $('bankInfo').textContent =
    `“${p.name}” · ${p.notes.length} note${p.notes.length === 1 ? '' : 's'} · ${p.lengthSteps / 16} bar${p.lengthSteps === 16 ? '' : 's'}` +
    ` · swing ${p.swing} · ch ${p.channel + 1}` +
    (p.source ? ` · from ${sourceLabel(p.source)}` : '') +
    (saved ? ` · saved ${saved}` : '');
}

$('bankList').onchange = () => {
  syncBankButtons();
  $('bankName').value = selectedBankName() ?? $('bankName').value;
};
$('bankList').ondblclick = () => $('bankLoad').click();

$('bankSave').onclick = () => {
  const name = ($('bankName').value || pattern().name).trim();
  if (!name) { setStatus('Give the pattern a name before saving', true); return; }
  if (bankEntry(name) && !confirm(`“${name}” is already in the bank. Overwrite it?`)) return;
  try {
    saveToBank(name, pattern());
    refreshBank(name);
    setStatus(`Saved “${name}” to the bank`);
  } catch (err) {
    setStatus(`Couldn't save: ${err.message}`, true);
  }
};

$('bankLoad').onclick = () => {
  const name = selectedBankName();
  if (!name) return;
  try {
    const loaded = loadFromBank(name, makeNote);
    pushUndo();
    state.patterns[state.current] = loaded;
    roll.clearSelection();
    syncToolbar();
    roll.resize();
    persist();
    setStatus(`Loaded “${name}” into slot ${state.current + 1}` +
      ` — ${loaded.notes.length} note${loaded.notes.length === 1 ? '' : 's'}` +
      (loaded.source ? `, from ${sourceLabel(loaded.source)}` : ''));
  } catch (err) {
    setStatus(`Couldn't load “${name}”: ${err.message}`, true);
  }
};

$('bankRename').onclick = () => {
  const name = selectedBankName();
  if (!name) return;
  const to = ($('bankName').value || '').trim();
  if (!to || to === name) { setStatus('Type the new name in the box first', true); return; }
  if (bankEntry(to) && !confirm(`“${to}” already exists. Overwrite it?`)) return;
  try {
    renameInBank(name, to);
    refreshBank(to);
    setStatus(`Renamed “${name}” → “${to}”`);
  } catch (err) {
    setStatus(`Couldn't rename: ${err.message}`, true);
  }
};

$('bankDelete').onclick = () => {
  const name = selectedBankName();
  if (!name || !confirm(`Delete “${name}” from the bank? This can't be undone.`)) return;
  deleteFromBank(name);
  refreshBank(null);
  setStatus(`Deleted “${name}”`);
};

$('bankExport').onclick = () => {
  const one = selectedBankName();
  const names = one ? [one] : listBank();
  if (!names.length) { setStatus('Nothing in the bank to export', true); return; }
  const file = one ? `${one.replace(/[^\w -]+/g, '') || 'pattern'}.json` : 'digi-roll-bank.json';
  downloadText(file, exportBank(names));
  setStatus(`Exported ${names.length} pattern${names.length === 1 ? '' : 's'} to ${file}`);
};

$('bankImport').onclick = () => $('bankFile').click();
$('bankFile').onchange = async () => {
  const file = $('bankFile').files[0];
  if (!file) return;
  try {
    const added = importBank(parseBankFile(await file.text()));
    refreshBank(added[0] ?? null);
    setStatus(`Imported ${added.length} pattern${added.length === 1 ? '' : 's'} from ${file.name}: ${added.join(', ')}`);
  } catch (err) {
    setStatus(`Couldn't import ${file.name}: ${err.message}`, true);
  }
  $('bankFile').value = '';
};

// Another tab saving to the bank shouldn't leave this list stale.
window.addEventListener('storage', e => {
  if (e.key?.startsWith(BANK_PREFIX) && !$('bankPanel').classList.contains('hidden')) refreshBank();
});

// --- Send to box -------------------------------------------------------------
// The write half of both everyday journeys, and deliberately one control for
// both: draw a fresh pattern and send it to any pattern/track, or import a
// track, edit it, and send it home. "Write back" is just this with the
// destination pre-filled from where the pattern came from — nobody should have
// to visit the device console to get notes onto the box.
//
// The heavy lifting (re-fetch, backup, encode, write, verify) is
// js/elektron/safe-write.js — the same flow the console's Phase 2 write button
// runs, so every write from this page is backed up and byte-verified.
//
// This page normally holds sysex-free MIDI access on purpose, so the everyday
// piano roll never triggers the scarier browser permission prompt. Sending
// asks for SysEx access lazily, the first time you actually use it.

let sysexAccess = null;
let box = null;          // ElektronDevice, once identified
let sending = false;

// Both boxes digi-roll writes to have 16 tracks; the destination picker is
// filled once, and the real track names/kinds are reported in the confirm
// dialog after the pattern is re-fetched.
const NUM_DEVICE_TRACKS = 16;

// Patterns digi-roll can decode, by identity slug.
const DECODERS = { digitakt2: dt2, digitone2: dn2 };

// Connect to whatever box the MIDI output menu points at and identify it.
// Shared by import and write-back; each caller adds its own checks on top.
async function connectBox() {
  if (!navigator.requestMIDIAccess) throw new Error('Web MIDI not supported — use Chrome, Edge, or Brave');
  sysexAccess ??= await navigator.requestMIDIAccess({ sysex: true });
  const inputs = [...sysexAccess.inputs.values()];
  const pairs = [...sysexAccess.outputs.values()]
    .map(out => ({ out, in: inputs.find(i => i.name === out.name) }))
    .filter(p => p.in);
  if (!pairs.length) throw new Error('No two-way MIDI device found — plug the box in over USB');

  const chosen = outSel.options[outSel.selectedIndex]?.text;
  const pair = pairs.find(p => p.out.name === chosen) ?? (pairs.length === 1 ? pairs[0] : null);
  if (!pair) throw new Error('Pick your box in the MIDI output menu first');

  box?.close();
  box = new ElektronDevice(pair.in, pair.out);
  return box.identify();
}

const dstPatSel = $('dstPattern'), dstTrkSel = $('dstTrack');
for (let i = 0; i < 128; i++) dstPatSel.add(new Option(bankName(i), i));
for (let t = 0; t < NUM_DEVICE_TRACKS; t++) dstTrkSel.add(new Option(`T${t + 1}`, t));

// Where this slot's Send button is aimed. An imported pattern starts aimed at
// where it came from; a freshly drawn one at wherever you last sent something.
// Resolved lazily and then kept on the pattern, so re-syncing the toolbar can
// never quietly re-aim a destination you picked by hand.
function destFor(p) {
  p.dest ??= p.source
    ? { patternIndex: p.source.patternIndex, trackIndex: p.source.trackIndex }
    : { ...state.sendTarget };
  return p.dest;
}

const sameSlot = (dest, src) =>
  !!src && dest.patternIndex === src.patternIndex && dest.trackIndex === src.trackIndex;

const destLabel = dest => `${bankName(dest.patternIndex)} T${dest.trackIndex + 1}`;

function syncSend() {
  const p = pattern();
  const src = p.source;
  const dest = destFor(p);
  dstPatSel.value = dest.patternIndex;
  dstTrkSel.value = dest.trackIndex;

  // Same place it came from = "write back"; anywhere else = a plain send, and
  // the hint spells out that it isn't going home.
  const home = sameSlot(dest, src);
  const btn = $('sendToBox');
  btn.disabled = sending;
  btn.textContent = `${home ? 'Write back' : 'Send'} → ${destLabel(dest)}`;
  btn.title = home
    ? `Re-fetch ${sourceLabel(src)} from the box, replace that track's notes with this pattern, and verify. A backup downloads first.`
    : `Replace the notes on ${destLabel(dest)} with this pattern, on the box picked in the MIDI output menu. `
      + 'The pattern is re-read and backed up first, and verified byte for byte afterwards.';
  $('sourceInfo').textContent = !src ? ''
    : home ? `from ${sourceLabel(src)}` : `from ${sourceLabel(src)} — sending elsewhere`;
  railFlag('boxPanel', !!src);
}

// Picking a destination by hand sticks to this slot, and becomes the default
// for the next pattern that has never been near a box.
function onDestChange() {
  const dest = destFor(pattern());
  dest.patternIndex = +dstPatSel.value;
  dest.trackIndex = +dstTrkSel.value;
  state.sendTarget = { ...dest };
  persist();
  syncSend();
}
dstPatSel.onchange = onDestChange;
dstTrkSel.onchange = onDestChange;

// Connect, then check we may write here. Writing to the slot a pattern was
// imported from is held to the stricter rule: it must be the same box, because
// putting a Digitone pattern into a Digitakt slot by accident is exactly the
// mistake provenance exists to prevent. Deliberately aiming somewhere else is
// allowed — the confirm dialog says whose pattern is going where.
async function connectForSend(src, home) {
  const id = await connectBox();
  if (home && !sourceMatchesIdentity(src, id)) {
    throw new Error(`this pattern came from a ${src.deviceName || src.slug}, but the connected box says it's a ${id.name} — refusing to write`);
  }
  const gate = writeGate(id);
  if (!gate.ok) throw new Error(gate.reason);
  return id;
}

// What the destination track is called on the box: MIDI tracks say so, sample/
// synth tracks give their sound name.
function trackKindLabel(patternKit, trackIndex, kindFallback) {
  return patternKit.kit.midiMask & (1 << trackIndex)
    ? 'MIDI'
    : patternKit.kit.soundNames[trackIndex] || kindFallback;
}

$('sendToBox').onclick = async () => {
  const p = pattern();
  const src = p.source;
  const dest = { ...destFor(p) };
  if (sending) return;
  sending = true;
  syncSend();
  try {
    setStatus('Looking for the box…');
    const id = await connectForSend(src, sameSlot(dest, src));
    const result = await safeWriteTrack(box, {
      index: dest.patternIndex,
      trackIndex: dest.trackIndex,
      notes: rollNotesToDevice(p.notes),
      onStatus: setStatus,
      onBackup: b => downloadBytes(b.name, b.bytes),
      confirm: ({ label, existingTrigs, patternKit }) => {
        const track = patternKit.tracks[dest.trackIndex];
        const kind = trackKindLabel(patternKit, dest.trackIndex, DECODERS[id.slug].SPEC.trackKindFallback);
        const lines = [
          `Send ${p.notes.length} note${p.notes.length === 1 ? '' : 's'} from “${p.name}” to `
          + `${label}${patternKit.name ? ` “${patternKit.name}”` : ''} track ${dest.trackIndex + 1}`
          + `${kind ? ` (${kind})` : ''} on the ${id.name}?`,
          '',
          existingTrigs
            ? `This replaces the ${existingTrigs} trig${existingTrigs === 1 ? '' : 's'} already on that track.`
            : 'That track is currently empty.',
        ];
        // The write never changes a track's length, so a pattern longer than
        // the track it lands on is stored in full but only heard as far as the
        // box's own LEN. Better said here than discovered on playback.
        if (track.lengthSteps < p.lengthSteps) {
          lines.push(`That track is ${track.lengthSteps} steps long and this pattern is ${p.lengthSteps} — `
            + `the rest is stored but won't play until you raise the track's LEN on the box.`);
        }
        if (src && !sourceMatchesIdentity(src, id)) {
          lines.push(`Note: this pattern came from a ${src.deviceName || src.slug}.`);
        }
        lines.push('', 'A backup of the whole destination pattern downloads first.');
        return window.confirm(lines.join('\n'));
      },
    });
    const { text, isError } = writeResultMessage(result);
    setStatus(text, isError);
    if (isError) window.alert(text); // rule 4: a verify mismatch must never be quiet
    if (result.ok) {
      // The pattern now lives on the box at the place it was just sent, so
      // that becomes its home: the next send is a write-back to here.
      p.source = makeSource({
        slug: id.slug, productId: id.productId, deviceName: id.name,
        patternIndex: dest.patternIndex, trackIndex: dest.trackIndex, origin: 'sent',
      });
      persist();
    }
  } catch (err) {
    setStatus(`Send failed: ${err.message}`, true);
  } finally {
    sending = false;
    syncSend();
  }
};

// --- Import from box ---------------------------------------------------------
// The other half of the round trip, right where the editing happens: fetch a
// pattern from the box (read-only), pick a track, and its notes replace the
// slot you're editing — with provenance, which aims Send to box straight back
// at where it came from. The console page keeps the long-form version (import
// into any slot, .syx files, cross-device copy); this is the everyday path.

let fetched = null; // { patternKit, payload, spec, label, kindFallback, origin } once decoded

for (let i = 0; i < 128; i++) $('impPattern').add(new Option(bankName(i), i));

$('impFetch').onclick = async () => {
  const index = +$('impPattern').value;
  $('impFetch').disabled = true;
  try {
    setStatus('Looking for the box…');
    const id = await connectBox();
    const decoder = DECODERS[id.slug];
    if (!decoder) throw new Error(`${id.name} isn't a box digi-roll can decode patterns from yet`);
    setStatus(`Fetching ${bankName(index)} from the ${id.name}…`);
    // Keep the raw payload: the per-trig condition lanes are read straight off
    // it at import time (decodePatternKit doesn't carry them).
    const payload = await box.fetchPatternKit(index);
    const patternKit = decoder.decodePatternKit(payload);
    fetched = {
      patternKit,
      payload,
      spec: decoder.SPEC,
      label: bankName(index),
      kindFallback: decoder.SPEC.trackKindFallback,
      origin: { slug: id.slug, productId: id.productId, deviceName: id.name, patternIndex: index, origin: 'box' },
    };
    $('impInfo').textContent =
      `${id.name} · ${fetched.label}${patternKit.name ? ` “${patternKit.name}”` : ''} · ${patternKit.tempoBpm} BPM`;
    const any = fillImportTracks(patternKit, fetched.kindFallback);
    $('impGo').disabled = !any;
    setStatus(any
      ? `Fetched ${fetched.label} — pick a track, then Import into this slot`
      : `Fetched ${fetched.label}, but no track has any trigs`, !any);
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, true);
  } finally {
    $('impFetch').disabled = false;
  }
};

// "T3 · A_303_INNIT · 4 trigs" per track; empty tracks are shown but disabled.
function fillImportTracks(patternKit, kindFallback) {
  const sel = $('impTrack');
  sel.innerHTML = '';
  for (let t = 0; t < patternKit.tracks.length; t++) {
    const kind = patternKit.kit.midiMask & (1 << t) ? 'MIDI' : patternKit.kit.soundNames[t] || kindFallback;
    const trigs = trackTrigCount(patternKit, t);
    sel.add(new Option(`T${t + 1} · ${kind} · ${trigs} trig${trigs === 1 ? '' : 's'}`, t));
    if (trigs === 0) sel.options[t].disabled = true;
  }
  const first = [...sel.options].find(o => !o.disabled);
  if (first) sel.value = first.value;
  sel.disabled = !first;
  return !!first;
}

$('impGo').onclick = () => {
  if (!fetched) return;
  const t = +$('impTrack').value;
  const track = fetched.patternKit.tracks[t];
  const lengthSteps = rollLengthForTrack(track);
  const notes = attachTrigSettings(
    trackNotes(fetched.patternKit, t).filter(n => n.step < track.lengthSteps),
    readTrackTrigSettings(fetched.spec, fetched.payload, t),
  );

  pushUndo();
  const p = pattern();
  p.name = `${fetched.label} T${t + 1}`;
  p.lengthSteps = lengthSteps;
  p.notes = deviceNotesToRoll(notes, lengthSteps);
  p.source = makeSource({ ...fetched.origin, trackIndex: t, patternName: fetched.patternKit.name });
  // Aim Send at where these notes came from, overriding any target this slot
  // was carrying — an import is a fresh start for the slot.
  p.dest = { patternIndex: p.source.patternIndex, trackIndex: t };
  roll.clearSelection();
  syncToolbar();
  roll.resize();
  persist();
  setStatus(`Imported ${notes.length} note${notes.length === 1 ? '' : 's'} from ${fetched.label} T${t + 1} — edit away, Send writes it home (undo to get the old slot back)`);
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

// The device console page (console.html) writes imported patterns into the same
// localStorage state. If this tab stays open across an import, pick the change
// up instead of clobbering it with our stale in-memory copy on the next edit.
window.addEventListener('storage', e => {
  if (e.key !== 'digiroll-v1' || roll.drag) return;
  Object.assign(state, loadState());
  roll.clearSelection();
  syncToolbar();
  roll.resize();
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
  el.title = msg; // the top bar truncates; the full message stays on hover
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
  showPanel(state.panel && $(state.panel) ? state.panel : null);
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
