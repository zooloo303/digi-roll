// The curated p-lock parameter tables, by device kind.
//
// Its own module rather than part of params.js so the per-device tables can
// import the descriptor helper from there without an import cycle: params.js
// knows nothing about devices, the tables know nothing about each other, and
// this is the one place that knows both exist.
//
// `kind` is `spec.device` — 'DT2' / 'DN2' — so a caller holding a device spec
// already has the key, and no protected device module needed editing to add
// this. A lane always remembers which box's numbering it belongs to; see
// state.js's p-lock lanes.

import { PARAMS as DT2_PARAMS } from './dt2/params.js';
import { PARAMS as DN2_PARAMS } from './dn2/params.js';

export const PARAM_TABLES = {
  DT2: DT2_PARAMS,
  DN2: DN2_PARAMS,
};

export const DEVICE_KINDS = Object.keys(PARAM_TABLES);

// The curated set for a device kind. An unknown kind — none today, but a lane
// loaded from an old bank file could name one — gets an empty table, which reads
// as "nothing curated" everywhere and so degrades to read-only rather than to an
// exception.
export const paramTableFor = kind => PARAM_TABLES[kind] ?? [];

// Parameters that can be *heard* on a given box: they have a CC or an NRPN from
// the manual. All eleven, on both boxes, today.
export const auditableParamsFor = kind => paramTableFor(kind).filter(p => p.auditable);

// Parameters that can be *written into a pattern*: their p-lock paramId has been
// measured on hardware. **None yet** — see PLAN.md's Phase 0. The gap between
// this and `auditableParamsFor` is exactly what is missing from the feature, and
// the UI reads it rather than hard-coding "nothing works yet".
export const writableParamsFor = kind => paramTableFor(kind).filter(p => p.writable);

export const anyWritableParams = () => DEVICE_KINDS.some(k => writableParamsFor(k).length > 0);
