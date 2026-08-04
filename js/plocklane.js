// P-lock lanes: stacked automation rows under the trig lane, one per parameter.
//
// Same skeleton as js/triglane.js — step-aligned hit testing, drag-painting,
// selection-aware edits — but a bar graph rather than a text cell, because a
// p-lock is a value in a range and the shape of a filter sweep is the thing you
// actually want to see.
//
// Rows are taller than the trig lane's 18 px for the same reason: a bar you can
// aim at is worth the pixels. One row per lane on the pattern, stacked in lane
// order, and the whole strip is absent when a pattern has no lanes.
//
// Editing, on a lane whose parameter digi-roll knows:
//   click in a cell        -> sets that step's value from where you clicked
//                             (absolute, not relative: the bar follows the
//                             pointer, which is what a bar graph implies)
//   drag up/down           -> keeps setting it as you move
//   drag sideways          -> paints the same value across the steps passed over
//   alt/right-click        -> clears the lock on that step
//   with a selection       -> a click reaches every selected step
//
// Two kinds of lane are **read-only**, drawn dimmed and hatched, and say why on
// hover:
//
//   * a lane whose paramId isn't in the device's curated table — which is every
//     lane today, because those tables are empty pending the hardware
//     experiments in PLAN.md's Phase 0. digi-roll can see the lane, name the
//     paramId and carry it through a write byte-exact; it cannot honestly draw
//     "cutoff 64" or let you drag it, because it doesn't yet know that the
//     parameter is cutoff or what 64 would store.
//   * a lane the box filled on a step with no trig (a trigless lock). v1 doesn't
//     model those; passing it through untouched keeps what the box has instead
//     of editing it into something else.
//
// Values on a lane are the box's own stored uint16s; the parameter descriptor
// (js/elektron/params.js) is what turns one into a number to draw and back. A
// read-only lane gets a raw descriptor spanning the whole word range, so its
// bars are honest about relative height and about nothing else.

import { CELL_W, KEY_W } from './pianoroll.js';
import { targetSteps } from './triglane.js';
import { paramTableFor } from './elektron/param-tables.js';
import { describeParam, clampParamValue } from './elektron/params.js';

export const ROW_H = 30;
// Headroom above a full bar, so "at maximum" doesn't read as "clipped by the row
// above". Exported because it is part of the geometry contract between drawing
// and dragging: the pointer sits on the top edge of the bar it is setting, so a
// full bar's top edge is BAR_PAD from the top of the row and that is where the
// maximum value lives.
export const BAR_PAD = 4;

// --- The lane's rules, as plain functions -------------------------------------
//
// Kept out of the class so they can be tested without a canvas, like the trig
// lane's. The read-only rule is the one that has to be right: everything else is
// pixels, but that one decides whether digi-roll edits bytes it doesn't
// understand.

// The parameter a lane automates, curated when we know which knob it is and a
// raw stand-in when we don't. Never null — a lane always draws and always labels
// itself.
export function laneParam(lane) {
  return describeParam(paramTableFor(lane.deviceKind), lane);
}

// May this lane be edited? Only when we know which parameter it is, and only when
// the box wasn't holding trigless values in it.
//
// Note that this is *not* the same question as "can it be sent to the box" —
// a curated parameter can be drawn and heard over MIDI while its p-lock slot in
// the pattern format is still unmeasured. `laneParam(lane).writable` is that
// other question, and the two are deliberately separate.
export function laneIsEditable(lane) {
  return laneParam(lane).curated && !lane.trigless;
}

// Why a lane can't be edited, for the tooltip and the status line. null when it
// can be.
export function laneReadOnlyReason(lane) {
  const p = laneParam(lane);
  if (!p.curated) {
    return `${p.label} isn't a parameter digi-roll has mapped yet, so this lane is shown read-only `
      + 'and written back to the box exactly as it came';
  }
  if (lane.trigless) {
    return `${p.label} has locks on steps with no trig, which digi-roll doesn't edit — `
      + 'the lane is written back exactly as it came';
  }
  return null;
}

// One step's value on the parameter's display axis, or null when unlocked. Lane
// values are already on that axis (js/roll-bridge.js converts at the byte seam),
// so this is a plain read — it exists so drawing and hit-testing agree with the
// model through one function.
export function laneDisplayValue(lane, step) {
  return lane.values[step] ?? null;
}

// A y position inside a row → a value in the parameter's units. Absolute: the
// top of the row is the parameter's maximum, the bottom its minimum, which is
// what a bar graph promises. Clamped onto the parameter's own resolution, so
// every position the pointer can reach is a value the box can hold.
export function valueFromRowY(param, yInRow, rowH = ROW_H) {
  const usable = Math.max(1, rowH - BAR_PAD);
  const frac = 1 - Math.max(0, Math.min(1, (yInRow - BAR_PAD) / usable));
  return clampParamValue(param, param.min + frac * (param.max - param.min));
}

// How tall a bar is, 0..1, for a display value.
export function barFraction(param, value) {
  const span = param.max - param.min;
  return span > 0 ? Math.max(0, Math.min(1, (value - param.min) / span)) : 0;
}

// Write one display value across whole steps of a lane, clamped onto the
// parameter's own range and resolution. Returns whether anything changed, so a
// gesture that moved nothing leaves no undo entry.
export function setLaneValue(lane, steps, value) {
  const v = clampParamValue(laneParam(lane), value);
  let changed = false;
  for (const step of steps) {
    if (step < 0 || step >= lane.values.length) continue;
    if (lane.values[step] !== v) { lane.values[step] = v; changed = true; }
  }
  return changed;
}

// Take the locks off whole steps.
export function clearLaneValue(lane, steps) {
  let changed = false;
  for (const step of steps) {
    if (step < 0 || step >= lane.values.length) continue;
    if (lane.values[step] != null) { lane.values[step] = null; changed = true; }
  }
  return changed;
}

// A lane's one-line summary for the panel list: "FLTR CUTOFF · 6 steps".
//
// A lane that can be edited but not yet stored in a pattern says so, because
// "preview only" is the single most surprising thing about this feature right now
// and the place to say it is next to the lane itself.
export function describeLane(lane) {
  const param = laneParam(lane);
  const n = lane.values.filter(v => v != null).length;
  const state = !laneIsEditable(lane) ? ' · read-only'
    : !param.writable ? ' · preview only'
      : '';
  return `${param.label} · ${n} step${n === 1 ? '' : 's'}${state}`;
}

// --- The strip ----------------------------------------------------------------

export class PLockLane {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getPattern = opts.getPattern;         // () => pattern
    this.getSelectedIds = opts.getSelectedIds; // () => Set of selected note ids
    this.onChange = opts.onChange;             // lanes edited (persist + redraw)
    this.onBeforeEdit = opts.onBeforeEdit;     // snapshot for undo, once per gesture
    this.onStatus = opts.onStatus ?? (() => {});
    this.drag = null;

    canvas.addEventListener('mousedown', e => this._down(e));
    window.addEventListener('mousemove', e => this._move(e));
    window.addEventListener('mouseup', () => this._up());
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.resize();
  }

  _lanes() {
    return this.getPattern().plocks ?? [];
  }

  _stepsWithNotes() {
    return new Set(this.getPattern().notes.map(n => n.step));
  }

  _targetSteps(step) {
    return targetSteps(this.getPattern().notes, step, this.getSelectedIds?.() ?? new Set());
  }

  height() {
    return this._lanes().length * ROW_H;
  }

  // --- hit testing ---------------------------------------------------------

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left - KEY_W;
    const y = e.clientY - r.top;
    const p = this.getPattern();
    const lanes = this._lanes();
    const step = Math.floor(x / CELL_W);
    const row = Math.floor(y / ROW_H);
    const inGrid = x >= 0 && step >= 0 && step < p.lengthSteps && row >= 0 && row < lanes.length;
    return {
      x, y, step, row, inGrid,
      lane: inGrid ? lanes[row] : null,
      yInRow: y - row * ROW_H,
      // A cell is live where the step has a trig: a lock with no trig to ride on
      // is the trigless case v1 doesn't author.
      live: inGrid && this._stepsWithNotes().has(step),
    };
  }

  // --- interaction ---------------------------------------------------------

  _down(e) {
    const pos = this._pos(e);
    if (!pos.inGrid) return;
    if (!laneIsEditable(pos.lane)) {
      this.onStatus(laneReadOnlyReason(pos.lane), true);
      return;
    }
    if (!pos.live) return;

    if (e.button === 2 || e.altKey) {
      this.onBeforeEdit?.();
      if (clearLaneValue(pos.lane, this._targetSteps(pos.step))) this.onChange();
      this.draw();
      return;
    }
    if (e.button !== 0) return;

    // The value is set on *press*, from where you pressed — click to set, drag to
    // draw, like any automation lane. The trig lane above makes you drag instead,
    // because there a click means something else (open the COND picker, cycle
    // FILL) and a click that silently changed the odds would be a nasty surprise.
    // Here a bare click has no other meaning, so a movement threshold would only
    // create a dead zone around the press point and swallow small adjustments.
    this.onBeforeEdit?.();
    const value = valueFromRowY(laneParam(pos.lane), pos.yInRow, ROW_H);
    setLaneValue(pos.lane, this._targetSteps(pos.step), value);
    // Unconditionally, even when nothing moved: the host drops the undo entry it
    // just took if the pattern is unchanged, and that only runs from here.
    this.onChange();

    this.drag = { lane: pos.lane, step: pos.step, value };
    this.draw();
  }

  _move(e) {
    if (!this.drag) return;
    const d = this.drag;
    const pos = this._pos(e);

    // The value follows the pointer's height in the *lane's own row*, wherever
    // the cursor has wandered to vertically — dragging sideways to paint must
    // not change the value because the pointer strayed into the next row.
    const r = this.canvas.getBoundingClientRect();
    const rowTop = r.top + this._lanes().indexOf(d.lane) * ROW_H;
    d.value = valueFromRowY(laneParam(d.lane), e.clientY - rowTop, ROW_H);

    // Paint across every live step between the anchor and the cursor.
    const [from, to] = [Math.min(d.step, pos.step), Math.max(d.step, pos.step)];
    const live = this._stepsWithNotes();
    const steps = [];
    for (let s = from; s <= to; s++) if (live.has(s)) steps.push(s);
    if (setLaneValue(d.lane, steps.length ? steps : [d.step], d.value)) this.onChange();
    this.draw();
  }

  _up() {
    if (!this.drag) return;
    this.drag = null;
    this.draw(); // clears the live value readout
  }

  // --- drawing -------------------------------------------------------------

  resize() {
    const p = this.getPattern();
    const lanes = this._lanes();
    const w = KEY_W + p.lengthSteps * CELL_W;
    const h = Math.max(1, lanes.length * ROW_H);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    // The whole strip goes away when there are no lanes, rather than leaving an
    // empty gutter under the grid.
    this.canvas.parentElement?.classList.toggle('hidden', lanes.length === 0);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const p = this.getPattern();
    const lanes = this._lanes();
    const w = KEY_W + p.lengthSteps * CELL_W;
    const h = Math.max(1, lanes.length * ROW_H);
    const live = this._stepsWithNotes();
    const selected = this.getSelectedIds?.() ?? new Set();
    const selectedSteps = new Set(p.notes.filter(n => selected.has(n.id)).map(n => n.step));

    ctx.clearRect(0, 0, w, h);
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';

    lanes.forEach((lane, r) => {
      const y = r * ROW_H;
      const param = laneParam(lane);
      const editable = laneIsEditable(lane);

      for (let s = 0; s < p.lengthSteps; s++) {
        const x = KEY_W + s * CELL_W;
        const isLive = live.has(s);
        const value = laneDisplayValue(lane, s);

        ctx.fillStyle = !isLive ? '#15171b' : selectedSteps.has(s) ? '#22262f' : '#1b1e24';
        ctx.fillRect(x, y, CELL_W, ROW_H);

        if (value != null) {
          const frac = barFraction(param, value);
          const barH = Math.max(1, frac * (ROW_H - BAR_PAD));
          // Read-only lanes are drawn in grey rather than the editable purple,
          // so "you can't drag this" is visible before you try.
          ctx.fillStyle = editable ? '#8d6fd1' : '#565d6b';
          ctx.fillRect(x + 1, y + ROW_H - barH, CELL_W - 2, barH);
          ctx.fillStyle = editable ? '#c9b6f2' : '#7d8590';
          ctx.fillRect(x + 1, y + ROW_H - barH - 1, CELL_W - 2, 1);
        } else if (isLive) {
          ctx.fillStyle = '#2b303a';
          ctx.fillRect(x + 1, y + ROW_H - 2, CELL_W - 2, 1);
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

    // Labels in the gutter that lines up with the roll's keyboard column.
    lanes.forEach((lane, r) => {
      const y = r * ROW_H;
      const param = laneParam(lane);
      const editable = laneIsEditable(lane);
      ctx.fillStyle = '#171a20';
      ctx.fillRect(0, y, KEY_W, ROW_H);
      ctx.fillStyle = editable ? '#9aa2ae' : '#646b78';
      // Two lines: the parameter, then its range — the gutter is narrow, so the
      // label is clipped rather than shrunk.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y, KEY_W - 2, ROW_H);
      ctx.clip();
      ctx.fillText(param.short ?? param.label, 5, y + ROW_H / 2 - 4);
      // The second line is a size smaller so "read-only" fits the 52 px gutter
      // whole rather than clipping to "read-onl".
      ctx.fillStyle = '#59606d';
      ctx.font = '8px ui-monospace, Menlo, monospace';
      ctx.fillText(editable ? `${param.min}–${param.max}${param.unit}` : 'read-only', 5, y + ROW_H / 2 + 7);
      ctx.font = '9px ui-monospace, Menlo, monospace';
      ctx.restore();
    });

    ctx.strokeStyle = '#2a2e38';
    ctx.beginPath();
    ctx.moveTo(KEY_W + 0.5, 0);
    ctx.lineTo(KEY_W + 0.5, h);
    ctx.stroke();

    // Live readout while dragging, next to the bar being set.
    if (this.drag?.value != null) {
      const row = lanes.indexOf(this.drag.lane);
      const param = laneParam(this.drag.lane);
      const x = KEY_W + this.drag.step * CELL_W;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px system-ui';
      ctx.fillText(`${+this.drag.value.toFixed(3)}${param.unit}`, x + 2, row * ROW_H + 8);
    }
  }
}
