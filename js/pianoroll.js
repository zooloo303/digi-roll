// Canvas piano roll editor.
//
// Interactions:
//   click/drag on empty cell  -> create note, drag right to set length
//   drag note body            -> move (pitch + step)
//   drag note's right edge    -> resize; a selection follows by the same delta,
//                                so long and short notes stay long and short
//   shift + drag note's edge  -> fine resize, snapped to what the box can store
//   shift+drag on note        -> velocity (up = harder), applied to the whole selection
//   shift+click on note       -> toggle it in/out of the selection
//   cmd/ctrl+drag on note     -> micro-timing offset
//   cmd/ctrl+drag on empty    -> marquee select
//   alt+drag on note          -> duplicate the note (or the selection) and move the copy
//   alt+click on note         -> delete (on release, so a drag can mean copy instead)
//   right-click on note       -> delete, immediately
//   Delete/Backspace          -> delete selected notes

import { makeNote } from './state.js';
import { resizeSelectionBy } from './edit-ops.js';

export const PITCH_MAX = 96; // C8 as the box labels it
export const PITCH_MIN = 24; // C2 as the box labels it
const ROWS = PITCH_MAX - PITCH_MIN + 1;
const CELL_H = 16;
// Exported so anything drawn in step with the grid — the trig lane — shares the
// geometry instead of keeping its own copy that could drift.
export const CELL_W = 34;
export const KEY_W = 52;
const EDGE_PX = 7;
const DRAG_PX = 3; // movement before a shift-click becomes a velocity drag
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);

export const PITCH_CLASSES = NAMES;
export const SCALES = {
  'Major': [0, 2, 4, 5, 7, 9, 11],
  'Minor': [0, 2, 3, 5, 7, 8, 10],
  'Dorian': [0, 2, 3, 5, 7, 9, 10],
  'Phrygian': [0, 1, 3, 5, 7, 8, 10],
  'Mixolydian': [0, 2, 4, 5, 7, 9, 10],
  'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
  'Pentatonic Minor': [0, 3, 5, 7, 10],
  'Blues': [0, 3, 5, 6, 7, 10],
};

// Octave numbering follows the boxes, not the middle-C = C4 convention: an
// Elektron displays MIDI 60 as C5, so that is what the key column says too.
// Keeping the two in step matters because the roll's job is to tell you which
// note you will see on the DT2/DN2 after a write.
export function noteName(pitch) {
  return NAMES[pitch % 12] + Math.floor(pitch / 12); // MIDI 60 = C5, as the box shows it
}

// The badge drawn inside a note that carries trig conditions. Deliberately
// dumb: it renders whatever labels the note holds and has no idea they came
// from an Elektron. Empty string means "nothing set, draw no marker".
function noteTrigTag(n) {
  const parts = [];
  if (n.cond) parts.push(n.cond);
  if (n.prob != null) parts.push(`${n.prob}%`);
  if (n.fill != null) parts.push(n.fill ? 'F' : 'f');
  return parts.join(' ');
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
    this.onBeforeEdit = opts.onBeforeEdit;     // about to mutate: snapshot for undo (once per gesture)
    this.getScale = opts.getScale;             // () => { root, set } | null — row tinting only
    this.getChord = opts.getChord;             // (pitch) => [{pitch, velocity, micro}] | null — chord mode off ⇒ null
    this.onChordWheel = opts.onChordWheel;     // (dir) => handled? — alt+wheel cycles inversion in chord mode
    // Anything drawn in step with the grid (the trig lane) hangs off these, so
    // it follows every resize and redraw without the call sites knowing.
    this.onResize = opts.onResize;
    this.onAfterDraw = opts.onAfterDraw;
    // Snap a fractional note length to something the device can actually
    // store. Injected, because the roll knows nothing about devices; absent,
    // shift-resize falls back to whole steps like a plain drag.
    this.snapLen = opts.snapLen ?? null;
    this.selected = new Set();                 // note ids
    this.lastTouched = null;                   // id the velocity slider mirrors
    this.drag = null;
    this.hover = null;                         // {step, pitch} the chord ghost follows
    // Last grid cell pressed. Paste lines the clipboard up with it, so "click
    // where you want it, then paste" works the way it does in a DAW.
    this.caret = null;                         // {step, pitch} | null
    this.playhead = null;

    canvas.addEventListener('mousedown', e => this._down(e));
    window.addEventListener('mousemove', e => this._move(e));
    window.addEventListener('mouseup', () => this._up());
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    // Plain wheel keeps scrolling the grid; alt+wheel is the chord voicing dial.
    canvas.addEventListener('wheel', e => {
      if (e.altKey && this.onChordWheel?.(Math.sign(e.deltaY))) e.preventDefault();
    }, { passive: false });
    window.addEventListener('keydown', e => {
      const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT';
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected.size && !typing) {
        const p = this.getPattern();
        this.onBeforeEdit?.();
        p.notes = p.notes.filter(n => !this.selected.has(n.id));
        this.clearSelection();
        this.onChange();
        this.draw();
      }
    });
    this.resize();
  }

  clearSelection() {
    this.selected.clear();
    this.lastTouched = null;
  }

  selectedNotes() {
    return this.getPattern().notes.filter(n => this.selected.has(n.id));
  }

  // Selection replaced by one note (the usual result of a plain click).
  select(note) {
    this.selected.clear();
    this.selected.add(note.id);
    this.lastTouched = note.id;
    this.onSelect?.(note);
  }

  setSelection(ids) {
    this.selected = new Set(ids);
    if (!this.selected.has(this.lastTouched)) this.lastTouched = null;
    const last = this.selectedNotes().at(-1);
    if (last) { this.lastTouched = this.lastTouched ?? last.id; this.onSelect?.(last); }
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
    this.onResize?.();
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
    return { x, y, step, pitch, inGrid, note, nearEdge };
  }

  // What a resize carries, and the lengths it starts from. The whole selection
  // comes along when the grabbed note belongs to it — which is the same rule
  // moving and velocity already follow, and after a plain click or a fresh
  // stamp the selection *is* just the note(s) in hand, so a single note still
  // resizes alone with no special case. Start lengths are captured here so the
  // drag applies one delta to them rather than compounding per mousemove.
  _resizeStart(note, extra = {}) {
    const sel = this.selectedNotes();
    const group = sel.some(x => x.id === note.id) ? sel : [note];
    return {
      mode: 'resize', note, startLen: note.len,
      items: group.map(x => ({ n: x, step: x.step, len: x.len })),
      ...extra,
    };
  }

  // Bounds of the current selection, for clamping a group move.
  _groupStart() {
    const items = this.selectedNotes().map(n => ({ n, step: n.step, pitch: n.pitch }));
    return {
      items,
      minStep: Math.min(...items.map(i => i.step)),
      maxEnd: Math.max(...items.map(i => i.step + i.n.len)),
      minPitch: Math.min(...items.map(i => i.pitch)),
      maxPitch: Math.max(...items.map(i => i.pitch)),
    };
  }

  _down(e) {
    const pos = this._pos(e);
    if (!pos.inGrid) {
      if (this.selected.size) { this.clearSelection(); this.draw(); }
      return;
    }
    const p = this.getPattern();
    this.caret = { step: pos.step, pitch: pos.pitch };

    if (pos.note && e.button === 2) {
      this.onBeforeEdit?.();
      p.notes = p.notes.filter(n => n.id !== pos.note.id);
      this.selected.delete(pos.note.id);
      this.onChange();
      this.draw();
      return;
    }
    if (e.button !== 0) return;
    const mod = e.metaKey || e.ctrlKey;

    if (pos.note && e.altKey) {
      // Undecided until it moves, the same bargain shift already strikes on a
      // note: a click deletes (on release), a drag duplicates and moves the copy.
      this.drag = { mode: 'alt', note: pos.note, grabStep: pos.step, startX: e.clientX, startY: e.clientY };
      return;
    }

    if (pos.note && e.shiftKey) {
      // Undecided until it moves: a click toggles selection, a drag sets velocity.
      this.drag = { mode: 'shift', note: pos.note, startX: e.clientX, startY: e.clientY };
      return;
    }

    if (pos.note) {
      // Clicking a note already in the selection keeps the group, so it can be dragged.
      if (this.selected.has(pos.note.id)) { this.lastTouched = pos.note.id; this.onSelect?.(pos.note); }
      else this.select(pos.note);
      this.onBeforeEdit?.(); // once per gesture, not per mousemove
      this.drag = mod
        ? { mode: 'micro', note: pos.note, startX: e.clientX, startMicro: pos.note.micro ?? 0 }
        : pos.nearEdge
          ? this._resizeStart(pos.note)
          : { mode: 'move', note: pos.note, dStep: pos.step - pos.note.step,
              baseStep: pos.note.step, basePitch: pos.note.pitch, group: this._groupStart() };
    } else if (mod) {
      this.drag = { mode: 'marquee', x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y };
    } else {
      this.onBeforeEdit?.();
      const chord = this.getChord?.(pos.pitch);
      if (chord?.length) {
        // Stamp the whole chord; the group stays selected so an immediate
        // drag transposes it, and dragging right lengthens every note.
        const made = chord.map(c => makeNote(pos.step, c.pitch, 1, c.velocity, c.micro));
        p.notes.push(...made);
        this.setSelection(made.map(n => n.id));
        this.hover = null;
        this.drag = this._resizeStart(made.at(-1), { created: true });
        for (const c of chord) this.onPreview(c.pitch, c.velocity);
      } else {
        const n = makeNote(pos.step, pos.pitch, 1, this.getDefaultVelocity());
        p.notes.push(n);
        this.select(n);
        this.drag = this._resizeStart(n, { created: true });
        this.onPreview(n.pitch, n.velocity);
      }
      this.onChange();
    }
    this.draw();
  }

  _move(e) {
    if (!this.drag) { this._trackHover(e); return; }
    const pos = this._pos(e);
    const p = this.getPattern();
    let n = this.drag.note;
    const past = () => Math.abs(e.clientX - this.drag.startX) > DRAG_PX
                    || Math.abs(e.clientY - this.drag.startY) > DRAG_PX;

    if (this.drag.mode === 'alt') {
      if (!past()) return;
      // Clone the same group a plain move would carry: the selection when the
      // pressed note is part of it, otherwise just that note. The copies become
      // the selection and the drag continues on them, so the originals stay put.
      const src = this.selected.has(n.id) ? this.selectedNotes() : [n];
      this.onBeforeEdit?.();
      const clones = src.map(x => makeNote(x.step, x.pitch, x.len, x.velocity, x.micro, x));
      p.notes.push(...clones);
      this.setSelection(clones.map(c => c.id));
      const clone = clones[src.indexOf(n)];
      this.drag = { mode: 'move', note: clone, dStep: this.drag.grabStep - clone.step,
                    baseStep: clone.step, basePitch: clone.pitch, group: this._groupStart() };
      n = clone;
    }

    if (this.drag.mode === 'shift') {
      if (!past()) return;
      if (!this.selected.has(n.id)) this.select(n);
      else { this.lastTouched = n.id; this.onSelect?.(n); }
      this.onBeforeEdit?.();
      this.drag = { mode: 'vel', note: n, startY: this.drag.startY,
                    items: this.selectedNotes().map(x => ({ n: x, vel: x.velocity })) };
    }

    if (this.drag.mode === 'marquee') {
      this.drag.x1 = pos.x;
      this.drag.y1 = pos.y;
      this.setSelection(this._inMarquee());
      this.draw();
    } else if (this.drag.mode === 'vel') {
      const d = Math.round(this.drag.startY - e.clientY);
      let changed = false;
      for (const it of this.drag.items) {
        const vel = Math.max(1, Math.min(127, it.vel + d));
        if (vel !== it.n.velocity) { it.n.velocity = vel; changed = true; }
      }
      if (changed) {
        this.onSelect?.(n);
        this.draw();
      }
    } else if (this.drag.mode === 'micro') {
      const micro = Math.max(-0.49, Math.min(0.49, this.drag.startMicro + (e.clientX - this.drag.startX) * 0.01));
      if (micro !== n.micro) { n.micro = micro; this.draw(); }
    } else if (this.drag.mode === 'resize') {
      // Shift switches to fine mode: the raw fractional length under the
      // pointer, snapped to whatever the device can store. Shift is free here —
      // its velocity meaning binds on the note body, not the edge.
      const room = p.lengthSteps - n.step;
      const fine = e.shiftKey && !!this.snapLen;
      const len = fine
        ? this.snapLen(pos.x / CELL_W - n.step, room)
        : Math.max(1, Math.min(pos.step - n.step + 1, room));
      const wasFine = this.drag.fine;
      this.drag.fine = fine;
      // The whole selection follows, by the delta this note travelled from
      // where the drag began — measured from the starting lengths, not the
      // current ones, so a drag that reverses lands back where it started
      // instead of accumulating. Fine mode's floor is whatever the device can
      // store, which snapLen knows and this module deliberately does not.
      const items = this.drag.items;
      const lens = resizeSelectionBy(items, len - this.drag.startLen, {
        lengthSteps: p.lengthSteps,
        snapLen: fine ? this.snapLen : null,
        minLen: fine ? this.snapLen(0, room) : 1,
      });
      if (items.some((it, i) => it.n.len !== lens[i])) {
        items.forEach((it, i) => { it.n.len = lens[i]; });
        this.onSelect?.(n); // the Length readout tracks the drag, as velocity's does
        this.draw();
      } else if (fine !== wasFine) {
        this.draw(); // the readout appears (or goes) the moment shift is pressed
      }
    } else if (this.drag.mode === 'move') {
      // One delta for the whole selection, clamped so no member leaves the grid.
      const g = this.drag.group;
      const dStep = Math.max(-g.minStep, Math.min(pos.step - this.drag.dStep - this.drag.baseStep,
                                                  p.lengthSteps - g.maxEnd));
      const dPitch = Math.max(PITCH_MIN - g.minPitch, Math.min(pos.pitch - this.drag.basePitch,
                                                               PITCH_MAX - g.maxPitch));
      if (dStep !== this.drag.dS || dPitch !== this.drag.dP) {
        for (const it of g.items) { it.n.step = it.step + dStep; it.n.pitch = it.pitch + dPitch; }
        if (dPitch !== this.drag.dP) this.onPreview(n.pitch, n.velocity);
        this.drag.dS = dStep;
        this.drag.dP = dPitch;
        this.draw();
      }
    }
  }

  // Ghost preview: with chord mode on, the chord that a click would stamp
  // follows the cursor over empty cells.
  _trackHover(e) {
    if (!this.getChord) return;
    const pos = this._pos(e);
    const want = pos.inGrid && !pos.note && this.getChord(pos.pitch)?.length
      ? { step: pos.step, pitch: pos.pitch } : null;
    if (want?.step !== this.hover?.step || want?.pitch !== this.hover?.pitch) {
      this.hover = want;
      this.draw();
    }
  }

  _up() {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.mode === 'alt') {            // never passed the threshold: it was a delete after all
      const p = this.getPattern();
      this.onBeforeEdit?.();
      p.notes = p.notes.filter(n => n.id !== d.note.id);
      this.selected.delete(d.note.id);
      this.onChange();
    } else if (d.mode === 'shift') {   // never passed the threshold: toggle membership
      if (this.selected.has(d.note.id)) {
        this.selected.delete(d.note.id);
        if (this.lastTouched === d.note.id) this.lastTouched = null;
      } else {
        this.selected.add(d.note.id);
        this.lastTouched = d.note.id;
        this.onSelect?.(d.note);
      }
    } else if (d.mode === 'marquee') {
      if (d.x0 === d.x1 && d.y0 === d.y1) this.clearSelection(); // click on empty space
    } else {
      if (d.mode === 'vel') this.onPreview(d.note.pitch, d.note.velocity);
      this.onChange();
    }
    this.draw();
  }

  _inMarquee() {
    const d = this.drag;
    const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
    const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
    return this.getPattern().notes.filter(n => {
      const nx0 = (n.step + (n.micro ?? 0)) * CELL_W, nx1 = nx0 + n.len * CELL_W;
      const ny0 = (PITCH_MAX - n.pitch) * CELL_H, ny1 = ny0 + CELL_H;
      return nx0 < x1 && nx1 > x0 && ny0 < y1 && ny1 > y0;
    }).map(n => n.id);
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

    // Rows (tinted amber where they sit in the chosen scale)
    const scale = this.getScale?.();
    for (let r = 0; r < ROWS; r++) {
      const pitch = PITCH_MAX - r;
      ctx.fillStyle = BLACK.has(pitch % 12) ? '#16181c' : '#1d2026';
      ctx.fillRect(KEY_W, r * CELL_H, p.lengthSteps * CELL_W, CELL_H);
      if (scale) {
        const iv = (pitch - scale.root + 120) % 12;
        const tint = iv === 0 ? 'rgba(240, 145, 58, 0.15)' : scale.set.has(iv) ? 'rgba(240, 145, 58, 0.06)' : null;
        if (tint) { ctx.fillStyle = tint; ctx.fillRect(KEY_W, r * CELL_H, p.lengthSteps * CELL_W, CELL_H); }
      }
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
      const x = KEY_W + (n.step + (n.micro ?? 0)) * CELL_W;
      const y = (PITCH_MAX - n.pitch) * CELL_H;
      // A 0.125-step note is barely over a pixel wide; keep a sliver drawn so
      // the shortest lengths the box can store are still visible.
      const w = Math.max(2, n.len * CELL_W - 3);
      const bright = 45 + Math.round((n.velocity / 127) * 45);
      ctx.fillStyle = `hsl(28, 90%, ${bright}%)`;
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1.5, w, CELL_H - 3, 3);
      ctx.fill();

      // A trig with any condition set gets a corner flag, and a compact tag
      // once there is room for it. The roll knows nothing about what these
      // mean — they arrive as a number, a tri-state and a label string.
      const tag = noteTrigTag(n);
      if (tag) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1.5, w, CELL_H - 3, 3);
        ctx.clip();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.beginPath();
        ctx.moveTo(x + w + 1, y + 1.5);
        ctx.lineTo(x + w + 1, y + 6.5);
        ctx.lineTo(x + w - 4, y + 1.5);
        ctx.closePath();
        ctx.fill();
        if (n.len >= 2) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
          ctx.font = '9px ui-monospace, Menlo, monospace';
          ctx.textBaseline = 'middle';
          ctx.fillText(tag, x + 4, y + CELL_H / 2);
        }
        ctx.restore();
      }

      if (this.selected.has(n.id)) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(x + 1, y + 1.5, w, CELL_H - 3, 3);
        ctx.stroke();
      }
    }

    // Chord ghost under the cursor (re-queried each draw, so the voicing
    // controls and alt+wheel update it in place)
    if (this.hover) {
      const chord = this.getChord?.(this.hover.pitch);
      if (chord) {
        for (const c of chord) {
          const x = KEY_W + (this.hover.step + (c.micro ?? 0)) * CELL_W;
          const y = (PITCH_MAX - c.pitch) * CELL_H;
          ctx.fillStyle = 'rgba(240, 145, 58, 0.28)';
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(x + 1, y + 1.5, CELL_W - 3, CELL_H - 3, 3);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // Marquee
    if (this.drag?.mode === 'marquee') {
      const d = this.drag;
      const x = KEY_W + Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      const mw = Math.abs(d.x1 - d.x0), mh = Math.abs(d.y1 - d.y0);
      ctx.fillStyle = 'rgba(240, 145, 58, 0.16)';
      ctx.fillRect(x, y, mw, mh);
      ctx.strokeStyle = '#f0913a';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, mw, mh);
    }

    // Readout while shift-dragging (velocity) or cmd-dragging (micro-timing)
    if (this.drag?.mode === 'vel' || this.drag?.mode === 'micro') {
      const n = this.drag.note;
      const micro = this.drag.mode === 'micro';
      const tx = KEY_W + (n.step + (micro ? n.micro : 0)) * CELL_W + 2;
      const ty = Math.max(11, (PITCH_MAX - n.pitch) * CELL_H - 4);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(micro ? `micro ${n.micro >= 0 ? '+' : ''}${n.micro.toFixed(2)}` : `vel ${n.velocity}`, tx, ty);
    }

    // Fine resize is guesswork without a number, so the length follows the edge.
    if (this.drag?.mode === 'resize' && this.drag.fine) {
      const n = this.drag.note;
      const tx = KEY_W + (n.step + (n.micro ?? 0) + n.len) * CELL_W + 3;
      const ty = Math.max(11, (PITCH_MAX - n.pitch) * CELL_H - 4);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px system-ui';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${+n.len.toFixed(3)}`, tx, ty);
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

    this.onAfterDraw?.();
  }
}
