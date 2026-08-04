// Digitone II curated p-lock parameters.
//
// Same eleven knobs as the DT2 table and the same canonical names — which is
// what makes cross-device copy able to translate them — but **different CC
// numbers**, from Appendix C of the Digitone II User Manual (extracted from the
// OS 1.10D PDF, the exact build on digi-roll's write allowlist).
//
// The `plock` half is **measured on hardware** — the Phase 0 experiments of
// 2026-08-04, run on a DN2 at OS 1.10D (build 0049); the fixture is
// `dumps/fixtures/digitone2-A01-plock-final-2026-08-04.syx` and the log is in
// docs/dn2-pattern-format.md. The boxes do number their parameters differently —
// filter frequency is 74 here and 44 on the DT2, and 74 *on the DT2* means
// overdrive — but the blocks line up (FREQ/RESO/ENV DEPTH at 74/75/76 vs the
// DT2's 44/45/46, CHO/DEL/REV/PAN at 92–95 vs 62–65), and the three LFO depths
// share 29/30/31 on both boxes. This also identified the first real lane ever
// captured (2026-08-04): paramId 74 was a FLTR FREQ lock at ~63.16, not "SYN
// page 1 knob B" as first guessed. The scaling is the same one law as the DT2's:
// value × 256 on digi-roll's MIDI 0–127 display axis. See ../dt2/params.js.
//
// Two DN2-specific facts that shaped this file:
//
//   * **The whole of LFO3 has no CC.** The appendix's CC column is blank for all
//     eight LFO3 parameters — only NRPN is given. So LFO3 depth is auditionable
//     on a DN2 only over NRPN, which is one of the reasons NRPN is the default
//     transport rather than CC.
//   * The appendix says outright that because the machines share CC values,
//     "it is not possible to control high-resolution parameters using CC.
//     Instead, you should use NRPN messages for this purpose."
//
// Retrig is absent for the same reason as on the DT2: no CC, no NRPN, and not a
// single knob.

import { param, scaledPlock } from '../params.js';

export const DEVICE_KIND = 'DN2';

export const PARAMS = [
  param({
    name: 'filter.cutoff', label: 'FLTR FREQ', short: 'CUTOFF',
    cc: 16, nrpn: [1, 20], plock: scaledPlock(74, 256),
  }),
  param({
    // "Data entry knob F (machine dependent)" in the appendix — resonance on the
    // multi-mode and Lowpass 4 filters.
    name: 'filter.resonance', label: 'FLTR RESO', short: 'RESO',
    cc: 17, nrpn: [1, 21], plock: scaledPlock(75, 256),
  }),
  param({
    name: 'filter.envDepth', label: 'FLTR ENV DEPTH', short: 'ENV D',
    cc: 24, nrpn: [1, 26], bipolar: true, plock: scaledPlock(76, 256),
  }),
  param({
    // 89 here, 90 on the DT2 — and the DT2's 89 is Volume, so getting these two
    // tables mixed up would turn a pan sweep into a volume ride.
    name: 'amp.pan', label: 'PAN', short: 'PAN',
    cc: 89, nrpn: [1, 38], bipolar: true, plock: scaledPlock(95, 256),
  }),
  param({
    // Unlike the DT2's appendix, the DN2's does give the FX page an NRPN.
    name: 'fx.overdrive', label: 'OVERDRIVE', short: 'DRIVE',
    cc: 81, nrpn: [1, 8], plock: scaledPlock(104, 256),
  }),
  param({ name: 'fx.delaySend', label: 'DELAY SEND', short: 'DELAY', cc: 30, nrpn: [1, 36], plock: scaledPlock(93, 256) }),
  param({ name: 'fx.reverbSend', label: 'REVERB SEND', short: 'REVERB', cc: 31, nrpn: [1, 37], plock: scaledPlock(94, 256) }),
  param({ name: 'fx.chorusSend', label: 'CHORUS SEND', short: 'CHORUS', cc: 29, nrpn: [1, 35], plock: scaledPlock(92, 256) }),
  param({ name: 'lfo1.depth', label: 'LFO1 DEPTH', short: 'LFO1', cc: 109, nrpn: [1, 49], bipolar: true, plock: scaledPlock(29, 256) }),
  param({ name: 'lfo2.depth', label: 'LFO2 DEPTH', short: 'LFO2', cc: 118, nrpn: [1, 57], bipolar: true, plock: scaledPlock(30, 256) }),
  // No CC at all — NRPN only, per the appendix.
  param({ name: 'lfo3.depth', label: 'LFO3 DEPTH', short: 'LFO3', nrpn: [1, 72], bipolar: true, plock: scaledPlock(31, 256) }),
];
