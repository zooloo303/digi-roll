// The Generate panel.
//
// All the musical decisions live in js/gen/ — pure, seeded, canvas-free. This is
// the wiring: read the controls into the song context, run the arrangement, drop
// the results into pattern slots, and say what happened.
//
// Three things it is careful about, because each is a way a user could be
// surprised:
//
//   * **Generating replaces slots.** So it names them and asks first whenever any
//     of them has notes in it, exactly as Clear does — and the whole thing is one
//     undo entry.
//   * **Root and Scale here are the Harmony panel's.** They write
//     `state.scaleRoot` / `state.scale`, so the tinted rows on the grid always
//     agree with what was generated. With tinting off, generating turns it on to
//     the key it just used and says so.
//   * **P-lock lanes need to know which box.** A lane belongs to one box's
//     parameter numbering, so with no box resolvable the generator makes none and
//     the status line says why rather than guessing.
//
// It never touches `swing` or `trackProb`: see applyPartToPattern in
// js/gen/arrange.js for the whole list of what a generated part writes.

import { PITCH_CLASSES, SCALES } from './pianoroll.js';
import { NUM_SLOTS } from './state.js';
import {
  normalizeGenContext, contextForGenre, checkProgression, bpmSuggestion,
  roleForSlot, withVariationsReset, withVariationBumped, partLabel,
  GEN_ROLES, GEN_BARS, ROLE_LABELS,
} from './gen/context.js';
import { GENRE_IDS, genreProfile } from './gen/genres.js';
import { nextProgressionFor, progressionNote } from './gen/progressions.js';
import { generateArrangement, applyPartToPattern } from './gen/arrange.js';
import { randomSeed } from './gen/rng.js';

const $ = id => document.getElementById(id);

// The per-role control ids, so the three rows are wired in one loop rather than
// three near-identical copies.
const CTL = Object.fromEntries(GEN_ROLES.map(role => {
  const cap = ROLE_LABELS[role];
  return [role, {
    on: `genOn${cap}`, slot: `genSlot${cap}`,
    density: `genDens${cap}`, densityLabel: `genDens${cap}Label`,
  }];
}));

const FEEL = {
  motion: { input: 'genMotion', label: 'genMotionLabel' },
  looseness: { input: 'genLoose', label: 'genLooseLabel' },
  humanize: { input: 'genHuman', label: 'genHumanLabel' },
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class GeneratePanel {
  //   state             the app state object (mutated in place, like the rest of main.js)
  //   persist           save the state
  //   pushUndo          (slots) => void — one undo entry covering every slot named
  //   setStatus         (msg, isError) => void
  //   deviceKind        () => 'DT2' | 'DN2' | null — whose parameter numbering p-locks use
  //   onSlotsChanged    () => void — patterns changed: re-sync the toolbar and redraw
  //   onHarmonyChanged  () => void — root/scale changed: redraw the grid's tinting
  constructor({
    state, persist, pushUndo, setStatus, deviceKind, onSlotsChanged, onHarmonyChanged,
  }) {
    this.state = state;
    this.persist = persist;
    this.pushUndo = pushUndo;
    this.setStatus = setStatus;
    this.deviceKind = deviceKind;
    this.onSlotsChanged = onSlotsChanged;
    this.onHarmonyChanged = onHarmonyChanged;
    // The parser's complaint about what is currently typed in the progression
    // field, or null. While it is set the field holds text the context does not,
    // and generating refuses.
    this.progError = null;

    // The backfill for `state.gen`: an older save (or a fresh one — js/state.js
    // deliberately leaves the field null) gets a complete context here.
    state.gen = normalizeGenContext(state.gen, NUM_SLOTS);

    this.fillOptions();
    this.wire();
  }

  get ctx() { return this.state.gen; }
  set ctx(v) { this.state.gen = v; }

  fillOptions() {
    for (const id of GENRE_IDS) $('genGenre').add(new Option(genreProfile(id).label, id));
    for (const bars of GEN_BARS) $('genBars').add(new Option(`${plural(bars, 'bar')}`, bars));
    PITCH_CLASSES.forEach((n, i) => $('genRoot').add(new Option(n, i)));
    // No "Off" here, unlike the Harmony panel's: the generator always works in a
    // scale, and picking one here turns the grid's tinting on to match.
    for (const name of Object.keys(SCALES)) $('genScale').add(new Option(name, name));
    for (const role of GEN_ROLES) {
      for (let i = 0; i < NUM_SLOTS; i++) $(CTL[role].slot).add(new Option(`${i + 1}`, i));
    }
  }

  wire() {
    const edit = fn => () => {
      fn();
      this.persist();
      this.sync();
    };

    $('genGenre').onchange = edit(() => {
      // A progression you typed is yours — switching genre keeps it. One out of
      // the library is the genre's, so it is replaced with the new genre's own.
      const custom = !progressionNote(this.ctx.progression);
      this.ctx = contextForGenre(this.ctx, $('genGenre').value, { keepProgression: custom });
    });
    $('genBars').onchange = edit(() => { this.ctx.bars = +$('genBars').value; });

    // Root and Scale are the Harmony panel's own values, not a second copy.
    $('genRoot').onchange = edit(() => {
      this.ctx.root = +$('genRoot').value;
      this.state.scaleRoot = this.ctx.root;
      this.onHarmonyChanged();
    });
    $('genScale').onchange = edit(() => {
      this.ctx.scale = $('genScale').value;
      this.state.scale = this.ctx.scale;
      this.onHarmonyChanged();
    });

    // Committed on change (blur or Enter), not on every keystroke: a half-typed
    // chord isn't an error yet.
    //
    // A malformed one is *kept in the field* — reverting what somebody typed
    // loses their work and hides the mistake — with the parser's own sentence
    // under it in red and the last good progression still in the context.
    // Generating refuses while it stands, rather than quietly using a
    // progression that isn't the one on screen.
    $('genProg').onchange = () => {
      const text = $('genProg').value.trim();
      const check = checkProgression(text);
      this.progError = check.ok ? null : check.error;
      if (check.ok) this.ctx.progression = text;
      this.persist();
      this.sync();
      this.setStatus(check.ok
        ? `Progression: ${text}${progressionNote(text) ? ` — ${progressionNote(text)}` : ''}`
        : check.error, !check.ok);
    };
    $('genProgNext').onclick = edit(() => {
      this.progError = null;
      this.ctx.progression = nextProgressionFor(this.ctx.genre, this.ctx.progression);
    });

    $('genSeed').onchange = edit(() => {
      const n = Number($('genSeed').value);
      this.ctx.seed = Number.isFinite(n) ? (Math.floor(n) >>> 0) : this.ctx.seed;
    });
    $('genSeedRoll').onclick = edit(() => { this.ctx.seed = randomSeed(); });
    $('genSeedLock').onclick = edit(() => { this.ctx.seedLocked = !this.ctx.seedLocked; });

    $('genSetBpm').onclick = () => {
      const { bpm } = bpmSuggestion(this.ctx, this.state.bpm);
      this.state.bpm = bpm;
      $('bpm').value = bpm;
      this.persist();
      this.sync();
      this.setStatus(`Tempo set to ${bpm} BPM`);
    };

    for (const role of GEN_ROLES) {
      const c = CTL[role];
      $(c.on).onchange = edit(() => { this.ctx.parts[role].on = $(c.on).checked; });
      $(c.slot).onchange = edit(() => { this.ctx.parts[role].slot = +$(c.slot).value; });
      // Sliders sync live so the readout tracks the drag, and persist as they go —
      // these are settings, not pattern edits, so there is no undo entry.
      $(c.density).oninput = edit(() => { this.ctx.parts[role].density = +$(c.density).value; });
    }
    for (const [key, ids] of Object.entries(FEEL)) {
      $(ids.input).oninput = edit(() => { this.ctx.feel[key] = +$(ids.input).value; });
    }

    $('genRun').onclick = () => this.run(null);
    // The button is disabled when the slot you're editing isn't assigned to a
    // part, but the check is here too rather than relying on that: `run(null)`
    // means "the whole arrangement", so a null role must never reach it.
    $('genRunSlot').onclick = () => {
      const role = roleForSlot(this.ctx, this.state.current);
      if (!role) {
        this.setStatus(`Slot ${this.state.current + 1} isn't assigned to a part — `
          + 'point one of the parts at it first', true);
        return;
      }
      this.run(role);
    };
  }

  // Every control re-read from the context, plus the four hints. Called on open,
  // after every edit, and whenever main.js re-syncs the toolbar (a slot switch
  // changes which part "Generate this slot" would re-roll).
  sync() {
    const ctx = this.ctx = normalizeGenContext(this.ctx, NUM_SLOTS);
    // The Harmony panel wins while it has a scale on — one editable truth.
    if (this.state.scale !== 'off') {
      ctx.root = this.state.scaleRoot;
      ctx.scale = SCALES[this.state.scale] ? this.state.scale : ctx.scale;
    }

    $('genGenre').value = ctx.genre;
    $('genBars').value = ctx.bars;
    $('genRoot').value = ctx.root;
    $('genScale').value = ctx.scale;
    // Leave the field alone while it is being typed into, and while it holds
    // something that didn't parse — that text is the user's to fix.
    if (document.activeElement !== $('genProg') && !this.progError) {
      $('genProg').value = ctx.progression;
    }
    if (document.activeElement !== $('genSeed')) $('genSeed').value = ctx.seed;
    $('genSeedLock').classList.toggle('active', ctx.seedLocked);
    $('genSeedLock').title = ctx.seedLocked
      ? 'Seed locked — generating again gives the same music, so you can change one slider at a time'
      : 'Seed unlocked — each Generate arrangement rolls a new one';

    for (const role of GEN_ROLES) {
      const c = CTL[role];
      const p = ctx.parts[role];
      $(c.on).checked = p.on;
      $(c.slot).value = p.slot;
      for (let i = 0; i < NUM_SLOTS; i++) {
        $(c.slot).options[i].text = `${i + 1} · ${this.state.patterns[i].name}`;
      }
      $(c.density).value = p.density;
      $(c.densityLabel).textContent = `${p.density}%`;
    }
    for (const [key, ids] of Object.entries(FEEL)) {
      $(ids.input).value = ctx.feel[key];
      $(ids.label).textContent = `${ctx.feel[key]}%`;
    }

    this.syncHints();
  }

  syncHints() {
    const ctx = this.ctx;
    const check = checkProgression(ctx.progression);
    const note = progressionNote(ctx.progression);
    const loops = check.bars > ctx.bars
      ? `, truncated to your ${plural(ctx.bars, 'bar')}`
      : ctx.bars > check.bars ? `, looped over your ${plural(ctx.bars, 'bar')}` : '';
    $('genProgHint').textContent = this.progError
      ?? `${note || 'Your own progression'} · ${plural(check.bars, 'bar')}${loops}`;
    $('genProgHint').classList.toggle('error', !!this.progError);

    const { bpm, inRange, range } = bpmSuggestion(ctx, this.state.bpm);
    $('genBpmHint').textContent = `${genreProfile(ctx.genre).label} sits around ${range[0]}–${range[1]} BPM`
      + (inRange ? ` — you're at ${this.state.bpm}.` : `. You're at ${this.state.bpm}.`);
    $('genSetBpm').textContent = `Set ${bpm} BPM`;
    $('genSetBpm').disabled = this.state.bpm === bpm;

    // Two parts aimed at one slot is the one arrangement mistake the panel can
    // see coming, so it says so before you press the button.
    const clash = [];
    const seen = new Map();
    for (const role of GEN_ROLES) {
      if (!ctx.parts[role].on) continue;
      const slot = ctx.parts[role].slot;
      if (seen.has(slot)) clash.push(`${ROLE_LABELS[seen.get(slot)]} and ${ROLE_LABELS[role]} are both aimed at slot ${slot + 1}`);
      else seen.set(slot, role);
    }
    $('genSlotHint').textContent = clash.length
      ? `${clash.join('; ')} — the later part would overwrite the earlier one.`
      : 'Each part goes to its own slot; send each one to its own track in the Box panel.';
    $('genSlotHint').classList.toggle('error', clash.length > 0);

    const role = roleForSlot(ctx, this.state.current);
    $('genRunSlot').disabled = !role;
    $('genRunSlot').textContent = role
      ? `Re-roll the ${ROLE_LABELS[role].toLowerCase()} (slot ${this.state.current + 1})`
      : 'Generate this slot';
    $('genRunSlot').title = role
      ? `Re-roll only the ${ROLE_LABELS[role].toLowerCase()}, against the same key, progression and seed — `
        + 'the other parts stay exactly as they are'
      : `Slot ${this.state.current + 1} isn't assigned to a part — point one of the parts above at it first`;

    const kind = this.deviceKind();
    $('genHint').textContent = ctx.feel.motion > 0 && !kind
      ? 'No box resolvable yet, so no p-lock lanes will be drawn — a lane belongs to one box\'s '
        + 'parameter numbering. Pick your box in the MIDI output menu and generate again.'
      : 'Generating replaces the checked slots in one undo step. Nothing is sent to the box until '
        + 'you use Send in the Box panel.';
  }

  // Generate. `roleOnly` is the "re-roll this slot" path.
  run(roleOnly) {
    const state = this.state;
    let ctx = normalizeGenContext(this.ctx, NUM_SLOTS);

    if (roleOnly && !GEN_ROLES.includes(roleOnly)) {
      this.setStatus(`No part called ${JSON.stringify(roleOnly)}`, true);
      return;
    }
    if (this.progError) {
      this.setStatus(`Can't generate: ${this.progError}`, true);
      return;
    }
    const targets = roleOnly ? [roleOnly] : GEN_ROLES.filter(r => ctx.parts[r].on);
    if (!targets.length) {
      this.setStatus('Nothing to generate — check at least one part', true);
      return;
    }

    // A whole arrangement is the canonical one for its seed, and rolls a new seed
    // unless it's locked. Re-rolling one part moves only that part's stream, so the
    // parts you're keeping stay put and the new one still answers them.
    ctx = roleOnly
      ? withVariationBumped(ctx, roleOnly)
      : withVariationsReset(ctx.seedLocked ? ctx : { ...ctx, seed: randomSeed() });

    let result;
    try {
      result = generateArrangement(ctx, { deviceKind: this.deviceKind() });
    } catch (err) {
      this.setStatus(`Can't generate: ${err.message}`, true);
      return;
    }

    const slots = [...new Set(targets.map(r => ctx.parts[r].slot))];
    const occupied = targets.filter(r => state.patterns[ctx.parts[r].slot].notes.length);
    if (occupied.length) {
      const lines = occupied.map(r =>
        `  ${ROLE_LABELS[r]} → slot ${ctx.parts[r].slot + 1} “${state.patterns[ctx.parts[r].slot].name}” `
        + `(${plural(state.patterns[ctx.parts[r].slot].notes.length, 'note')})`);
      const ok = window.confirm(
        `Replace what's in ${occupied.length === 1 ? 'this slot' : 'these slots'}?\n\n${lines.join('\n')}\n\n`
        + 'Undo puts it back.');
      if (!ok) {
        this.setStatus('Generate cancelled — nothing changed');
        return;
      }
    }

    this.pushUndo(slots);
    this.ctx = ctx;

    // The grid's tinting should agree with what was generated. If tinting was off,
    // generating turns it on to the key it just used rather than leaving the roll
    // showing nothing.
    let tintOn = false;
    if (state.scale === 'off') {
      state.scale = ctx.scale;
      state.scaleRoot = ctx.root;
      tintOn = true;
    }

    for (const role of targets) {
      applyPartToPattern(state.patterns[ctx.parts[role].slot], result.parts[role], {
        label: partLabel(ctx, role),
      });
    }

    this.persist();
    this.onSlotsChanged();
    if (tintOn) this.onHarmonyChanged();
    this.sync();

    const parts = targets.map(r => {
      const p = result.parts[r];
      const lanes = p.plocks.length;
      return `${ROLE_LABELS[r].toLowerCase()} ${plural(p.trigCount, 'trig')}`
        + (lanes ? ` + ${plural(lanes, 'lane')}` : '')
        + ` → slot ${ctx.parts[r].slot + 1}`;
    });
    const key = `${PITCH_CLASSES[ctx.root]} ${ctx.scale}`;
    this.setStatus([
      `${roleOnly ? `Re-rolled the ${ROLE_LABELS[roleOnly].toLowerCase()}` : 'Generated'}`
      + ` — ${genreProfile(ctx.genre).label} in ${key}, ${ctx.progression}`,
      parts.join(' · '),
      `seed ${ctx.seed}${ctx.seedLocked ? ' (locked)' : ''}`,
      tintOn ? `scale tinting turned on to ${key}` : '',
      ...result.warnings,
    ].filter(Boolean).join(' · '));
  }
}
