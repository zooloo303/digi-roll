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
// learn its protocol (Digitone II dumps are PLAN.md Phase 3).
const PRODUCTS = {
  12: { name: 'Digitakt', slug: 'digitakt', family: 0x0a },
  42: { name: 'Digitakt II', slug: 'digitakt2', family: 0x14 },
  43: { name: 'Digitone II', slug: 'digitone2', family: null }, // id captured from hardware 2026-08-01; dump family byte still unknown
};

const REQUEST_TIMEOUT_MS = 5000; // elk-herd uses 5 s with 2 retries
const REQUEST_RETRIES = 2;
const DUMP_STALL_MS = 5000;      // max silence between dump stream messages

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

  // Fetch a single pattern-kit dump (one 0x60 request → one 0x50 response).
  // Resolves to the decoded payload bytes of that pattern-kit message.
  fetchPatternKit(index) {
    const family = this.identity?.family;
    if (family == null) throw new Error(`no known dump protocol for ${this.identity?.name ?? 'this device'}`);
    if (this._dumpSink) throw new Error('a dump fetch is already running');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._dumpSink = null;
        reject(new Error(`no response to pattern request (slot ${index})`));
      }, DUMP_STALL_MS);
      this._dumpSink = (raw, msg) => {
        if (msg.family !== family || msg.type !== DUMP.PATTERN_KIT || msg.index !== index) return;
        clearTimeout(timer);
        this._dumpSink = null;
        if (!msg.checksumOk || !msg.countOk) {
          return reject(new Error(`corrupt pattern-kit message (slot ${index})`));
        }
        resolve(msg.payload);
      };
      this._send(buildDumpMessage(family, DUMP.PATTERN_KIT_REQUEST, index));
    });
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
