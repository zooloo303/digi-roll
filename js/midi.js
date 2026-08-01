// Web MIDI engine: output management, lookahead scheduler, clock/transport send.
//
// Timing model: MIDIOutput.send() accepts a DOMHighResTimeStamp, so we run a
// coarse setInterval "pump" that schedules everything falling inside a small
// lookahead window with sample-accurate timestamps. Standard Web MIDI practice;
// jitter of the interval timer doesn't reach the wire.

const LOOKAHEAD_MS = 120;
const PUMP_MS = 25;

export class MidiEngine {
  constructor(getState) {
    this.getState = getState; // () => { pattern, bpm, sendClock }
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

    while (this._nextStepTime < horizon) {
      const stepInPattern = this._step >= 0 ? this._step % pattern.lengthSteps : -1;
      for (const n of pattern.notes) {
        if (n.step !== stepInPattern) continue;
        const t = this._nextStepTime;
        this.noteOn(pattern.channel, n.pitch, n.velocity, t);
        // End slightly early so back-to-back notes retrigger cleanly.
        this._send([0x80 | pattern.channel, n.pitch, 0], t + n.len * stepMs - 8);
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
