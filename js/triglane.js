// The trig lane: a step-aligned strip under the piano roll for the three
// per-trig condition fields.
//
// These are properties of a *step*, not of a note — there is no track-level
// FILL or COND on the boxes at all, and notes sharing a step are one trig. So
// they get their own surface locked to the step grid rather than living in the
// selection panel, where they would read as "a property of the notes I picked".
//
// Rows, top to bottom: PROB, COND, FILL. A cell is live only where the step has
// notes; everything else is inert, because a condition on a step with no trig
// means nothing (the box scrubs those bytes when it creates a trig anyway).
//
// Interactions:
//   drag a PROB cell up/dn-> sets 0-100 (100 clears the lock); drag sideways to
//                            paint the same value across steps
//   click a COND cell     -> grouped picker popover
//   click a FILL cell     -> cycles  none -> ON -> OFF -> none
//   drag sideways on COND/FILL -> paints the anchor cell's value across steps
//   right-click / alt-click any cell -> clears that field on the step
//
// Editing a step that holds selected notes applies to every selected step at
// once, which is how you get a condition onto a whole phrase in one go.
//
// Geometry comes from pianoroll.js so the two can never drift apart. The picker
// is built from conditions.js — this module is Elektron-specific by nature,
// unlike the roll, which stays device-agnostic.

import { CELL_W, KEY_W } from './pianoroll.js';
import { COND_BY_DENOMINATOR, CONDITIONS, condDescription } from './elektron/conditions.js';

const ROW_H = 18;
// Row order, top to bottom. Everything else derives from this — drawing, hit
// testing and the drag readout all index through it.
const ROWS = ['prob', 'cond', 'fill'];
export const LANE_H = ROWS.length * ROW_H;

const ROW_LABEL = { cond: 'COND', fill: 'FILL', prob: 'PROB' };
const DRAG_PX = 3; // movement before a press becomes a drag rather than a click

// What a cell shows. null/undefined renders as the "nothing set" dash.
const cellText = (field, v) =>
  v == null ? '' : field === 'fill' ? (v ? 'ON' : 'OFF') : field === 'prob' ? String(v) : v;

// --- The lane's rules, as plain functions ----------------------------------
//
// Kept out of the class so they can be tested without a canvas — and because
// the step-uniformity rule is the part that has to be right.

// A step's current value for a field. Notes on a step are always in agreement,
// so the first one speaks for the trig.
export function stepValue(notes, step, field) {
  const n = notes.find(x => x.step === step);
  return n ? n[field] ?? null : null;
}

// Which steps an edit at `step` reaches: the whole selection when the clicked
// step is part of it, otherwise just that step.
export function targetSteps(notes, step, selectedIds = new Set()) {
  if (selectedIds.size && notes.some(n => n.step === step && selectedIds.has(n.id))) {
    return [...new Set(notes.filter(n => selectedIds.has(n.id)).map(n => n.step))].sort((a, b) => a - b);
  }
  return [step];
}

// Write one field across whole steps. Every note on a touched step gets the
// value — the step-uniformity rule the encoder depends on. Returns whether
// anything actually changed, so callers can skip a needless undo entry.
export function setTrigField(notes, steps, field, value) {
  const want = new Set(steps);
  let changed = false;
  for (const n of notes) {
    if (want.has(n.step) && n[field] !== value) { n[field] = value; changed = true; }
  }
  return changed;
}

// FILL is a tri-state, so clicking walks all three: none -> ON -> OFF -> none.
export const cycleFill = current => (current == null ? true : current === true ? false : null);

// Vertical drag to probability. Up raises the odds; the top of the range means
// "no lock", so dragging all the way up takes the lock off rather than storing
// a 100% that behaves identically.
export function probFromDrag(startValue, dy) {
  const raw = Math.round((startValue ?? 100) - dy / 2);
  return raw >= 100 ? null : Math.max(0, Math.min(100, raw));
}

export class TrigLane {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getPattern = opts.getPattern;       // () => pattern
    this.getSelectedIds = opts.getSelectedIds; // () => Set of selected note ids
    this.onChange = opts.onChange;           // notes edited (persist + redraw the roll)
    this.onBeforeEdit = opts.onBeforeEdit;   // snapshot for undo, once per gesture
    // The picker opens *above* the lane, so it can't live inside the lane's
    // wrapper — that one clips its overflow to drive the scroll sync.
    this.host = opts.pickerHost ?? canvas.parentElement;
    this.drag = null;
    this.picker = null;

    canvas.addEventListener('mousedown', e => this._down(e));
    window.addEventListener('mousemove', e => this._move(e));
    window.addEventListener('mouseup', () => this._up());
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.resize();
  }

  // --- model helpers (thin wrappers over the pure rules above) -------------

  _notesOn(step) {
    return this.getPattern().notes.filter(n => n.step === step);
  }

  _valueAt(step, field) {
    return stepValue(this.getPattern().notes, step, field);
  }

  _stepsWithNotes() {
    return new Set(this.getPattern().notes.map(n => n.step));
  }

  _targetSteps(step) {
    return targetSteps(this.getPattern().notes, step, this.getSelectedIds?.() ?? new Set());
  }

  _set(steps, field, value) {
    return setTrigField(this.getPattern().notes, steps, field, value);
  }

  // --- hit testing ---------------------------------------------------------

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left - KEY_W;
    const y = e.clientY - r.top;
    const p = this.getPattern();
    const step = Math.floor(x / CELL_W);
    const row = Math.floor(y / ROW_H);
    const inGrid = x >= 0 && step >= 0 && step < p.lengthSteps && row >= 0 && row < ROWS.length;
    return { x, y, step, field: inGrid ? ROWS[row] : null, inGrid, live: inGrid && this._notesOn(step).length > 0 };
  }

  // --- interaction ---------------------------------------------------------

  _down(e) {
    this._closePicker();
    const pos = this._pos(e);
    if (!pos.inGrid || !pos.live) return;

    // Uniform "take the lock off" gesture, whichever row.
    if (e.button === 2 || e.altKey) {
      this.onBeforeEdit?.();
      if (this._set(this._targetSteps(pos.step), pos.field, null)) this.onChange();
      this.draw();
      return;
    }
    if (e.button !== 0) return;

    this.drag = {
      field: pos.field, step: pos.step, startX: e.clientX, startY: e.clientY,
      moved: false, painted: new Set(),
      startValue: this._valueAt(pos.step, pos.field),
    };
  }

  _move(e) {
    if (!this.drag) return;
    const d = this.drag;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) <= DRAG_PX && Math.abs(dy) <= DRAG_PX) return;
    if (!d.moved) { d.moved = true; this.onBeforeEdit?.(); }

    d.value = d.field === 'prob' ? probFromDrag(d.startValue, dy) : d.startValue;

    // Paint across every live step the cursor has passed over.
    const pos = this._pos(e);
    const [from, to] = [Math.min(d.step, pos.step), Math.max(d.step, pos.step)];
    const steps = [];
    for (let s = from; s <= to; s++) if (this._notesOn(s).length) steps.push(s);
    if (this._set(steps.length ? steps : [d.step], d.field, d.value ?? null)) this.onChange();
    this.draw();
  }

  _up() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.moved) { this.onChange(); this.draw(); return; }

    // A click, not a drag.
    const steps = this._targetSteps(d.step);
    if (d.field === 'fill') {
      this.onBeforeEdit?.();
      if (this._set(steps, 'fill', cycleFill(d.startValue))) this.onChange();
      this.draw();
    } else if (d.field === 'cond') {
      this._openPicker(d.step, steps);
    }
    // A bare click on PROB does nothing: it is a drag control, and a click that
    // silently changed the odds would be a nasty surprise.
  }

  // --- the COND picker -----------------------------------------------------

  _closePicker() {
    this.picker?.remove();
    this.picker = null;
  }

  _openPicker(step, steps) {
    const current = this._valueAt(step, 'cond');
    const pop = document.createElement('div');
    pop.className = 'trigPicker';

    const apply = value => {
      this.onBeforeEdit?.();
      if (this._set(steps, 'cond', value)) this.onChange();
      this._closePicker();
      this.draw();
    };

    const head = document.createElement('div');
    head.className = 'trigPickerHead';
    head.textContent = steps.length > 1
      ? `Condition · ${steps.length} steps`
      : `Condition · step ${step + 1}`;
    pop.appendChild(head);

    const tabs = document.createElement('div');
    tabs.className = 'trigPickerTabs';
    const body = document.createElement('div');
    body.className = 'trigPickerBody';
    pop.append(tabs, body);

    const groups = [
      { id: 'logic', label: 'Logic', items: CONDITIONS.filter(c => c.group === 'logic') },
      ...COND_BY_DENOMINATOR.map(d => ({ id: `b${d.b}`, label: `:${d.b}`, items: d.items })),
    ];

    const showGroup = g => {
      [...tabs.children].forEach(t => t.classList.toggle('on', t.dataset.id === g.id));
      body.innerHTML = '';
      for (const c of g.items) {
        const b = document.createElement('button');
        b.textContent = c.key;
        b.title = condDescription(c.key);
        b.className = c.key === current ? 'on' : '';
        b.onclick = () => apply(c.key);
        body.appendChild(b);
      }
    };
    for (const g of groups) {
      const t = document.createElement('button');
      t.textContent = g.label;
      t.dataset.id = g.id;
      t.onclick = () => showGroup(g);
      tabs.appendChild(t);
    }

    const none = document.createElement('button');
    none.className = 'trigPickerNone' + (current == null ? ' on' : '');
    none.textContent = '— none —';
    none.onclick = () => apply(null);
    pop.appendChild(none);

    // Open on the tab holding the current value, so re-picking is one click.
    const currentGroup = groups.find(g => g.items.some(c => c.key === current));
    showGroup(currentGroup ?? groups[0]);

    this.host.appendChild(pop);
    // Sit above the clicked column, in the host's coordinates (so the lane's
    // horizontal scroll has to come off), and stay inside the visible area.
    const x = KEY_W + step * CELL_W - this.canvas.parentElement.scrollLeft;
    pop.style.left = `${Math.max(4, Math.min(x, this.host.clientWidth - pop.offsetWidth - 4))}px`;
    pop.style.bottom = `${LANE_H + 4}px`;
    this.picker = pop;
  }

  // --- drawing -------------------------------------------------------------

  resize() {
    const p = this.getPattern();
    const w = KEY_W + p.lengthSteps * CELL_W;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = LANE_H * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = LANE_H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._closePicker();
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const p = this.getPattern();
    const w = KEY_W + p.lengthSteps * CELL_W;
    const live = this._stepsWithNotes();
    const selected = this.getSelectedIds?.() ?? new Set();
    const selectedSteps = new Set(p.notes.filter(n => selected.has(n.id)).map(n => n.step));

    ctx.clearRect(0, 0, w, LANE_H);
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';

    ROWS.forEach((field, r) => {
      const y = r * ROW_H;
      for (let s = 0; s < p.lengthSteps; s++) {
        const x = KEY_W + s * CELL_W;
        const isLive = live.has(s);
        const value = isLive ? this._valueAt(s, field) : null;

        ctx.fillStyle = !isLive ? '#15171b'
          : selectedSteps.has(s) ? '#252a34'
            : value != null ? '#20242c' : '#1b1e24';
        ctx.fillRect(x, y, CELL_W, ROW_H);

        if (value != null) {
          // A filled pip makes a set step readable at a glance, before you read
          // the value itself.
          ctx.fillStyle = field === 'prob' ? '#4f8fd0' : field === 'fill' ? '#c9772f' : '#6aa84f';
          ctx.fillRect(x, y, CELL_W, 2);
          ctx.fillStyle = '#e4e7ec';
          const text = cellText(field, value);
          const tw = ctx.measureText(text).width;
          ctx.fillText(text, x + Math.max(2, (CELL_W - tw) / 2), y + ROW_H / 2 + 1);
        } else if (isLive) {
          ctx.fillStyle = '#3a4050';
          ctx.fillText('·', x + CELL_W / 2 - 1, y + ROW_H / 2 + 1);
        }

        ctx.strokeStyle = s % 16 === 0 ? '#4a5060' : s % 4 === 0 ? '#343945' : '#262a33';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y);
        ctx.lineTo(x + 0.5, y + ROW_H);
        ctx.stroke();
      }
      ctx.strokeStyle = '#262a33';
      ctx.beginPath();
      ctx.moveTo(KEY_W, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
    });

    // Row labels, in the gutter that lines up with the roll's keyboard column.
    ROWS.forEach((field, r) => {
      const y = r * ROW_H;
      ctx.fillStyle = '#171a20';
      ctx.fillRect(0, y, KEY_W, ROW_H);
      ctx.fillStyle = '#7d8590';
      ctx.fillText(ROW_LABEL[field], 6, y + ROW_H / 2 + 1);
    });
    ctx.strokeStyle = '#2a2e38';
    ctx.beginPath();
    ctx.moveTo(KEY_W + 0.5, 0);
    ctx.lineTo(KEY_W + 0.5, LANE_H);
    ctx.stroke();

    // Live readout while dragging probability, in whichever row PROB occupies.
    if (this.drag?.moved && this.drag.field === 'prob') {
      const x = KEY_W + this.drag.step * CELL_W;
      const y = ROWS.indexOf('prob') * ROW_H + ROW_H / 2 + 1;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px system-ui';
      ctx.fillText(this.drag.value == null ? 'no lock' : `${this.drag.value}%`, x + 2, y);
    }
  }
}
