// The canonical trig-condition tables: PROB, FILL and COND.
//
// One place, imported by everything else. The values here are hardware-mapped,
// not guessed — see the [V2] sections of docs/dt2-pattern-format.md and
// docs/dn2-pattern-format.md for the experiment that produced them.
//
// The Digitakt II and Digitone II turned out to store all three fields
// identically: the same three per-step byte lanes at the same track-relative
// offsets, the same encodings, and the same COND menu in the same order. So
// there is exactly one table and no per-device keying — and cross-device copy
// can never have to drop a value for lack of a target-side equivalent.
//
// All three are per *trig* (per step), not per note. Notes sharing a step form
// one trig, and digi-roll's rule everywhere is that they carry identical
// prob/fill/cond values.

// The byte written into any of the three lanes to mean "nothing stored here".
export const NONE = 0xff;

// --- COND ---------------------------------------------------------------------

// The box's own menu order, which *is* the stored encoding: the byte is the
// zero-based index into this list.
//
// The order rule, read off the hardware: the four logic pairs first, each
// negation immediately after its positive; then the ratios grouped by
// denominator, again with negations interleaved. The `:2` group carries no
// negations, because `!1:2` would just be `2:2`.
function buildCondList() {
  const list = [
    { key: 'PRE', group: 'logic' }, { key: '!PRE', group: 'logic' },
    { key: 'NEI', group: 'logic' }, { key: '!NEI', group: 'logic' },
    { key: '1ST', group: 'logic' }, { key: '!1ST', group: 'logic' },
    { key: 'LST', group: 'logic' }, { key: '!LST', group: 'logic' },
    // The :2 group is written without negations — `!1:2` would just be `2:2`.
    { key: '1:2', group: 'ratio', a: 1, b: 2 },
    { key: '2:2', group: 'ratio', a: 2, b: 2 },
  ];
  for (let b = 3; b <= 8; b++) {
    for (let a = 1; a <= b; a++) {
      list.push({ key: `${a}:${b}`, group: 'ratio', a, b });
      list.push({ key: `!${a}:${b}`, group: 'notratio', a, b });
    }
  }
  return list.map((c, value) => ({ ...c, value }));
}

// 76 entries, `PRE` = 0 … `!8:8` = 75. Indices 0–15 were walked one at a time
// on hardware; the rest was confirmed at five anchors (16, 27, 44, 52, 75).
export const CONDITIONS = Object.freeze(buildCondList().map(c => Object.freeze(c)));

const COND_BY_KEY = new Map(CONDITIONS.map(c => [c.key, c]));

// Grouped for a picker UI: the three headings, in menu order within each.
export const COND_GROUPS = Object.freeze([
  { id: 'logic', label: 'Logic', items: CONDITIONS.filter(c => c.group === 'logic') },
  { id: 'ratio', label: 'A:B', items: CONDITIONS.filter(c => c.group === 'ratio') },
  { id: 'notratio', label: '!A:B', items: CONDITIONS.filter(c => c.group === 'notratio') },
]);

// Ratios split by denominator — what the trig lane's picker offers as tabs.
export const COND_BY_DENOMINATOR = Object.freeze(
  [2, 3, 4, 5, 6, 7, 8].map(b => Object.freeze({
    b,
    items: CONDITIONS.filter(c => c.b === b),
  })),
);

// Stored byte → canonical label, or null for "none".
//
// Unknown values decode to null with a warning rather than throwing: a future
// OS could extend the menu, and a pattern we can't fully read must still open.
export function condFromByte(byte) {
  if (byte === NONE) return null;
  const c = CONDITIONS[byte];
  if (!c) {
    console.warn(`digi-roll: unknown trig condition value ${byte} — treating as none. `
      + `This OS build may have more conditions than digi-roll knows about.`);
    return null;
  }
  return c.key;
}

// Canonical label → stored byte. null/'' → the "none" sentinel. An unknown
// label is a programming error rather than device data, so it throws.
export function condToByte(key) {
  if (key == null || key === '') return NONE;
  const c = COND_BY_KEY.get(key);
  if (!c) throw new Error(`unknown trig condition ${JSON.stringify(key)}`);
  return c.value;
}

export const isCondKey = key => COND_BY_KEY.has(key);

// What a condition means, for tooltips and the help panel.
export function condDescription(key) {
  const c = COND_BY_KEY.get(key);
  if (!c) return '';
  const neg = c.key.startsWith('!');
  if (c.group === 'logic') {
    const base = {
      PRE: 'the previous trig with a condition on this track evaluated true',
      NEI: 'the previous trig with a condition on the neighbour track evaluated true',
      '1ST': 'this is the first loop of the pattern',
      LST: 'this is the last loop of the pattern before it changes',
    }[c.key.replace('!', '')];
    return `Plays when ${neg ? 'NOT ' : ''}${base}`;
  }
  return neg
    ? `Plays on every loop of ${c.b} EXCEPT loop ${c.a}`
    : `Plays on loop ${c.a} of every ${c.b} loops`;
}

// --- PROB ---------------------------------------------------------------------

// The byte is the percentage itself, 0–100. `FF` means no lock, i.e. the track
// default. Note that an explicit 100% lock (`0x64`) is a real, distinct stored
// value — the box writes it when you dial a trig's PROB up to 100 — so decode
// keeps them apart and only the UI collapses 100 to "no lock".
export const PROB_MIN = 0;
export const PROB_MAX = 100;

export function probFromByte(byte) {
  if (byte === NONE) return null;
  if (byte > PROB_MAX) {
    console.warn(`digi-roll: out-of-range trig probability ${byte} — treating as none`);
    return null;
  }
  return byte;
}

export function probToByte(prob) {
  if (prob == null) return NONE;
  return Math.max(PROB_MIN, Math.min(PROB_MAX, Math.round(prob)));
}

// --- FILL ---------------------------------------------------------------------

// Tri-state, not a boolean: the box distinguishes "no lock" from an explicit
// OFF, and there is no track-level FILL for an unlocked trig to fall back to.
//
//   null   no lock — the trig ignores fill mode entirely
//   true   ON  — plays only while FILL is held on the box
//   false  OFF — does not play while FILL is held
export const FILL_OFF_BYTE = 0x00;
export const FILL_ON_BYTE = 0x01;

export function fillFromByte(byte) {
  if (byte === FILL_ON_BYTE) return true;
  if (byte === FILL_OFF_BYTE) return false;
  if (byte !== NONE) {
    console.warn(`digi-roll: unknown trig fill value ${byte} — treating as no lock`);
  }
  return null;
}

export function fillToByte(fill) {
  if (fill == null) return NONE;
  return fill ? FILL_ON_BYTE : FILL_OFF_BYTE;
}

export const FILL_LABEL = { true: 'ON', false: 'OFF' };

// --- The three together --------------------------------------------------------

// Is this trig setting entirely default (nothing to store)? The write path uses
// it to decide which steps need bytes at all.
export const isDefaultTrigSetting = t =>
  !t || (t.prob == null && t.fill == null && t.cond == null);

// A short badge for the roll and the trig lane, e.g. "2:4 50% F". Empty string
// when nothing is set.
export function trigSettingLabel({ prob = null, fill = null, cond = null } = {}) {
  const parts = [];
  if (cond) parts.push(cond);
  if (prob != null) parts.push(`${prob}%`);
  if (fill != null) parts.push(fill ? 'F' : 'F̶');
  return parts.join(' ');
}
