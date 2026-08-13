// Device layer: identity handshake, version info, whole-project dump fetch.
//
// Identity does NOT use the universal MIDI identity request — Elektron boxes
// answer their own API instead: opcode 0x01 (Device) returns a product id and
// the device name, 0x02 (Version) returns OS build + version strings.
// Protocol behaviour ported from elk-herd (BSD-2-Clause, © mzero):
// src/SysEx.elm, src/Elektron/Instrument.elm, src/Project/Update.elm.

import { buildApiMessage, buildDumpMessage, parseSysEx, API, DUMP } from './protocol.js';

// Product ids from the Device response. Only boxes with a known dump family
// byte (`family`) can be backed up; anything else stays read-only until we
// learn its protocol.
const PRODUCTS = {
  12: { name: 'Digitakt', slug: 'digitakt', family: 0x0a },
  20: { name: 'Digitone', slug: 'digitone', family: 0x0d }, // productId from elk-herd; family confirmed against real DN1 captures 2026-08-13
  42: { name: 'Digitakt II', slug: 'digitakt2', family: 0x14 },
  43: { name: 'Digitone II', slug: 'digitone2', family: 0x15 }, // both values captured from real hardware 2026-08-01 (family byte via 0x60 probe sweep)
};

// Which box a MIDI port name looks like, without asking it.
//
// The real answer comes from the identity handshake (`identify()` below), but
// that needs SysEx permission and a round trip, and the main page deliberately
// puts both off until you actually send or fetch something. Until then the port
// name is all we have — and it is enough to tell a Digitone II from a Digitakt II
// in the MIDI output menu, which is what the UI needs to stop offering you the
// wrong box's parameters.
//
// Longest name first, so "Elektron Digitakt II" isn't claimed by the gen-1
// "Digitakt" entry it starts with. A name we don't recognise returns null, and
// every caller treats that as "don't know" rather than as a default.
const PRODUCTS_BY_NAME_LENGTH = Object.values(PRODUCTS)
  .sort((a, b) => b.name.length - a.name.length);

export function slugFromPortName(portName) {
  if (!portName) return null;
  const lower = portName.toLowerCase();
  return PRODUCTS_BY_NAME_LENGTH.find(p => lower.includes(p.name.toLowerCase()))?.slug ?? null;
}

const REQUEST_TIMEOUT_MS = 5000; // elk-herd uses 5 s with 2 retries
const REQUEST_RETRIES = 2;
const DUMP_STALL_MS = 5000;      // max silence between dump stream messages

// The read-only guard shared by fetchDump and the probe: dump *requests* are
// 0x60–0x6e. An 0x5n message is what stores a payload on the box, so refusing
// everything outside the request range makes these paths incapable of writing —
// which matters most when the box belongs to a contributor mapping it for us.
function assertRequestOpcode(type) {
  if (!Number.isInteger(type) || type < 0x60 || type > 0x6e) {
    throw new Error(`0x${Number(type).toString(16)} is not a dump request opcode — refusing to send it`);
  }
}

const cp1252 = new TextDecoder('windows-1252');

// Null-terminated Windows-1252 string at `start`; returns [value, nextOffset].
function cstring(bytes, start) {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return [cp1252.decode(bytes.subarray(start, end)), end + 1];
}

export class ElektronDevice {
  constructor(input, output, { onSend, onReceive } = {}) {
    this.input = input;
    this.output = output;
    this.onSend = onSend;
    this.onReceive = onReceive;
    this.identity = null;
    this._pending = new Map(); // msgId → { apiId, resolve }
    this._nextMsgId = 20000;   // elk-herd starts here to stay clear of Transfer's ids
    this._dumpSink = null;
    this._onMidi = e => this._handleMessage(e.data);
    this.input.addEventListener('midimessage', this._onMidi);
  }

  close() {
    this.input.removeEventListener('midimessage', this._onMidi);
    this._pending.clear();
    this._dumpSink = null;
  }

  _send(bytes) {
    this.onSend?.(bytes);
    this.output.send(bytes);
  }

  _handleMessage(data) {
    if (data[0] !== 0xf0) return; // real-time / channel traffic, not ours
    this.onReceive?.(data);
    const msg = parseSysEx(data);
    if (msg.kind === 'api' && msg.respId !== 0) {
      const pending = this._pending.get(msg.respId);
      if (pending && msg.apiId === pending.apiId + API.RESPONSE) {
        this._pending.delete(msg.respId);
        pending.resolve(msg.args);
      }
    } else if (msg.kind === 'dump') {
      this._dumpSink?.(data, msg);
    }
  }

  _requestOnce(apiId, args) {
    return new Promise((resolve, reject) => {
      const msgId = this._nextMsgId;
      this._nextMsgId = this._nextMsgId >= 0xffff ? 20000 : this._nextMsgId + 1;
      const timer = setTimeout(() => {
        this._pending.delete(msgId);
        reject(new Error('timed out'));
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(msgId, { apiId, resolve: v => { clearTimeout(timer); resolve(v); } });
      this._send(buildApiMessage(msgId, apiId, args));
    });
  }

  async _request(apiId, args = []) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._requestOnce(apiId, args);
      } catch (err) {
        if (attempt >= REQUEST_RETRIES) {
          throw new Error(`no reply to API request 0x${apiId.toString(16).padStart(2, '0')} (${attempt + 1} tries)`);
        }
      }
    }
  }

  // Handshake: who are you, what OS? Returns and stores the identity.
  async identify() {
    const dev = await this._request(API.DEVICE);
    const productId = dev[0];
    const supportedIds = [...dev.subarray(2, 2 + dev[1])];
    const [reportedName] = cstring(dev, 2 + dev[1]);

    const ver = await this._request(API.VERSION);
    const [build, afterBuild] = cstring(ver, 0);
    const [version] = cstring(ver, afterBuild);

    const product = PRODUCTS[productId];
    this.identity = {
      productId,
      supportedIds,
      name: product?.name ?? reportedName ?? `Elektron device #${productId}`,
      slug: product?.slug ?? 'elektron',
      family: product?.family ?? null,
      build,      // e.g. "0070" — what struct-version gating keys off later
      version,    // e.g. "1.15B" — the human-facing OS version
      supported: (product?.family ?? null) != null, // "we can fetch its dumps"
    };
    return this.identity;
  }

  // Fetch one dump of any type from any family: one 0x6n request → one 0x5n
  // response (the response opcode is always the request minus 0x10). This is
  // the generic primitive under fetchPatternKit, and the diff lab's way of
  // capturing from a box whose family byte was just discovered by a probe —
  // before any code knows the device.
  //
  // `family` and `requestType` are explicit rather than read off the identity,
  // because for an unmapped box there is nothing on the identity to read.
  // Resolves to { payload, raw, msg }: `raw` is the complete SysEx message
  // exactly as the box sent it — an unknown box's version bytes and framing are
  // evidence, so captures keep the original rather than a re-encoding.
  fetchDump(family, requestType, index, { what = `dump 0x${requestType.toString(16)}` } = {}) {
    assertRequestOpcode(requestType);
    if (this._dumpSink) throw new Error('a dump fetch is already running');
    const responseType = requestType - 0x10;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._dumpSink = null;
        reject(new Error(`no response to ${what} request (slot ${index})`));
      }, DUMP_STALL_MS);
      this._dumpSink = (raw, msg) => {
        if (msg.family !== family || msg.type !== responseType || msg.index !== index) return;
        clearTimeout(timer);
        this._dumpSink = null;
        if (!msg.checksumOk || !msg.countOk) {
          return reject(new Error(`corrupt ${what} message (slot ${index})`));
        }
        resolve({ payload: msg.payload, raw: Uint8Array.from(raw), msg });
      };
      this._send(buildDumpMessage(family, requestType, index));
    });
  }

  // Fetch a single pattern-kit dump (one 0x60 request → one 0x50 response).
  // Resolves to the decoded payload bytes of that pattern-kit message.
  async fetchPatternKit(index) {
    const family = this.identity?.family;
    if (family == null) throw new Error(`no known dump protocol for ${this.identity?.name ?? 'this device'}`);
    const { payload } = await this.fetchDump(family, DUMP.PATTERN_KIT_REQUEST, index, { what: 'pattern-kit' });
    return payload;
  }

  // Send a batch of dump *requests* and report every dump message that comes
  // back — the tool form of the probe sweep that discovered the DN2's family
  // byte (0x15, 2026-08-01, done by hand at the time). Responses carry their
  // own family and type bytes, so a batch needs no per-request bookkeeping:
  // whatever answers, answers identifiably.
  //
  //   probes      [{ family, type, index }] — `type` MUST be a request opcode
  //   paceMs      gap between sends, so an unknown box is never flooded
  //   settleMs    silence after the last send (or last reply) before resolving;
  //               generous by default because a full pattern dump takes seconds
  //               to cross USB-MIDI and arrives as one message at the end
  //   onProgress  ({ sent, total } | { received }) for the UI
  //
  // Resolves to [{ family, type, index, bytes, ok, raw }], one per reply.
  // This function is structurally incapable of writing: an 0x5n message is what
  // *stores* a payload on a box, and the opcode guard refuses to send one — the
  // probe exists so strangers can point it at patterns they care about.
  async probeDumpRequests(probes, { paceMs = 120, settleMs = 5000, onProgress = () => {} } = {}) {
    for (const p of probes) assertRequestOpcode(p.type);
    if (this._dumpSink) throw new Error('a dump fetch is already running');

    const findings = [];
    await new Promise(resolve => {
      let timer = null;
      let allSent = false;
      const finish = () => { clearTimeout(timer); this._dumpSink = null; resolve(); };
      const arm = () => { clearTimeout(timer); timer = setTimeout(finish, settleMs); };

      this._dumpSink = (raw, msg) => {
        findings.push({
          family: msg.family, type: msg.type, index: msg.index,
          bytes: msg.payload.length, ok: msg.checksumOk && msg.countOk,
          raw: Uint8Array.from(raw),
        });
        onProgress({ received: findings.length });
        if (allSent) arm(); // replies can trail the last send by seconds
      };

      (async () => {
        for (let i = 0; i < probes.length; i++) {
          this._send(buildDumpMessage(probes[i].family, probes[i].type, probes[i].index ?? 0));
          onProgress({ sent: i + 1, total: probes.length });
          await new Promise(r => setTimeout(r, paceMs));
        }
        allSent = true;
        arm();
      })();
    });
    return findings;
  }

  // Write a pattern-kit: there is no "write request" in the protocol — you
  // send an unsolicited dump *response* (0x50) and the box stores it in that
  // slot. No reply comes back; resolves after a pacing delay so the box can
  // digest before the caller re-reads to verify (elk-herd paces sends at
  // 800 bytes/ms for the DT family).
  sendPatternKit(index, payload) {
    const family = this.identity?.family;
    if (family == null) throw new Error(`no known dump protocol for ${this.identity?.name ?? 'this device'}`);
    const msg = buildDumpMessage(family, DUMP.PATTERN_KIT, index, payload);
    this._send(msg);
    return new Promise(resolve => setTimeout(resolve, Math.ceil(msg.length / 800) + 100));
  }

  // Fetch a whole-project dump: one 0x6F request, then the box streams
  // pattern-kit (0x50) and sound (0x53) responses and finishes with a single
  // project-settings (0x54) response — the only end-of-stream marker there is.
  // Resolves to the raw concatenated SysEx messages (a replayable .syx file).
  fetchProjectDump(onProgress) {
    const family = this.identity?.family;
    if (family == null) throw new Error(`no known dump protocol for ${this.identity?.name ?? 'this device'}`);
    if (this._dumpSink) throw new Error('a dump fetch is already running');

    return new Promise((resolve, reject) => {
      const chunks = [];
      let timer;
      const finish = err => {
        clearTimeout(timer);
        this._dumpSink = null;
        if (err) return reject(err);
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        resolve(out);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(
          chunks.length ? `dump stream stalled after ${chunks.length} messages` : 'no response to project dump request'
        )), DUMP_STALL_MS);
      };

      this._dumpSink = (raw, msg) => {
        if (msg.family !== family) return;
        if (!msg.checksumOk || !msg.countOk) {
          return finish(new Error(`corrupt dump message (type 0x${msg.type.toString(16)}, index ${msg.index}) — backup aborted`));
        }
        chunks.push(raw.slice());
        onProgress?.(chunks.length);
        arm();
        if (msg.type === DUMP.PROJECT_SETTINGS) finish();
      };

      arm();
      this._send(buildDumpMessage(family, DUMP.WHOLE_PROJECT_REQUEST, 0));
    });
  }
}
