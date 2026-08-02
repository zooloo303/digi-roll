// Browser file download, the one line of DOM plumbing every "save this to
// disk" feature needs (pattern backups, bank exports).

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

export const downloadBytes = (name, bytes, type = 'application/octet-stream') =>
  downloadBlob(name, new Blob([bytes], { type }));

export const downloadText = (name, text, type = 'application/json') =>
  downloadBlob(name, new Blob([text], { type }));
