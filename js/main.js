import { loadState, saveState, defaultPattern, NUM_SLOTS } from './state.js';
import { MidiEngine } from './midi.js';
import { PianoRoll } from './pianoroll.js';

const $ = id => document.getElementById(id);

const state = loadState();
const pattern = () => state.patterns[state.current];
const persist = () => saveState(state);

const engine = new MidiEngine(() => ({
  pattern: pattern(),
  bpm: state.bpm,
  sendClock: state.sendClock,
  countIn: state.countIn,
}));

const roll = new PianoRoll($('roll'), {
  getPattern: pattern,
  getDefaultVelocity: () => state.defaultVelocity,
  onChange: persist,
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
for (const bars of [1, 2, 3, 4]) lenSel.add(new Option(`${bars} bar${bars > 1 ? 's' : ''}`, bars * 16));

const countSel = $('countin');
for (const bars of [0, 1, 2, 4]) countSel.add(new Option(bars === 0 ? 'Off' : `${bars} bar${bars > 1 ? 's' : ''}`, bars));

function syncToolbar() {
  slotSel.value = state.current;
  chanSel.value = pattern().channel;
  lenSel.value = pattern().lengthSteps;
  $('bpm').value = state.bpm;
  $('clock').checked = state.sendClock;
  countSel.value = state.countIn;
  $('velocity').value = state.defaultVelocity;
  $('velLabel').textContent = state.defaultVelocity;
}

slotSel.onchange = () => {
  if (engine.playing) togglePlay();
  state.current = +slotSel.value;
  roll.selected = null;
  syncToolbar();
  roll.resize();
  persist();
};
chanSel.onchange = () => { pattern().channel = +chanSel.value; persist(); };
lenSel.onchange = () => {
  const len = +lenSel.value;
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
$('clock').onchange = () => { state.sendClock = $('clock').checked; persist(); };
countSel.onchange = () => { state.countIn = +countSel.value; persist(); };
$('velocity').oninput = () => {
  state.defaultVelocity = +$('velocity').value;
  $('velLabel').textContent = state.defaultVelocity;
  const sel = pattern().notes.find(n => n.id === roll.selected);
  if (sel) { sel.velocity = state.defaultVelocity; roll.draw(); }
  persist();
};
$('clear').onclick = () => {
  if (!pattern().notes.length || confirm(`Clear all notes in ${pattern().name}?`)) {
    state.patterns[state.current] = { ...defaultPattern(state.current), channel: pattern().channel, lengthSteps: pattern().lengthSteps };
    roll.selected = null;
    roll.resize();
    persist();
  }
};
$('help').onclick = () => $('helpPanel').classList.toggle('hidden');

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
