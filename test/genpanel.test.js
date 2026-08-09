import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultState, NUM_SLOTS } from '../js/state.js';
import { normalizeGenContext, GEN_ROLES } from '../js/gen/context.js';
import { defaultProgressionFor } from '../js/gen/progressions.js';

// The Generate panel, without a browser.
//
// Everything musical is tested in gen-*.test.js; what's left in js/genpanel.js is
// the wiring, and the wiring is where the surprises live: which control writes
// which field, whether generating asks before replacing a slot, whether one undo
// entry covers three slots. So this stands up just enough DOM to drive it.
//
// The stub is deliberately dumb — no layout, no events beyond calling the handler
// the panel assigned — and it is built from **the real index.html's ids**, so a
// control the panel reaches for that the page doesn't have is a failure here
// rather than a blank panel in a browser.

const HTML = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const PAGE_IDS = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : !!on;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    // A real control's value is always a string, and the panel relies on that
    // (`+$('genBars').value`), so the stub coerces the way the DOM does.
    this._value = '';
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.options = [];
    this.classList = new FakeClassList();
  }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  add(option) { this.options.push(option); }
  // The two ways the panel drives a control, so a test reads like a user.
  set(value) {
    this.value = String(value);
    this.onchange?.();
  }
  slide(value) {
    this.value = String(value);
    this.oninput?.();
  }
  click() { this.onclick?.(); }
  toggleCheck(on) {
    this.checked = on;
    this.onchange?.();
  }
}

function fakeDom() {
  const els = new Map();
  const el = id => {
    if (!PAGE_IDS.has(id)) throw new Error(`index.html has no element #${id}`);
    if (!els.has(id)) els.set(id, new FakeElement(id));
    return els.get(id);
  };
  globalThis.document = {
    getElementById: id => el(id),
    activeElement: null,
  };
  globalThis.Option = class {
    constructor(text, value) { this.text = text; this.value = String(value); }
  };
  return { el, els };
}

let dom;
let GeneratePanel;

beforeEach(async () => {
  dom = fakeDom();
  // Imported after the DOM stub exists — the module itself touches nothing at
  // import time, but this keeps the order honest.
  ({ GeneratePanel } = await import('../js/genpanel.js'));
});

// A panel over a fresh state, with the calls it makes back into main.js recorded.
function mount({ deviceKind = () => 'DN2', confirms = true, state = defaultState() } = {}) {
  const log = { undo: [], slotsChanged: 0, harmonyChanged: 0, status: [], persists: 0, confirms: 0 };
  globalThis.window = {
    confirm: msg => { log.confirms++; log.lastConfirm = msg; return confirms; },
  };
  const panel = new GeneratePanel({
    state,
    persist: () => { log.persists++; },
    pushUndo: slots => log.undo.push(slots),
    setStatus: (msg, isError = false) => log.status.push({ msg, isError }),
    deviceKind,
    onSlotsChanged: () => { log.slotsChanged++; },
    onHarmonyChanged: () => { log.harmonyChanged++; },
  });
  panel.sync();
  return { panel, state, log, el: dom.el };
}

const lastStatus = log => log.status.at(-1) ?? { msg: '', isError: false };

describe('opening the panel', () => {
  it('backfills state.gen from nothing', () => {
    const state = defaultState();
    expect(state.gen).toBe(null);
    mount({ state });
    expect(state.gen).toEqual(normalizeGenContext(null, NUM_SLOTS));
  });

  it('fills every menu it owns', () => {
    const { el } = mount();
    expect(el('genGenre').options.map(o => o.value)).toEqual(['dnb', 'breaks', 'electro', 'house']);
    expect(el('genBars').options.map(o => o.value)).toEqual(['1', '2', '4', '8']);
    expect(el('genRoot').options.length).toBe(12);
    // No "Off" in the generate panel's scale menu: the generator always needs one.
    expect(el('genScale').options.map(o => o.text)).not.toContain('Off');
    for (const role of GEN_ROLES) {
      const cap = role[0].toUpperCase() + role.slice(1);
      expect(el(`genSlot${cap}`).options.length).toBe(NUM_SLOTS);
    }
  });

  it('shows the context in the controls', () => {
    const { el, state } = mount();
    expect(el('genGenre').value).toBe(state.gen.genre);
    expect(el('genProg').value).toBe(state.gen.progression);
    expect(el('genSeed').value).toBe(String(state.gen.seed));
    expect(el('genDensBassLabel').textContent).toBe(`${state.gen.parts.bass.density}%`);
    expect(el('genMotionLabel').textContent).toBe(`${state.gen.feel.motion}%`);
  });

  it('names the slot menus after the patterns in them', () => {
    const { el, state } = mount();
    state.patterns[0].name = 'A01 T3';
    el('genGenre').set('dnb'); // any edit re-syncs
    expect(el('genSlotBass').options[0].text).toBe('1 · A01 T3');
  });

  it('offers the genre\'s tempo without changing it', () => {
    const { el, state, log } = mount();
    expect(state.bpm).toBe(138);
    expect(el('genBpmHint').textContent).toMatch(/172–176 BPM/);
    expect(el('genSetBpm').textContent).toBe('Set 174 BPM');
    expect(el('genSetBpm').disabled).toBe(false);
    el('genSetBpm').click();
    expect(state.bpm).toBe(174);
    expect(el('genSetBpm').disabled).toBe(true);
    expect(lastStatus(log).msg).toMatch(/174 BPM/);
  });
});

describe('the song controls', () => {
  it('switching genre takes its bars and its progression', () => {
    const { el, state } = mount();
    el('genGenre').set('house');
    expect(state.gen.genre).toBe('house');
    expect(state.gen.bars).toBe(1);
    expect(state.gen.progression).toBe(defaultProgressionFor('house'));
  });

  it('switching genre keeps a progression you typed yourself', () => {
    const { el, state } = mount();
    el('genProg').set('ii7 v7 i7');
    el('genGenre').set('electro');
    expect(state.gen.progression).toBe('ii7 v7 i7');
  });

  it('Root and Scale write the Harmony panel\'s own values', () => {
    const { el, state, log } = mount();
    el('genRoot').set(7);
    el('genScale').set('Dorian');
    expect(state.scaleRoot).toBe(7);
    expect(state.scale).toBe('Dorian');
    expect(state.gen.root).toBe(7);
    expect(state.gen.scale).toBe('Dorian');
    expect(log.harmonyChanged).toBe(2);
  });

  it('follows the Harmony panel when it has a scale on', () => {
    const { el, state, panel } = mount();
    state.scaleRoot = 3;
    state.scale = 'Phrygian';
    panel.sync();
    expect(el('genRoot').value).toBe('3');
    expect(el('genScale').value).toBe('Phrygian');
  });

  it('keeps its own scale while the grid\'s tinting is off', () => {
    const { el, state, panel } = mount();
    state.scale = 'off';
    panel.sync();
    expect(el('genScale').value).toBe('Minor');
    expect(state.gen.scale).toBe('Minor');
  });

  it('keeps a malformed progression on screen, explains it, and refuses to generate', () => {
    const { el, state, log } = mount();
    const good = state.gen.progression;
    el('genProg').set('i VIII');
    // The context keeps the last good progression…
    expect(state.gen.progression).toBe(good);
    // …but what was typed stays in the field to be fixed, with the reason under it.
    expect(el('genProg').value).toBe('i VIII');
    expect(lastStatus(log).isError).toBe(true);
    expect(el('genProgHint').classList.contains('error')).toBe(true);
    expect(el('genProgHint').textContent).toMatch(/isn't a chord quality/);

    el('genRun').click();
    expect(log.undo).toEqual([]);
    expect(lastStatus(log).msg).toMatch(/Can't generate/);

    // Fixing it clears the complaint.
    el('genProg').set('i VI');
    expect(state.gen.progression).toBe('i VI');
    expect(el('genProgHint').classList.contains('error')).toBe(false);
    el('genRun').click();
    expect(log.undo.length).toBe(1);
  });

  it('accepts one that parses, and describes it', () => {
    const { el, state } = mount();
    el('genProg').set('i7:2 iv7:2');
    expect(state.gen.progression).toBe('i7:2 iv7:2');
    expect(el('genProgHint').textContent).toMatch(/4 bars/);
    expect(el('genProgHint').classList.contains('error')).toBe(false);
  });

  it('shuffles to another of the genre\'s progressions', () => {
    const { el, state } = mount();
    const before = state.gen.progression;
    el('genProgNext').click();
    expect(state.gen.progression).not.toBe(before);
    expect(el('genProg').value).toBe(state.gen.progression);
  });

  it('rolls and locks the seed', () => {
    const { el, state } = mount();
    const before = state.gen.seed;
    el('genSeedRoll').click();
    expect(state.gen.seed).not.toBe(before);
    expect(el('genSeed').value).toBe(String(state.gen.seed));
    expect(state.gen.seedLocked).toBe(false);
    el('genSeedLock').click();
    expect(state.gen.seedLocked).toBe(true);
    expect(el('genSeedLock').classList.contains('active')).toBe(true);
  });

  it('takes a seed typed by hand', () => {
    const { el, state } = mount();
    el('genSeed').set('4242');
    expect(state.gen.seed).toBe(4242);
  });
});

describe('the part and feel controls', () => {
  it('write to the context and persist as they move', () => {
    const { el, state, log } = mount();
    el('genOnChords').toggleCheck(false);
    el('genSlotLead').set(5);
    el('genDensBass').slide(90);
    el('genMotion').slide(0);
    el('genLoose').slide(100);
    el('genHuman').slide(45);
    expect(state.gen.parts.chords.on).toBe(false);
    expect(state.gen.parts.lead.slot).toBe(5);
    expect(state.gen.parts.bass.density).toBe(90);
    expect(state.gen.feel).toEqual({ motion: 0, looseness: 100, humanize: 45 });
    expect(el('genDensBassLabel').textContent).toBe('90%');
    expect(log.persists).toBeGreaterThanOrEqual(6);
  });

  it('warns when two parts are aimed at one slot', () => {
    const { el } = mount();
    el('genSlotLead').set(0);
    expect(el('genSlotHint').textContent).toMatch(/Bass and Lead are both aimed at slot 1/);
    expect(el('genSlotHint').classList.contains('error')).toBe(true);
    el('genSlotLead').set(2);
    expect(el('genSlotHint').classList.contains('error')).toBe(false);
  });

  it('says nothing about a clash with the part switched off', () => {
    const { el } = mount();
    el('genOnLead').toggleCheck(false);
    el('genSlotLead').set(0);
    expect(el('genSlotHint').classList.contains('error')).toBe(false);
  });

  it('says so when Motion is up but no box can be resolved', () => {
    const { el } = mount({ deviceKind: () => null });
    expect(el('genHint').textContent).toMatch(/No box resolvable/);
    el('genMotion').slide(0);
    expect(el('genHint').textContent).not.toMatch(/No box resolvable/);
  });
});

describe('generating an arrangement', () => {
  it('fills the three slots, in one undo entry', () => {
    const { el, state, log } = mount();
    el('genRun').click();
    expect(log.undo).toEqual([[0, 1, 2]]);
    for (const slot of [0, 1, 2]) expect(state.patterns[slot].notes.length).toBeGreaterThan(0);
    expect(state.patterns[3].notes.length).toBe(0);
    expect(log.slotsChanged).toBe(1);
    expect(lastStatus(log).isError).toBe(false);
    expect(lastStatus(log).msg).toMatch(/bass \d+ trigs.* → slot 1/);
  });

  it('names each slot after its genre and part', () => {
    const { el, state } = mount();
    el('genRun').click();
    expect(state.patterns[0].name).toBe('DnB bass');
    expect(state.patterns[1].name).toBe('DnB chords');
    expect(state.patterns[2].name).toBe('DnB lead');
  });

  it('sets the length and leaves swing, PROB and the channel alone', () => {
    const { el, state } = mount();
    state.patterns[0].swing = 62;
    state.patterns[0].trackProb = 40;
    state.patterns[0].channel = 9;
    el('genBars').set(4);
    el('genRun').click();
    expect(state.patterns[0].lengthSteps).toBe(64);
    expect(state.patterns[0].swing).toBe(62);
    expect(state.patterns[0].trackProb).toBe(40);
    expect(state.patterns[0].channel).toBe(9);
  });

  it('only writes the parts that are checked', () => {
    const { el, state, log } = mount();
    el('genOnChords').toggleCheck(false);
    el('genRun').click();
    expect(log.undo).toEqual([[0, 2]]);
    expect(state.patterns[1].notes.length).toBe(0);
  });

  it('refuses when nothing is checked', () => {
    const { el, log } = mount();
    for (const role of ['Bass', 'Chords', 'Lead']) el(`genOn${role}`).toggleCheck(false);
    el('genRun').click();
    expect(log.undo).toEqual([]);
    expect(lastStatus(log).isError).toBe(true);
    expect(lastStatus(log).msg).toMatch(/check at least one part/i);
  });

  it('asks before replacing a slot that has notes, and names them', () => {
    const { el, state, log } = mount();
    el('genRun').click();
    const first = state.patterns[0].notes.length;
    el('genRun').click();
    expect(log.confirms).toBe(1);
    expect(log.lastConfirm).toMatch(/DnB bass/);
    expect(log.lastConfirm).toMatch(new RegExp(`${first} notes`));
    expect(log.undo.length).toBe(2);
  });

  it('changes nothing when that is declined', () => {
    const { el, state, log } = mount();
    el('genRun').click();
    const before = JSON.stringify(state.patterns);
    const undos = log.undo.length;
    Object.assign(globalThis.window, { confirm: () => false });
    el('genRun').click();
    expect(JSON.stringify(state.patterns)).toBe(before);
    expect(log.undo.length).toBe(undos);
    expect(lastStatus(log).msg).toMatch(/cancelled/);
  });

  it('rolls a new seed each time unless it is locked', () => {
    const { el, state } = mount();
    el('genRun').click();
    const a = state.gen.seed;
    const musicA = JSON.stringify(state.patterns[0].notes.map(n => [n.step, n.pitch]));
    el('genRun').click();
    expect(state.gen.seed).not.toBe(a);

    el('genSeed').set(a);
    el('genSeedLock').click();
    el('genRun').click();
    expect(state.gen.seed).toBe(a);
    expect(JSON.stringify(state.patterns[0].notes.map(n => [n.step, n.pitch]))).toBe(musicA);
  });

  it('turns the grid\'s tinting on to the key it just used', () => {
    const { el, state, log } = mount();
    state.scale = 'off';
    el('genRoot').set(9);
    el('genRun').click();
    expect(state.scale).toBe('Minor');
    expect(state.scaleRoot).toBe(9);
    expect(lastStatus(log).msg).toMatch(/tinting turned on/);
  });

  it('draws p-lock lanes for the box it was given, and says when it can\'t', () => {
    const withBox = mount({ deviceKind: () => 'DT2' });
    withBox.el('genMotion').slide(100);
    withBox.el('genRun').click();
    const lanes = withBox.state.patterns[0].plocks;
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) expect(lane.deviceKind).toBe('DT2');
    expect(lastStatus(withBox.log).msg).toMatch(/\+ \d+ lanes?/);

    dom = fakeDom();
    const noBox = mount({ deviceKind: () => null });
    noBox.el('genMotion').slide(100);
    noBox.el('genRun').click();
    expect(noBox.state.patterns[0].plocks).toEqual([]);
    expect(lastStatus(noBox.log).msg).toMatch(/can't tell which box/);
  });

  it('reports a malformed progression instead of generating', () => {
    const { el, state, log } = mount();
    state.gen.progression = 'i nope';   // as a stale save could hold it
    el('genRun').click();
    expect(log.undo).toEqual([]);
    expect(lastStatus(log).isError).toBe(true);
    expect(lastStatus(log).msg).toMatch(/Can't generate/);
  });
});

describe('re-rolling one slot', () => {
  it('is offered for the slot you are editing, and named after its part', () => {
    const { el, state, panel } = mount();
    state.current = 1;
    panel.sync();
    expect(el('genRunSlot').disabled).toBe(false);
    expect(el('genRunSlot').textContent).toMatch(/Re-roll the chords \(slot 2\)/);
  });

  it('is offered no part for a slot nothing is aimed at', () => {
    const { el, state, panel } = mount();
    state.current = 6;
    panel.sync();
    expect(el('genRunSlot').disabled).toBe(true);
    expect(el('genRunSlot').title).toMatch(/isn't assigned to a part/);
  });

  it('changes that slot and leaves the others exactly as they were', () => {
    const { el, state, log } = mount();
    el('genSeedLock').click();
    el('genRun').click();
    const bass = JSON.stringify(state.patterns[0].notes.map(n => [n.step, n.pitch]));
    const chords = JSON.stringify(state.patterns[1].notes.map(n => [n.step, n.pitch]));
    const lead = JSON.stringify(state.patterns[2].notes.map(n => [n.step, n.pitch]));

    state.current = 2;
    el('genRunSlot').click();
    expect(log.undo.at(-1)).toEqual([2]);
    expect(JSON.stringify(state.patterns[0].notes.map(n => [n.step, n.pitch]))).toBe(bass);
    expect(JSON.stringify(state.patterns[1].notes.map(n => [n.step, n.pitch]))).toBe(chords);
    expect(JSON.stringify(state.patterns[2].notes.map(n => [n.step, n.pitch]))).not.toBe(lead);
    expect(lastStatus(log).msg).toMatch(/Re-rolled the lead/);
  });

  it('keeps the seed it was given — only that part\'s variation moves', () => {
    const { el, state } = mount();
    el('genSeedLock').click();
    el('genRun').click();
    const seed = state.gen.seed;
    state.current = 0;
    el('genRunSlot').click();
    expect(state.gen.seed).toBe(seed);
    expect(state.gen.parts.bass.variation).toBe(1);
    expect(state.gen.parts.lead.variation).toBe(0);
  });

  it('never falls through to the whole arrangement when the slot has no part', () => {
    // The button is disabled in this state, but a click must not be read as
    // "generate everything" if it ever arrives anyway.
    const { el, state, log } = mount();
    state.current = 6;
    el('genRunSlot').click();
    expect(log.undo).toEqual([]);
    expect(state.patterns[0].notes.length).toBe(0);
    expect(lastStatus(log).isError).toBe(true);
    expect(lastStatus(log).msg).toMatch(/isn't assigned to a part/);
  });

  it('re-rolls a part whose checkbox is off, since you asked for that slot', () => {
    const { el, state, log } = mount();
    el('genOnLead').toggleCheck(false);
    state.current = 2;
    el('genRunSlot').click();
    expect(log.undo.at(-1)).toEqual([2]);
    expect(state.patterns[2].notes.length).toBeGreaterThan(0);
  });
});
