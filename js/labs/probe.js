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
  0x06: 'Analog Four',
  0x0a: 'Digitakt',
  0x14: 'Digitakt II',
  0x15: 'Digitone II',
};

// The single-response dump request opcodes on the **gen-2** boxes (Digitakt II,
// Digitone II), with what they fetch there.
export const REQUEST_TYPES = {
  0x60: 'pattern+kit',
  0x61: 'pattern',
  0x62: 'kit',
  0x63: 'sound',
  0x64: 'project settings',
};

// The **Analog Four** is a gen-1 box and the same opcodes mean different
// objects, which is the single most misleading thing about pointing this lab at
// one: 0x64 is "project settings" above and *the pattern* here.
//
// Measured through this page against an A4 mk1 on OS 1.55B (build 0195),
// 2026-09-06, by asking for slot 2 and reading back what arrived. 0x61 and 0x6e
// are silent; 0x60 answers with the whole project as a 405-message stream
// (2.3 MB, 9.5 s) rather than a single reply, so it is deliberately absent here
// and excluded from the sweep below.
//
// 0x65 and 0x6b are named "unidentified" because that is what they are:
// 1,304 bytes of something, sixteen of them in the whole-project stream, and
// nothing in this codebase yet knows what. Every report prints the response
// opcode alongside, so the name does not need to carry it.
//
// The 0x68–0x6d twins return the box's *current working state* — what is
// loaded and being edited right now, so an edit shows up with no save and no
// slot touched. Five of them (0x68, 0x6a, 0x6b, 0x6c, 0x6d) answer with the
// loaded slot in the index byte rather than the one you asked for; see the note
// on `fetchDump` in js/elektron/device.js, which is why matching on the
// requested index is wrong.
export const A4_REQUEST_TYPES = {
  0x62: 'kit',
  0x63: 'pool sound',
  0x64: 'pattern',
  0x65: 'unidentified',
  0x66: 'project settings',
  0x67: 'global',
  0x68: 'working kit',
  0x69: 'working pool sound',
  0x6a: 'working pattern',
  0x6b: 'working unidentified',
  0x6c: 'working project settings',
  0x6d: 'working global',
};

// Every single-response request opcode. 0x6f is the whole-project *stream* —
// many messages, not one — so it is not a probe target.
export const ALL_REQUEST_TYPES = Array.from({ length: 0x6f - 0x60 }, (_, i) => 0x60 + i);

// What we know a family's opcodes mean. A family we have never met gets honest
// "request 0x6n" labels rather than another generation's object names — the
// same rule the diff lab applies to struct annotation, for the same reason: a
// contributor's first experiment must not teach them something false.
const UNKNOWN_REQUEST_TYPES = Object.fromEntries(
  ALL_REQUEST_TYPES.map(t => [t, `request 0x${t.toString(16)}`]));

const REQUEST_TYPES_BY_FAMILY = {
  0x06: A4_REQUEST_TYPES,
  0x0a: REQUEST_TYPES,
  0x14: REQUEST_TYPES,
  0x15: REQUEST_TYPES,
};

// The opcode → object map for one family. Callers use it both to fill the
// capture menu and to decide which requests are worth sending.
export function requestTypesFor(family) {
  return REQUEST_TYPES_BY_FAMILY[family] ?? UNKNOWN_REQUEST_TYPES;
}

// What this opcode fetches, **only when we actually know this family's
// dialect** — null otherwise, so a report about an unmapped box says "0x61
// request → 0x51 response" and does not dress that up as knowledge by naming
// the object. `requestTypesFor` cannot answer this: its fallback labels an
// opcode with its own number so the menu has something to show.
export function objectName(family, requestType) {
  return REQUEST_TYPES_BY_FAMILY[family]?.[requestType] ?? null;
}

// A family whose 0x60 is a whole-project stream rather than one reply. Sending
// it mid-sweep buries the report under hundreds of messages and takes ten
// seconds of a contributor's twenty — so pass 1 asks these families for the one
// request that is known to answer with a single dump instead.
const SWEEP_PROBE_TYPES = {
  0x06: [0x64], // the A4's pattern
};

// The pattern-shaped request to point a fresh capture at. "Pattern" is what a
// mapping session is almost always after, and it is not the same opcode on
// every box — 0x60 on the digis, 0x64 on the Analog Four.
export function defaultRequestFor(family) {
  return SWEEP_PROBE_TYPES[family]?.[0] ?? 0x60;
}

// Pass 1's requests for an unmapped family: one pattern-shaped request of each
// style — 0x60 (gen 2's combined dump) and 0x61 (gen 1's bare pattern) —
// because every Elektron box has patterns, whatever else it has.
const DEFAULT_SWEEP_TYPES = [0x60, 0x61];

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

// Pass 1: which family byte answers at all?
export function sweepPlan({ families = candidateFamilies(), index = 0 } = {}) {
  return families.flatMap(family =>
    (SWEEP_PROBE_TYPES[family] ?? DEFAULT_SWEEP_TYPES).map(type => ({ family, type, index })));
}

// Pass 2: a family answered — now ask it everything, so the report says which
// dump types the box supports and how big each one is. A known family is asked
// for the opcodes we know it serves; an unknown one is asked for all of
// 0x60–0x6e, which is how the A4's twelve were found.
export function deepPlan(families, { index = 0 } = {}) {
  return families.flatMap(family =>
    Object.keys(requestTypesFor(family)).map(Number).map(type => ({ family, type, index })));
}

// More replies than this from one family means a stream, not a set of answers:
// the box dumped a whole project at us. The A4's 0x60 sends 405.
const STREAM_REPLIES = 24;

// Group raw probe findings by family: [{ family, known, replies: [{ type,
// requestType, index, bytes, ok }], streamed }]. `requestType` is inferred
// (response opcode + 0x10) so the reader can go straight from the report to a
// capture. Duplicates are collapsed — the deep pass re-asks what the sweep
// already got.
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
    streamed: replies.length > STREAM_REPLIES,
    replies: replies.sort((a, b) => a.type - b.type || a.index - b.index),
  }));
}

// One reply as a report line. The object name comes from the family, so an A4's
// 0x54 reads "pattern" and a Digitakt II's reads "project settings" — they are
// genuinely different objects behind the same byte.
function replyLine(family, r) {
  const label = objectName(family, r.requestType);
  return `- \`${hex2(r.requestType)}\` request → \`${hex2(r.type)}\` response`
    + (label ? ` (${label})` : '')
    + `, ${r.bytes.toLocaleString('en')} bytes, checksum ${r.ok ? 'OK' : 'BAD'} (slot ${r.index + 1})`;
}

// The Markdown a contributor posts to the thread: identity, port name, and
// exactly which requests their box answered. This plus an exported capture
// pair is everything a new device mapping starts from.
export function contributorReport({ identity, portName = '', summary, probed }) {
  const lines = [
    '### digi-roll probe report',
    '',
    `- Device: ${identity.name} (product id ${identity.productId ?? 'unknown'})`,
    `- OS: ${identity.version || 'unknown'} (build ${identity.build || 'unknown'})`,
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
    if (fam.streamed) {
      // Hundreds of lines of one project's contents is not a protocol report.
      // Say what it is, then show the shape of it rather than all of it.
      const byType = new Map();
      for (const r of fam.replies) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
      lines.push(`- ${fam.replies.length} messages — this box streams a whole *project* in reply,`,
        '  rather than answering one request with one dump. Message types:');
      for (const [type, n] of [...byType].sort((a, b) => a[0] - b[0])) {
        lines.push(`  - \`${hex2(type)}\` × ${n}`);
      }
    } else {
      for (const r of fam.replies) lines.push(replyLine(fam.family, r));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
