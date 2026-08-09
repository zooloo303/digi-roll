// Capture pairs: the diff lab's shareable unit of evidence.
//
// A pair is one baseline capture and one after-the-edit capture of the same
// slot, with the note saying what the one edit was — the whole experiment in a
// single JSON file. It exists so a contributor whose box we can't decode (or
// don't own) can hand us real bytes: they run the experiment, export the pair,
// and post it; we import it here and read the diff with no box attached.
//
// The two messages are stored as the complete SysEx the box sent, base64'd —
// not a re-encoding. On an unmapped box the version bytes and framing are part
// of the evidence, and a rebuild through buildDumpMessage would quietly
// normalise them.

import { parseSysEx } from '../elektron/protocol.js';

export const PAIR_KIND = 'digi-roll capture pair';
export const PAIR_VERSION = 1;

// btoa/atob work on binary *strings*, so the array crosses in chunks small
// enough not to blow the argument limit of apply().
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Build the JSON text of a pair. `device` is the identity of the box it came
// off ({ name, productId, build, version, slug }); `family`/`requestType`/
// `index` are what the captures were fetched with — for an unmapped box those
// came from a probe, and re-capturing needs them verbatim.
export function buildCapturePair({
  device, family, requestType, index, note = '', capturedAt,
  baselineRaw, afterRaw,
}) {
  return JSON.stringify({
    kind: PAIR_KIND,
    version: PAIR_VERSION,
    device: {
      name: device.name, productId: device.productId,
      build: device.build, version: device.version, slug: device.slug,
    },
    family, requestType, index, note, capturedAt,
    baseline: bytesToBase64(baselineRaw),
    after: bytesToBase64(afterRaw),
  }, null, 2);
}

// Parse and validate a pair file. Throws with a message meant for the status
// line — a malformed donation should say what is wrong with it, since the
// person who made it is usually not the person reading the error.
export function parseCapturePair(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('not a JSON file'); }
  if (obj?.kind !== PAIR_KIND) throw new Error('not a digi-roll capture pair (missing its kind marker)');
  if (obj.version !== PAIR_VERSION) throw new Error(`capture pair version ${obj.version} — this digi-roll reads version ${PAIR_VERSION}`);

  const side = (name, b64) => {
    if (typeof b64 !== 'string' || !b64.length) throw new Error(`the ${name} capture is missing`);
    const raw = base64ToBytes(b64);
    const msg = parseSysEx(raw);
    if (msg.kind !== 'dump') throw new Error(`the ${name} capture isn't an Elektron dump message`);
    if (!msg.checksumOk || !msg.countOk) throw new Error(`the ${name} capture is corrupt (checksum mismatch)`);
    return { raw, msg, payload: msg.payload };
  };

  const baseline = side('baseline', obj.baseline);
  const after = side('after', obj.after);
  if (baseline.msg.family !== after.msg.family || baseline.msg.type !== after.msg.type
      || baseline.msg.index !== after.msg.index) {
    throw new Error('the two captures are not of the same slot — a pair must watch one pattern');
  }

  // A donation is often hand-edited, so the device block can be missing or
  // partial. Normalise it to strings here: everything downstream — the diff
  // record, the notebook entry it gets saved as, the notebook renderer at the
  // next page load — assumes these fields exist, and an undefined smuggled into
  // localStorage once kept the page from booting until storage was cleared.
  const id = obj.device ?? {};
  const str = v => (typeof v === 'string' ? v : '');
  return {
    device: {
      name: str(id.name) || 'unknown device',
      build: str(id.build),
      version: str(id.version),
      slug: str(id.slug),
      productId: id.productId ?? null,
    },
    family: obj.family ?? baseline.msg.family,
    requestType: obj.requestType ?? baseline.msg.type + 0x10,
    index: obj.index ?? baseline.msg.index,
    note: obj.note ?? '',
    capturedAt: obj.capturedAt ?? null,
    baseline,
    after,
  };
}
