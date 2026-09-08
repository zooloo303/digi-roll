// Measured raw fields only: issue #8, 2026-09-08. This is deliberately not a
// pattern-core SPEC or Studio decoder. No default resolution or unit conversion.
const FORMATS = {
  0x0a: { device: 'Digitakt', version: 9, size: 27648, length: 25001,
    tempo: [24998, 24999], swing: 25004, defaultStart: 900 },
  0x16: { device: 'Syntakt', version: 11, size: 31744, length: 23204,
    tempo: [23202], swing: 23207, defaultStart: 964 },
};
const TRIG_FIELDS = { pitch: 132, velocity: 196, length: 260, microtiming: 324 };

function formatFor(family, requestType, payload) {
  const f = FORMATS[family];
  if (!f || requestType !== 0x60 || !(payload instanceof Uint8Array)
      || payload.length !== f.size) return null;
  const version = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
  return version === f.version ? f : null;
}

export function readMappedFields(family, requestType, payload) {
  const f = formatFor(family, requestType, payload);
  if (!f) throw new Error('Unmapped capture family, request, size or struct version');
  return {
    device: f.device,
    structVersion: f.version,
    // 0xff remains 255: inheritance is a hypothesis, not a resolved note.
    track1Step1Raw: Object.fromEntries(Object.entries(TRIG_FIELDS)
      .map(([name, offset]) => [name, payload[offset]])),
    stepWordBytesRaw: Array.from(payload.subarray(4, 6)),
    // These stable triplets resemble defaults, but no default-edit pair exists.
    defaultCandidateBytes: Array.from(payload.subarray(f.defaultStart, f.defaultStart + 3)),
    patternLengthByteRaw: payload[f.length],
    tempoChangedBytesRaw: f.tempo.map(offset => ({ offset, value: payload[offset] })),
    swingByteRaw: payload[f.swing],
  };
}

export function mappedDescriberFor(family, requestType, payload) {
  const f = formatFor(family, requestType, payload);
  if (!f) return null;
  const labels = new Map(Object.entries(TRIG_FIELDS).map(([name, offset]) =>
    [offset, `track 1 step 1 ${name} (raw byte; units/defaults unresolved)`]));
  if (family === 0x16) {
    labels.set(4, 'track 1 step 1 trig edit (raw high byte; bit meanings unresolved)');
    labels.set(5, 'track 1 step 1 trig edit (raw low byte; bit meanings unresolved)');
  }
  labels.set(f.length, 'pattern length edit (raw byte)');
  labels.set(f.swing, 'swing edit (raw byte; scale unresolved)');
  for (const offset of f.tempo) labels.set(offset, 'tempo edit (raw byte; units unresolved)');
  return offset => labels.get(offset) ?? 'unknown';
}
