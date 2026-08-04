// Dump-protocol probe: the recipe that discovered the Digitone II's family
// byte (0x15, found 2026-08-01 by sweeping 0x60 requests across candidate
// bytes until one answered), turned into a tool — because it is the first
// thing a contributor with an unmapped box has to do, and until now it was the
// one thing the lab couldn't.
//
// Everything here is pure planning and reporting; the wire work is
// ElektronDevice.probeDumpRequests, which physically refuses to send anything
// but 0x6n *requests*. A probe cannot write to anyone's box.

// Family bytes we have met on real hardware. A sweep tries these first so a
// box we half-know answers in the first seconds rather than the last.
export const KNOWN_FAMILIES = {
  0x0a: 'Digitakt',
  0x14: 'Digitakt II',
  0x15: 'Digitone II',
};

// The single-response dump request opcodes, with what they fetch on the boxes
// we know. Other boxes may only answer a subset — gen 1 splits pattern and kit
// where gen 2 has the combined 0x60 — which is exactly what a sweep finds out.
export const REQUEST_TYPES = {
  0x60: 'pattern+kit',
  0x61: 'pattern',
  0x62: 'kit',
  0x63: 'sound',
  0x64: 'project settings',
};

const hex2 = v => `0x${v.toString(16).padStart(2, '0')}`;

// Candidate family bytes: known ones first, then every remaining value up to
// 0x2f. 0x10 is skipped — a message whose family byte is 0x10 parses as an
// Elektron *API* message rather than a dump (the framing is ambiguous), so a
// request built with it would reach the box as garbage API traffic.
export function candidateFamilies() {
  const known = Object.keys(KNOWN_FAMILIES).map(Number);
  const rest = [];
  for (let f = 0x01; f <= 0x2f; f++) {
    if (f !== 0x10 && !known.includes(f)) rest.push(f);
  }
  return [...known, ...rest];
}

// Pass 1: which family byte answers at all? One pattern-shaped request of each
// style per family — 0x60 (gen 2's combined dump) and 0x61 (gen 1's bare
// pattern) — because every Elektron box has patterns, whatever else it has.
export function sweepPlan({ families = candidateFamilies(), index = 0 } = {}) {
  return families.flatMap(family => [
    { family, type: 0x60, index },
    { family, type: 0x61, index },
  ]);
}

// Pass 2: a family answered — now ask it everything, so the report says which
// dump types the box supports and how big each one is.
export function deepPlan(families, { index = 0 } = {}) {
  return families.flatMap(family =>
    Object.keys(REQUEST_TYPES).map(Number).map(type => ({ family, type, index })));
}

// Group raw probe findings by family: [{ family, known, replies: [{ type,
// requestType, index, bytes, ok }] }]. `requestType` is inferred (response
// opcode + 0x10) so the reader can go straight from the report to a capture.
// Duplicates are collapsed — the deep pass re-asks what the sweep already got.
export function summarizeFindings(findings) {
  const byFamily = new Map();
  const seen = new Set();
  for (const f of findings) {
    const key = `${f.family}:${f.type}:${f.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byFamily.has(f.family)) byFamily.set(f.family, []);
    byFamily.get(f.family).push({
      type: f.type, requestType: f.type + 0x10, index: f.index, bytes: f.bytes, ok: f.ok,
    });
  }
  return [...byFamily.entries()].map(([family, replies]) => ({
    family,
    known: KNOWN_FAMILIES[family] ?? null,
    replies: replies.sort((a, b) => a.type - b.type),
  }));
}

// The Markdown a contributor posts to the thread: identity, port name, and
// exactly which requests their box answered. This plus an exported capture
// pair is everything a new device mapping starts from.
export function contributorReport({ identity, portName = '', summary, probed }) {
  const lines = [
    '### digi-roll probe report',
    '',
    `- Device: ${identity.name} (product id ${identity.productId})`,
    `- OS: ${identity.version} (build ${identity.build})`,
  ];
  if (portName) lines.push(`- MIDI port: ${portName}`);
  lines.push(`- Requests sent: ${probed} (dump requests only — the probe cannot write)`);
  lines.push('');
  if (!summary.length) {
    lines.push('No family byte answered. This box may not have a dump protocol over USB-MIDI,',
      'or it may need a mode/setting enabled — please say what box and OS this is anyway.');
  }
  for (const fam of summary) {
    lines.push(`Family byte \`${hex2(fam.family)}\`${fam.known ? ` (known: ${fam.known})` : ''} answers:`);
    for (const r of fam.replies) {
      lines.push(`- \`${hex2(r.requestType)}\` request → \`${hex2(r.type)}\` response, `
        + `${r.bytes.toLocaleString('en')} bytes, checksum ${r.ok ? 'OK' : 'BAD'} (slot ${r.index + 1})`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
