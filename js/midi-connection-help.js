// Browser detection is only a troubleshooting hint; never a connection/write gate.
export function isMacChromium152(userAgent = globalThis.navigator?.userAgent ?? '') {
  return /Macintosh/.test(userAgent) && /(?:Chrome|Chromium)\/152\./.test(userAgent);
}

export function isIdentityTimeout(error) {
  return /^no reply to API request 0x0[12] \(3 tries\)$/.test(error?.message ?? '');
}

export function showConnectionHelp(error, doc = globalThis.document) {
  if (!doc) return;
  let notice = doc.getElementById('midiConnectionHelp');
  if (!error || !isIdentityTimeout(error)) {
    if (notice) notice.hidden = true;
    return;
  }
  if (!notice) {
    notice = doc.createElement('aside');
    notice.id = 'midiConnectionHelp';
    notice.setAttribute('role', 'status');
    (doc.querySelector('.topbar, header') ?? doc.body.firstElementChild).after(notice);
  }
  const message = isMacChromium152()
    ? 'This Mac browser may have the Chrome 152 MIDI bug: notes can work while device replies fail. A tested Chrome launcher is available. '
    : 'No device identity reply arrived. See connection troubleshooting for browser and MIDI routing checks. ';
  const link = doc.createElement('a');
  link.href = 'midi-help.html';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Connection help and Mac workaround ↗';
  notice.replaceChildren(doc.createTextNode(message), link);
  notice.hidden = false;
}

// Keep the original error and all existing per-page handling. A successful retry
// hides the hint, including on Chrome 152 with the workaround already applied.
export async function identifyWithConnectionHelp(device) {
  showConnectionHelp(null);
  try {
    return await device.identify();
  } catch (error) {
    showConnectionHelp(error);
    throw error;
  }
}
