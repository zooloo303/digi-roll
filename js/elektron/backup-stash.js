// The pre-write backup's second copy, in localStorage.
//
// Rule 1 (auto-backup) is served by a .syx download, but a browser download is
// fire-and-forget: a cancelled save dialog or a blocked multi-download produces
// no file and no error, and JS has no way to tell. The stash is the guarantee
// the download can't give — safeWriteTrack puts every backup here *before* the
// download is even offered, so the bytes survive in the browser whether or not
// a file reached disk. The console's Restore row reads it back, including
// across a reload and regardless of which page took the backup.
//
// A ring of the newest STASH_MAX backups, newest first. Payloads are stored
// base64'd; a pattern kit is ~90 KB, so the whole ring stays well inside a
// browser's localStorage quota. Everything here is best-effort by design: a
// full or absent localStorage must never block a write that has its download
// path — so failures return false/[] rather than throwing.

export const STASH_KEY = 'digiroll-backup-stash-v1';
export const STASH_MAX = 4;

const store = () => (typeof localStorage === 'undefined' ? null : localStorage);

const toBase64 = bytes => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

const fromBase64 = b64 => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const load = () => {
  try {
    const v = JSON.parse(store()?.getItem(STASH_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

// Keep a backup. `identity` names the box it came off ({ slug }); `backup` is
// safe-write's { index, payload, name }. Returns whether the bytes are actually
// in the stash.
export function stashBackup(identity, backup, now = new Date()) {
  const s = store();
  if (!s) return false;
  try {
    const entries = [{
      slug: identity?.slug ?? '',
      name: backup.name,
      index: backup.index,
      at: now.toISOString(),
      payload: toBase64(backup.payload),
    }, ...load()].slice(0, STASH_MAX);
    s.setItem(STASH_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false; // quota, private mode — the download path still ran
  }
}

// Stashed backups, newest first, payloads decoded — optionally only one box's.
// An entry that won't decode is skipped rather than poisoning the list.
export function stashedBackups(slug = null) {
  const out = [];
  for (const e of load()) {
    if (slug && e.slug !== slug) continue;
    try {
      out.push({ slug: e.slug, name: e.name, index: e.index, at: e.at, payload: fromBase64(e.payload) });
    } catch { /* skip */ }
  }
  return out;
}
