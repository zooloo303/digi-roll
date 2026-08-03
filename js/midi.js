// Web MIDI engine: output management, lookahead scheduler, clock/transport send.
//
// Timing model: MIDIOutput.send() accepts a DOMHighResTimeStamp, so we run a
// coarse setInterval "pump" that schedules everything falling inside a small
// lookahead window with sample-accurate timestamps. Standard Web MIDI practice;
// jitter of the interval timer doesn't reach the wire.

const LOOKAHEAD_MS = 120;
const PUMP_MS = 25;

// Trig conditions in the browser preview.
//
// A deliberately partial simulation, and it says so in the UI. `prob` and the
// loop-counting conditions can be evaluated here honestly; the rest cannot,
// and guessing would be worse than not trying:
//
//   PRE / NEI  need the last evaluated condition on this or the neighbour
//              track — digi-roll plays one track at a time and keeps no such
//              history, so there is nothing to consult
//   LST        needs to know a pattern change is coming, which the browser
//              never knows
//   fill       there is no FILL button here
//
// Everything unsimulated plays, so the preview is never quieter than the box.
// `rng` is injected so the tests are deterministic.
//
// `trackProb` is the track-level PROB default, which a trig without its own
// PROB lock runs at — the hardware's two-level model, not a bulk stamp. 100
// (the box default) is indistinguishable from no probability at all.
export function shouldPlay(note, loop, rng = Math.random, trackProb = 100) {
  const prob = note.prob ?? trackProb;
  if (prob != null && rng() * 100 >= prob) return false;
  const cond = note.cond;
  if (!cond) return true;

  const negated = cond.startsWith('!');
  const key = negated ? cond.slice(1) : cond;

  let result;
  if (key === '1ST') result = loop === 0;
  else if (/^\d+:\d+$/.test(key)) {
    const [a, b] = key.split(':').map(Number);
    result = loop % b === a - 1;
  } else return true; // PRE, NEI, LST — not simulable, so never silenced

  return negated ? !result : result;
}

// Standard MIDI File export: type 0, 96 ticks per quarter (a 16th step = 24 ticks).
const TPQN = 96;
const TICKS_PER_STEP = TPQN / 4;

function vlq(n) {
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  return out;
}

function chunk(id, bytes) {
  const len = bytes.length;
  return [...id].map(c => c.charCodeAt(0))
    .concat([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], bytes);
}

// Swing and micro-timing are baked into the tick positions so the file sounds
// like the app does.
export function patternToMidiFile(pattern, bpm) {
  const swingTicks = (((pattern.swing ?? 50) - 50) / 50) * (TICKS_PER_STEP / 3);
  const ch = pattern.channel & 0x0f;
  const events = [];
  for (const n of pattern.notes) {
    const start = Math.max(0, Math.round((n.step + (n.micro ?? 0)) * TICKS_PER_STEP + (n.step % 2 ? swingTicks : 0)));
    const end = start + Math.max(1, Math.round(n.len * TICKS_PER_STEP));
    events.push({ tick: start, order: 1, data: [0x90 | ch, n.pitch & 0x7f, Math.max(1, Math.min(127, n.velocity))] });
    events.push({ tick: end, order: 0, data: [0x80 | ch, n.pitch & 0x7f, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order); // note-offs first on a shared tick

  const name = [...pattern.name].map(c => c.charCodeAt(0) & 0x7f);
  const uspq = Math.round(60000000 / bpm); // microseconds per quarter note
  const track = [0, 0xff, 0x03, ...vlq(name.length), ...name,
                 0, 0xff, 0x51, 0x03, (uspq >>> 16) & 255, (uspq >>> 8) & 255, uspq & 255];
  let t = 0;
  for (const e of events) {
    track.push(...vlq(e.tick - t), ...e.data);
    t = e.tick;
  }
  // Run the track out to the full pattern length so the loop keeps its bar count.
  track.push(...vlq(Math.max(0, pattern.lengthSteps * TICKS_PER_STEP - t)), 0xff, 0x2f, 0x00);

  return new Uint8Array([
    ...chunk('MThd', [0, 0, 0, 1, (TPQN >>> 8) & 255, TPQN & 255]),
    ...chunk('MTrk', track),
  ]);
}

// Import: parse a type 0/1 SMF and take the first track that has notes, mapped
// onto the 16th grid — whatever doesn't land on a step becomes micro-timing.
export function midiFileToNotes(bytes, maxSteps = 128) {
  let i = 0;
  const tag = () => String.fromCharCode(bytes[i++], bytes[i++], bytes[i++], bytes[i++]);
  const u16 = () => (bytes[i++] << 8) | bytes[i++];
  const u32 = () => ((bytes[i++] << 24) | (bytes[i++] << 16) | (bytes[i++] << 8) | bytes[i++]) >>> 0;
  const vlen = () => { let v = 0, b; do { b = bytes[i++]; v = v * 128 + (b & 0x7f); } while (b & 0x80); return v; };
  const skip = () => { const n = vlen(); i += n; }; // never write `i += vlen()`: i is read before vlen() moves it

  if (bytes.length < 14 || tag() !== 'MThd') throw new Error('not a MIDI file');
  const headerLen = u32();
  u16(); // format: 0 and 1 are handled the same way here
  const ntrks = u16();
  const division = u16();
  i += headerLen - 6;
  if (division & 0x8000) throw new Error('SMPTE-timecode files are not supported');
  const per16 = division / 4;

  let found = null;
  for (let t = 0; t < ntrks && i < bytes.length && !found; t++) {
    const id = tag();
    const trackLen = u32();
    const end = i + trackLen;
    if (id !== 'MTrk') { i = end; continue; }
    const notes = [], open = new Map();
    let tick = 0, status = 0;
    while (i < end) {
      tick += vlen();
      let s = bytes[i];
      if (s & 0x80) { status = s; i++; } else s = status;
      if (s === 0xff) { i++; skip(); status = 0; }              // meta
      else if (s === 0xf0 || s === 0xf7) { skip(); status = 0; } // sysex
      else {
        const hi = s & 0xf0;
        const d1 = bytes[i++];
        const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : bytes[i++];
        if (hi === 0x90 && d2 > 0) open.set(d1, { tick, vel: d2 });
        else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
          const o = open.get(d1);
          if (o) { open.delete(d1); notes.push({ on: o.tick, off: tick, pitch: d1, vel: o.vel }); }
        }
      }
    }
    i = end;
    for (const [pitch, o] of open) notes.push({ on: o.tick, off: o.tick + per16, pitch, vel: o.vel }); // never released
    if (notes.length) found = notes;
  }
  if (!found) return { notes: [], lengthSteps: 16 };

  const out = [];
  for (const n of found.sort((a, b) => a.on - b.on)) {
    const f = n.on / per16;
    const step = Math.round(f);
    if (step < 0 || step >= maxSteps) continue; // past 4 bars: dropped
    out.push({
      step,
      pitch: n.pitch,
      len: Math.max(1, Math.round((n.off - n.on) / per16)),
      velocity: Math.max(1, Math.min(127, n.vel)),
      micro: Math.max(-0.49, Math.min(0.49, f - step)),
    });
  }
  const maxStep = out.reduce((m, n) => Math.max(m, n.step), 0);
  const lengthSteps = Math.min(maxSteps, Math.max(16, (Math.floor(maxStep / 16) + 1) * 16));
  for (const n of out) n.len = Math.min(n.len, lengthSteps - n.step);
  return { notes: out, lengthSteps, dropped: found.length - out.length };
}

export class MidiEngine {
  constructor(getState, { rng = Math.random } = {}) {
    this.getState = getState; // () => { pattern, bpm, sendClock }
    this.rng = rng;           // injectable so trig probability is testable
    this.access = null;
    this.output = null;
    this.playing = false;
    this._pump = null;
    this._activeNotes = new Set(); // "channel:pitch" currently sounding
    this.onDevicesChanged = null;
  }

  async init() {
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => this.onDevicesChanged?.(this.listOutputs());
    return this.listOutputs();
  }

  listOutputs() {
    if (!this.access) return [];
    return [...this.access.outputs.values()].map(o => ({ id: o.id, name: o.name }));
  }

  setOutput(id) {
    if (this.playing) this.stop();
    this.output = this.access?.outputs.get(id) ?? null;
    return !!this.output;
  }

  _send(data, time) {
    try { this.output?.send(data, time); } catch { /* device unplugged mid-send */ }
  }

  noteOn(ch, pitch, vel, time) {
    this._send([0x90 | ch, pitch, vel], time);
    this._activeNotes.add(`${ch}:${pitch}`);
  }

  noteOff(ch, pitch, time) {
    this._send([0x80 | ch, pitch, 0], time);
    this._activeNotes.delete(`${ch}:${pitch}`);
  }

  // Short immediate note for auditioning edits in the piano roll.
  audition(ch, pitch, vel, ms = 180) {
    if (!this.output) return;
    const now = performance.now();
    this.noteOn(ch, pitch, vel, now);
    this._send([0x80 | ch, pitch, 0], now + ms);
  }

  allNotesOff() {
    const now = performance.now();
    for (const key of this._activeNotes) {
      const [ch, pitch] = key.split(':').map(Number);
      this._send([0x80 | ch, pitch, 0], now);
    }
    this._activeNotes.clear();
    for (let ch = 0; ch < 16; ch++) this._send([0xB0 | ch, 123, 0], now); // All Notes Off
  }

  start() {
    if (this.playing || !this.output) return;
    this.playing = true;
    const { sendClock, countIn } = this.getState();
    const now = performance.now() + 50; // small offset so the first events aren't in the past
    this._startTime = now;
    this._step = -(countIn ?? 0) * 16; // negative steps = count-in, no notes sent
    this._nextStepTime = now;
    this._nextClockTime = now;
    if (sendClock) {
      // Stop first: if the box is already running (e.g. slaved to another
      // master moments ago), Stop → Start forces a clean restart at step 1.
      this._send([0xFC], now - 30);
      this._send([0xFA], now - 1); // MIDI Start
    }
    this._pump = setInterval(() => this._schedule(), PUMP_MS);
    this._schedule();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this._pump);
    this._pump = null;
    if (this.getState().sendClock) this._send([0xFC], performance.now()); // MIDI Stop
    this.allNotesOff();
  }

  _schedule() {
    const { pattern, bpm, sendClock } = this.getState();
    const stepMs = (60000 / bpm) / 4;   // 16th note
    const clockMs = (60000 / bpm) / 24; // 24 ppqn
    const horizon = performance.now() + LOOKAHEAD_MS;

    if (sendClock) {
      while (this._nextClockTime < horizon) {
        this._send([0xF8], this._nextClockTime);
        this._nextClockTime += clockMs;
      }
    } else {
      this._nextClockTime = horizon; // keep aligned in case it's re-enabled
    }

    // Swing pushes odd 16ths later; at 66% the odd step lands 2/3 through the pair.
    const swing = pattern.swing ?? 50;

    while (this._nextStepTime < horizon) {
      const stepInPattern = this._step >= 0 ? this._step % pattern.lengthSteps : -1;
      const loop = this._step >= 0 ? Math.floor(this._step / pattern.lengthSteps) : 0;
      const swingMs = stepInPattern % 2 === 1 ? ((swing - 50) / 50) * (stepMs / 3) : 0;
      for (const n of pattern.notes) {
        if (n.step !== stepInPattern) continue;
        if (!shouldPlay(n, loop, this.rng, pattern.trackProb)) continue;
        const t = this._nextStepTime + swingMs + (n.micro ?? 0) * stepMs;
        this.noteOn(pattern.channel, n.pitch, n.velocity, t);
        // End slightly early so back-to-back notes retrigger cleanly — but
        // never before the note-on: a 0.125-step note at a fast tempo is
        // shorter than the 8 ms gap.
        this._send([0x80 | pattern.channel, n.pitch, 0], t + Math.max(1, n.len * stepMs - 8));
      }
      this._step++;
      this._nextStepTime += stepMs;
      this._stepMs = stepMs;
    }
  }

  // Approximate playhead position (in pattern steps) for UI drawing.
  playheadStep() {
    if (!this.playing || !this._stepMs) return null;
    const { pattern } = this.getState();
    const ahead = (this._nextStepTime - performance.now()) / this._stepMs;
    const pos = this._step - ahead;
    return pos < 0 ? null : pos % pattern.lengthSteps;
  }
}
