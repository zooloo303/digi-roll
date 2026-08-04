// The one sentence the Copy track row can't say with controls alone.
//
// Two facts make box-to-box copying possible and neither is visible in the row:
// a loaded source is a **snapshot in memory** that nothing clears, and the
// destination is whatever is connected *now*. So you load a source off box A,
// switch the device dropdown, Connect box B, and copy — no file needed. The
// source picker and the destination label both say "the connected box", which
// makes that unguessable; hence this text, which changes with the state it is
// describing.
//
// It lives in its own module, and is pure, for the same reason
// `writeResultMessage` does: wording this load-bearing should be provable
// without a browser or a box.

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// `source`     the held copy source, or null — { deviceName, label }
// `targetName` the connected box's name, or null when nothing is connected
// `crossing`   true when the source came off a different model than the target,
//              which is the case the row exists for and the only one where lanes
//              are translated rather than copied
export function copyHintHtml({ source = null, targetName = null, crossing = false } = {}) {
  if (!source) {
    return 'The destination is always the connected box, so <b>Connect</b> is how you choose it. '
      + 'Load a source first — either a pattern off the box in front of you, or a saved <code>.syx</code>.';
  }
  const held = `<b>${esc(source.deviceName)} ${esc(source.label)}</b> is held in memory`;
  if (!targetName) {
    return `${held}, and it stays held: connect a box and it becomes the destination.`;
  }
  if (crossing) {
    return `${held} — copying <b>${esc(source.deviceName)} → ${esc(targetName)}</b>. `
      + 'P-lock lanes are matched by parameter name across the two boxes; anything untranslatable is '
      + 'listed before you commit. Pick the source and target tracks and hit <b>Copy to track…</b>.';
  }
  // Same model as the source — so this is the moment to say how you reach the
  // other one, because nothing else in the UI will.
  return `${held}. To copy it into your <em>other</em> box, switch the device dropdown at the top and `
    + 'hit <b>Connect</b> — the held source survives that, and the new box becomes the destination. '
    + '(<b>Save .syx</b> keeps it for a later session instead.)';
}
