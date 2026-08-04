// The curated p-lock parameter model.
//
// A parameter has **two independent mappings**, and keeping them apart is the
// whole design of this file:
//
//   `midi`   how to *hear* it — the CC and NRPN numbers from the boxes' own
//            MIDI implementation appendices (DT2 Appendix B, DN2 Appendix C).
//            Public, published, and confirmable on the box in seconds: send a
//            value and watch the parameter move on screen.
//
//   `plock`  how to *store* it — the `paramId` byte in the pattern's p-lock lane
//            pool, plus the scaling between a display value and the lane's
//            uint16. **Not published anywhere** and different on each box. Exactly
//            one real lane has ever been captured (a DN2's, paramId 74 —
//            docs/dn2-pattern-format.md), which is enough to know the value is
//            14-bit and not enough to know which knob 74 is. The rest comes from
//            the controlled hardware experiments in PLAN.md's Phase 0, and it is
//            `null` on every parameter until then.
//
// The consequence is the useful part: a parameter with `midi` but no `plock` can
// be **drawn and auditioned** but not written to a pattern. That is exactly
// where digi-roll stands today, and it is why the lane UI works now rather than
// waiting on the byte mapping.
//
// A lane is identified by this table's canonical `name` when digi-roll authored
// it, and by the raw `paramId` byte when it came off a box whose numbering we
// can't read yet. Both, once Phase 0 lands. `name` is also what cross-device
// copy translates by — two parameters sharing a name are the same knob.
//
// ## The value axis
//
// Display values here are on the **MIDI value axis, 0–127** — what the box
// receives, and what NRPN's high byte carries. That is a deliberate choice over
// the labels the box prints on screen (`L32`, `-8.00`): those labels differ per
// parameter and per machine, and none of them is documented in a form worth
// trusting. 0–127 is honest about what is being sent, and it is what a p-lock
// lane's own resolution will be compared against once Phase 0 measures it.
// `bipolar` marks the parameters whose 64 is the box's centre, so their bars can
// be drawn from the middle rather than the floor.

// A parameter descriptor. See the header for what `midi` and `plock` mean.
//
//   name      canonical cross-device key, e.g. 'filter.cutoff'
//   label     what the box's own UI calls it, e.g. 'CUTOFF'
//   short     gutter label for the lane strip (the gutter is 52 px)
//   bipolar   64 is the centre of the range, so draw bars from the middle
//   midi      { cc, ccLsb, nrpn: [msb, lsb] } — any of cc/nrpn may be null
//   plock     null, or { id, toStored, fromStored } once measured on hardware
export function param({
  name, label, short = label, unit = '', bipolar = false,
  cc = null, ccLsb = null, nrpn = null, plock = null,
}) {
  if (!name || !label) throw new Error('a p-lock param needs a name and a label');
  if (cc == null && nrpn == null && plock == null) {
    throw new Error(`p-lock param ${name}: no CC, no NRPN and no p-lock id — it would do nothing`);
  }
  if (plock && (!Number.isInteger(plock.id) || plock.id < 0 || plock.id > 0xfe)) {
    throw new Error(`p-lock param ${name}: paramId must be 0–254 (0xFF marks a free lane)`);
  }
  return {
    name, label, short, unit, bipolar,
    min: MIDI_MIN, max: MIDI_MAX, step: 1,
    midi: { cc, ccLsb, nrpn },
    plock,
    curated: true,
    // Can it be heard? Can it be written into a pattern? Two different answers,
    // and every caller that cares asks by name rather than re-deriving it.
    auditable: cc != null || nrpn != null,
    writable: plock != null,
  };
}

export const MIDI_MIN = 0;
export const MIDI_MAX = 127;

// --- Table helpers ------------------------------------------------------------
//
// Every lookup goes through these, so a table with nothing in it behaves like a
// table with nothing matching rather than like a bug.

export const paramByName = (table, name) => table.find(p => p.name === name) ?? null;

// By the p-lock `paramId` byte read out of a pattern. Only ever matches once a
// parameter's `plock` has been measured — which is what keeps digi-roll from
// claiming it knows what a lane in an imported pattern is.
export const paramByPlockId = (table, id) =>
  table.find(p => p.plock && p.plock.id === id) ?? null;

export const auditableParams = table => table.filter(p => p.auditable);

// Clamp a display value into a param's range, on its own resolution.
export function clampParamValue(p, v) {
  const stepped = p.step > 0 ? Math.round(v / p.step) * p.step : v;
  return Math.max(p.min, Math.min(p.max, stepped));
}

// --- Storage scaling (the p-lock lane's uint16) --------------------------------
//
// Only meaningful for a parameter whose `plock` has been measured. A caller must
// check `writable` first; these return null rather than inventing a mapping, so
// a missing measurement can never silently become a wrong byte.

export function storedFromDisplay(p, v) {
  if (!p.plock) return null;
  return p.plock.toStored(clampParamValue(p, v));
}

export function displayFromStored(p, w) {
  if (!p.plock) return null;
  return clampParamValue(p, p.plock.fromStored(w));
}

// The two shapes a measured `plock` scaling is likely to take. Both are here
// ready to use; which one a given parameter needs is what Phase 0 step 4
// determines, by locking known min/centre/max values and reading the words back.
// Do not assume; capture.

// The display value *is* the stored word.
export const plainPlock = id => ({
  id,
  toStored: v => Math.round(v),
  fromStored: w => w,
});

// The stored word is the display value scaled by a constant — the shape a
// high-resolution parameter would take if the lane holds more than 7 bits.
export const scaledPlock = (id, factor) => ({
  id,
  toStored: v => Math.round(v * factor),
  fromStored: w => w / factor,
});

// --- Describing a lane --------------------------------------------------------

// How a lane should be labelled and drawn.
//
// `name` wins when digi-roll authored the lane, because then we know exactly
// which parameter it is. Otherwise we fall back to the raw `paramId` byte — and
// a raw lane is deliberately *not* curated: it is drawn over the whole uint16
// range because we have no idea what its real range is, and it is never edited
// or translated. `deviceKind` is the box whose numbering `paramId` belongs to,
// which is why a DT2 lane is never read as a DN2 one.
export function describeParam(table, { name = null, paramId = null, deviceKind = null } = {}) {
  const byName = name ? paramByName(table, name) : null;
  if (byName) return { ...byName, deviceKind };
  const byId = paramId == null ? null : paramByPlockId(table, paramId);
  if (byId) return { ...byId, deviceKind };

  const hex = paramId == null ? '??' : `0x${paramId.toString(16).padStart(2, '0')}`;
  return {
    name: null,
    label: `${deviceKind ? `${deviceKind} ` : ''}param ${hex}`,
    short: `p ${hex}`,
    unit: '',
    bipolar: false,
    min: 0,
    max: 0xfffe,
    step: 1,
    midi: { cc: null, ccLsb: null, nrpn: null },
    // A raw lane's word passes through untouched in both directions: the only
    // honest scaling for something we can't scale, and what keeps an imported
    // lane byte-exact on the way back out.
    plock: { id: paramId, toStored: v => v, fromStored: w => w },
    curated: false,
    auditable: false,
    writable: paramId != null,
  };
}
