// Canvas piano roll editor.
//
// Interactions:
//   click/drag on empty cell  -> create note, drag right to set length
//   drag note body            -> move (pitch + step)
//   drag note's right edge    -> resize
//   shift+drag on note        -> velocity (up = harder)
//   right-click (or alt+click) on note -> delete
//   Delete/Backspace          -> delete selected note

import { makeNote } from './state.js';

const PITCH_MAX = 96; // C7
const PITCH_MIN = 24; // C1
const ROWS = PITCH_MAX - PITCH_MIN + 1;
const CELL_H = 16;
const CELL_W = 34;
const KEY_W = 52;
const EDGE_PX = 7;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);

export function noteName(pitch) {
  return NAMES[pitch % 12] + (Math.floor(pitch / 12) - 1); // C4 = 60
}

export class PianoRoll {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getPattern = opts.getPattern;         // () => pattern
    this.getDefaultVelocity = opts.getDefaultVelocity;
    this.onChange = opts.onChange;             // notes edited (persist)
    this.onPreview = opts.onPreview;           // (pitch, velocity) audition
    this.onSelect = opts.onSelect;             // (note) selection / velocity changed
    this.selected = null;
    this.drag = null;
    this.playhead = null;

    canvas.addEventListener('mousedown', e => this._down(e));
    window.addEventListener('mousemove', e => this._move(e));
    window.addEventListener('mouseup', () => this._up());
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', e => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected != null) {
        const p = this.getPattern();
        p.notes = p.notes.filter(n => n.id !== this.selected);
        this.selected = null;
        this.onChange();
        this.draw();
      }
    });
    this.resize();
  }

  resize() {
    const p = this.getPattern();
    const w = KEY_W + p.lengthSteps * CELL_W;
    const h = ROWS * CELL_H;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  scrollToCenter(container, pitch = 60) {
    container.scrollTop = (PITCH_MAX - pitch) * CELL_H - container.clientHeight / 2;
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left - KEY_W;
    const y = e.clientY - r.top;
    const p = this.getPattern();
    const step = Math.floor(x / CELL_W);
    const pitch = PITCH_MAX - Math.floor(y / CELL_H);
    const inGrid = x >= 0 && step < p.lengthSteps && pitch >= PITCH_MIN && pitch <= PITCH_MAX;
    let note = null, nearEdge = false;
    if (inGrid) {
      for (const n of p.notes) {
        if (n.pitch === pitch && step >= n.step && step < n.step + n.len) {
          note = n;
          nearEdge = x > (n.step + n.len) * CELL_W - EDGE_PX;
          break;
        }
      }
    }
    return { x, step, pitch, inGrid, note, nearEdge };
  }

  _down(e) {
    const pos = this._pos(e);
    if (!pos.inGrid) return;
    const p = this.getPattern();

    if (pos.note && (e.button === 2 || e.altKey)) {
      p.notes = p.notes.filter(n => n.id !== pos.note.id);
      if (this.selected === pos.note.id) this.selected = null;
      this.onChange();
      this.draw();
      return;
    }
    if (e.button !== 0) return;

    if (pos.note) {
      this.selected = pos.note.id;
      this.onSelect?.(pos.note);
      this.drag = e.shiftKey
        ? { mode: 'vel', note: pos.note, startY: e.clientY, startVel: pos.note.velocity }
        : pos.nearEdge
          ? { mode: 'resize', note: pos.note }
          : { mode: 'move', note: pos.note, dStep: pos.step - pos.note.step, startPitch: pos.note.pitch };
    } else {
      const n = makeNote(pos.step, pos.pitch, 1, this.getDefaultVelocity());
      p.notes.push(n);
      this.selected = n.id;
      this.drag = { mode: 'resize', note: n, created: true };
      this.onPreview(n.pitch, n.velocity);
      this.onChange();
    }
    this.draw();
  }

  _move(e) {
    if (!this.drag) return;
    const pos = this._pos(e);
    const p = this.getPattern();
    const n = this.drag.note;
    if (this.drag.mode === 'vel') {
      const vel = Math.max(1, Math.min(127, this.drag.startVel + Math.round(this.drag.startY - e.clientY)));
      if (vel !== n.velocity) {
        n.velocity = vel;
        this.onSelect?.(n);
        this.draw();
      }
    } else if (this.drag.mode === 'resize') {
      const len = Math.max(1, Math.min(pos.step - n.step + 1, p.lengthSteps - n.step));
      if (len !== n.len) { n.len = len; this.draw(); }
    } else {
      const step = Math.max(0, Math.min(pos.step - this.drag.dStep, p.lengthSteps - n.len));
      const pitch = Math.max(PITCH_MIN, Math.min(pos.pitch, PITCH_MAX));
      if (step !== n.step || pitch !== n.pitch) {
        if (pitch !== n.pitch) this.onPreview(pitch, n.velocity);
        n.step = step;
        n.pitch = pitch;
        this.draw();
      }
    }
  }

  _up() {
    if (this.drag) {
      if (this.drag.mode === 'vel') this.onPreview(this.drag.note.pitch, this.drag.note.velocity);
      this.onChange();
      this.drag = null;
      this.draw();
    }
  }

  setPlayhead(step) {
    this.playhead = step;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const p = this.getPattern();
    const w = KEY_W + p.lengthSteps * CELL_W;
    const h = ROWS * CELL_H;
    ctx.clearRect(0, 0, w, h);

    // Rows
    for (let r = 0; r < ROWS; r++) {
      const pitch = PITCH_MAX - r;
      ctx.fillStyle = BLACK.has(pitch % 12) ? '#16181c' : '#1d2026';
      ctx.fillRect(KEY_W, r * CELL_H, p.lengthSteps * CELL_W, CELL_H);
    }
    // Grid lines
    for (let s = 0; s <= p.lengthSteps; s++) {
      const x = KEY_W + s * CELL_W;
      ctx.strokeStyle = s % 16 === 0 ? '#4a5060' : s % 4 === 0 ? '#343945' : '#262a33';
      ctx.lineWidth = s % 16 === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
    for (let r = 0; r <= ROWS; r++) {
      const pitch = PITCH_MAX - r;
      ctx.strokeStyle = pitch % 12 === 11 ? '#3a4050' : '#22252d'; // line above each C
      ctx.beginPath();
      ctx.moveTo(KEY_W, r * CELL_H + 0.5);
      ctx.lineTo(w, r * CELL_H + 0.5);
      ctx.stroke();
    }

    // Notes
    for (const n of p.notes) {
      const x = KEY_W + n.step * CELL_W;
      const y = (PITCH_MAX - n.pitch) * CELL_H;
      const bright = 45 + Math.round((n.velocity / 127) * 45);
      ctx.fillStyle = `hsl(28, 90%, ${bright}%)`;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1.5, n.len * CELL_W - 3, CELL_H - 3, 3);
      ctx.fill();
      if (n.id === this.selected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Velocity readout while shift-dragging
    if (this.drag?.mode === 'vel') {
      const n = this.drag.note;
      const tx = KEY_W + n.step * CELL_W + 2;
      const ty = Math.max(11, (PITCH_MAX - n.pitch) * CELL_H - 4);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`vel ${n.velocity}`, tx, ty);
    }

    // Playhead
    if (this.playhead != null) {
      const x = KEY_W + this.playhead * CELL_W;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(x, 0, CELL_W, h);
    }

    // Keyboard column (drawn last so it stays clean)
    for (let r = 0; r < ROWS; r++) {
      const pitch = PITCH_MAX - r;
      const black = BLACK.has(pitch % 12);
      ctx.fillStyle = black ? '#0c0d10' : '#e8e6e0';
      ctx.fillRect(0, r * CELL_H, KEY_W, CELL_H);
      ctx.strokeStyle = '#00000040';
      ctx.strokeRect(0.5, r * CELL_H + 0.5, KEY_W - 1, CELL_H);
      if (pitch % 12 === 0) {
        ctx.fillStyle = '#555';
        ctx.font = '10px system-ui';
        ctx.textBaseline = 'middle';
        ctx.fillText(noteName(pitch), 6, r * CELL_H + CELL_H / 2 + 1);
      }
    }
  }
}
