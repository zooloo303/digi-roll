// Digitakt II curated p-lock parameters.
//
// The `midi` half of every entry is **from Elektron's own MIDI implementation
// chart** — Appendix B of the Digitakt II User Manual (extracted from the OS
// 1.15A PDF, and independently matching midi.guide's DT2 table value for value).
// That makes it public, checkable, and confirmable on the box in seconds: send a
// value, watch the parameter move.
//
// The `plock` half is **measured on hardware** — the Phase 0 experiments of
// 2026-08-04, run on a DT2 at OS 1.15B (build 0070), one knob locked per capture
// and the paramId read back off the dump by difflab's p-lock lane report. The
// fixtures are `dumps/fixtures/digitakt2-A01-plock-*-2026-08-04.syx` and the
// experiment log is in docs/dt2-pattern-format.md. The old NRPN-LSB hypothesis
// was WRONG: cutoff's NRPN LSB is 20 but its paramId is 44. paramId is the box's
// own internal parameter index (page-ordered — FREQ/RESO/ENV DEPTH sit at
// 44/45/46, CHO/DEL/REV/PAN at 62–65), and it differs from the DN2's for the
// same knob: 74 means overdrive here and filter frequency there. Translate by
// canonical name, never by paramId.
//
// The scaling is one law for every parameter measured so far: the lane's uint16
// is the box display value normalised onto 15 bits — (display − min) / range ×
// 32768 — which on digi-roll's MIDI 0–127 display axis is simply **value × 256**
// (pan L64 = MIDI 0 → 0x0000; cutoff 127 → 0x7F00; LFO depth +16 = MIDI 72 →
// 0x4800). The box keeps sub-MIDI fine resolution in the low byte, so an
// imported lock can carry a fraction digi-roll's integer axis rounds on the way
// in; re-sending such a lane quantises it to the nearest MIDI step.
//
// Retrig is deliberately absent: it has no CC and no NRPN on either box, and it
// isn't one knob (RATE/LEN/VEL/on-off on TRIG page 2), so there is nothing to
// audition and no reason to assume it is a single lane. It joins the list after
// the diffing shows its shape.

import { param, scaledPlock } from '../params.js';

export const DEVICE_KIND = 'DT2';

// Note the CC values that differ from the DN2's for the *same* knob — pan is 90
// here and 89 there, and Volume is the reverse, so a table shared between the
// boxes would quietly change the wrong thing.
export const PARAMS = [
  param({
    name: 'filter.cutoff', label: 'FLTR CUTOFF', short: 'CUTOFF',
    cc: 74, nrpn: [1, 20], plock: scaledPlock(44, 256),
  }),
  param({
    // The DT2's filter is multi-mode, so the manual calls this "Data entry knob
    // F (machine dependent)" rather than naming it — on every filter machine
    // that has one, knob F is resonance.
    name: 'filter.resonance', label: 'FLTR RESO', short: 'RESO',
    cc: 75, nrpn: [1, 21], plock: scaledPlock(45, 256),
  }),
  param({
    // The DT2 appendix prints NRPN 1/23 for both Env. Depth and Env. Delay,
    // which cannot both be right; the DN2 lists depth at 1/26 and delay at 1/23,
    // so 1/26 is the likelier value here too. The CC (77) is unambiguous, and
    // this is one to confirm on the box before trusting the NRPN.
    name: 'filter.envDepth', label: 'FLTR ENV DEPTH', short: 'ENV D',
    cc: 77, nrpn: [1, 26], bipolar: true, plock: scaledPlock(46, 256),
  }),
  param({
    name: 'amp.pan', label: 'PAN', short: 'PAN',
    cc: 90, nrpn: [1, 38], bipolar: true, plock: scaledPlock(65, 256),
  }),
  param({
    // The DT2 appendix lists no NRPN for the FX-page parameters (bit reduction,
    // overdrive, SRR) — an omission rather than a statement, most likely, but CC
    // is what we have here.
    name: 'fx.overdrive', label: 'OVERDRIVE', short: 'DRIVE',
    cc: 57, plock: scaledPlock(74, 256),
  }),
  param({ name: 'fx.delaySend', label: 'DELAY SEND', short: 'DELAY', cc: 84, nrpn: [1, 36], plock: scaledPlock(63, 256) }),
  param({ name: 'fx.reverbSend', label: 'REVERB SEND', short: 'REVERB', cc: 85, nrpn: [1, 37], plock: scaledPlock(64, 256) }),
  param({ name: 'fx.chorusSend', label: 'CHORUS SEND', short: 'CHORUS', cc: 12, nrpn: [1, 35], plock: scaledPlock(62, 256) }),
  // The LFO depths are high-resolution on the DT2: the appendix gives each a CC
  // LSB as well, so CC alone would lose the bottom 7 bits. NRPN carries all 14,
  // which is the reason digi-roll auditions over NRPN by default.
  param({ name: 'lfo1.depth', label: 'LFO1 DEPTH', short: 'LFO1', cc: 109, ccLsb: 59, nrpn: [1, 49], bipolar: true, plock: scaledPlock(29, 256) }),
  param({ name: 'lfo2.depth', label: 'LFO2 DEPTH', short: 'LFO2', cc: 119, ccLsb: 61, nrpn: [1, 57], bipolar: true, plock: scaledPlock(30, 256) }),
  param({ name: 'lfo3.depth', label: 'LFO3 DEPTH', short: 'LFO3', cc: 86, ccLsb: 63, nrpn: [1, 72], bipolar: true, plock: scaledPlock(31, 256) }),
];
