// Pattern bank: named local saves of piano-roll patterns.
//
// Pure frontend, no device involvement — the escape hatch from eight pattern
// slots to as many ideas as you like. Entries live in localStorage one key per
// pattern (`digiroll.bank.<name>`), so a corrupt or oversized entry can never
// take the whole bank down with it, and every entry carries a schema number so
// a future model change has something to migrate from.
//
// Everything is written against a Storage-shaped object (getItem/setItem/
// removeItem/key/length) rather than localStorage directly, which is what
// makes the serialize/deserialize pair unit-testable in Node.

export const BANK_PREFIX = 'digiroll.bank.';
export const BANK_SCHEMA = 1;

const defaultStorage = () => globalThis.localStorage;

// The stored shape. Notes are stripped to their model fields — ids are
// per-session identity, meaningless once saved, and are reissued on load.
export function serializePattern(pattern, savedAt = new Date().toISOString()) {
  return {
    schema: BANK_SCHEMA,
    savedAt,
    pattern: {
      name: pattern.name,
      lengthSteps: pattern.lengthSteps,
      channel: pattern.channel,
      swing: pattern.swing ?? 50,
      source: pattern.source ?? null,
      // prob/fill/cond ride along without a schema bump: older saves simply
      // lack them and load unlocked, and older digi-rolls ignore the extra
      // keys. All three are null when nothing is locked.
      notes: pattern.notes.map(n => ({
        step: n.step,
        pitch: n.pitch,
        len: n.len,
        velocity: n.velocity,
        micro: n.micro ?? 0,
        prob: n.prob ?? null,
        fill: n.fill ?? null,
        cond: n.cond ?? null,
      })),
    },
  };
}

// Stored entry → a pattern ready to drop into a slot, with fresh note ids.
// `makeNote` is injected so this module stays free of state.js's id counter
// (and so tests can watch what it produces).
export function deserializePattern(entry, makeNote) {
  if (!entry || typeof entry !== 'object') throw new Error('not a pattern bank entry');
  if (entry.schema !== BANK_SCHEMA) {
    throw new Error(`pattern was saved by a different version of digi-roll (schema ${entry.schema ?? '?'}, expected ${BANK_SCHEMA})`);
  }
  const p = entry.pattern;
  if (!p || !Array.isArray(p.notes)) throw new Error('pattern bank entry has no notes');
  return {
    name: String(p.name ?? 'Untitled'),
    lengthSteps: Number(p.lengthSteps) || 16,
    channel: Number(p.channel) || 0,
    swing: typeof p.swing === 'number' ? p.swing : 50,
    source: p.source ?? null,
    notes: p.notes.map(n => makeNote(n.step, n.pitch, n.len, n.velocity, n.micro ?? 0, n)),
  };
}

// --- Storage ------------------------------------------------------------------

export function listBank(storage = defaultStorage()) {
  const names = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(BANK_PREFIX)) names.push(key.slice(BANK_PREFIX.length));
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export function bankEntry(name, storage = defaultStorage()) {
  const raw = storage.getItem(BANK_PREFIX + name);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // a hand-mangled entry shouldn't break the list
  }
}

export function saveToBank(name, pattern, storage = defaultStorage()) {
  const clean = String(name).trim();
  if (!clean) throw new Error('give the pattern a name');
  storage.setItem(BANK_PREFIX + clean, JSON.stringify(serializePattern(pattern)));
  return clean;
}

export function loadFromBank(name, makeNote, storage = defaultStorage()) {
  const entry = bankEntry(name, storage);
  if (!entry) throw new Error(`“${name}” isn't in the bank`);
  return deserializePattern(entry, makeNote);
}

export function deleteFromBank(name, storage = defaultStorage()) {
  storage.removeItem(BANK_PREFIX + name);
}

export function renameInBank(from, to, storage = defaultStorage()) {
  const clean = String(to).trim();
  if (!clean) throw new Error('give the pattern a name');
  if (clean === from) return clean;
  const raw = storage.getItem(BANK_PREFIX + from);
  if (raw == null) throw new Error(`“${from}” isn't in the bank`);
  storage.setItem(BANK_PREFIX + clean, raw);
  storage.removeItem(BANK_PREFIX + from);
  return clean;
}

// --- Export / import ------------------------------------------------------------
// One JSON file for the whole bank (or any subset): the share-and-backup
// escape hatch, and the only format that outlives clearing your browser data.

export function exportBank(names, storage = defaultStorage()) {
  return JSON.stringify({
    format: 'digi-roll pattern bank',
    schema: BANK_SCHEMA,
    exportedAt: new Date().toISOString(),
    entries: names.map(name => ({ name, ...bankEntry(name, storage) })),
  }, null, 2);
}

// Parse an exported file. Returns the entries; the caller decides what to do
// about name collisions.
export function parseBankFile(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('not a JSON file');
  }
  if (!doc || !Array.isArray(doc.entries)) throw new Error('not a digi-roll pattern bank file');
  if (doc.schema !== BANK_SCHEMA) {
    throw new Error(`bank file schema ${doc.schema ?? '?'} — this digi-roll reads schema ${BANK_SCHEMA}`);
  }
  return doc.entries.map(e => {
    if (!e?.name) throw new Error('a bank entry in the file has no name');
    return e;
  });
}

// Write parsed entries into the bank. Colliding names get " (2)", " (3)", …
// rather than silently overwriting something you already had.
export function importBank(entries, storage = defaultStorage()) {
  const added = [];
  for (const e of entries) {
    const { name, ...entry } = e;
    let unique = name, n = 2;
    while (storage.getItem(BANK_PREFIX + unique) != null) unique = `${name} (${n++})`;
    storage.setItem(BANK_PREFIX + unique, JSON.stringify(entry));
    added.push(unique);
  }
  return added;
}
