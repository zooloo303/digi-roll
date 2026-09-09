// Contributor recipes describe physical edits, never inferred byte layouts.
export const EXPERIMENTS = {
  trig: { title: 'Add a trig', track: 1, step: 1, prep: 'Use an empty scratch pattern. Check this step is empty before taking the before snapshot.', edit: 'Add one trig at the chosen track and step. Leave its other settings alone.' },
  velocity: { title: 'Trig velocity', track: 1, step: 1, prep: 'Use an existing trig. Read its velocity on the screen.', edit: 'Change only this trig’s velocity. Record the displayed values.' },
  length: { title: 'Trig length', track: 1, step: 1, prep: 'Use an existing trig. Read its length on the screen.', edit: 'Change only this trig’s length. Copy the display exactly, including fractions or INF.' },
  micro: { title: 'Trig microtiming', track: 1, step: 1, prep: 'Use an existing trig. Read its timing on the screen.', edit: 'Move only this trig’s timing. Include the direction: earlier/later, left/right, or the displayed sign.' },
  pitch: { title: 'Trig pitch', track: 1, step: 1, prep: 'Use an existing trig. Read its note on the screen.', edit: 'Change only this trig’s pitch. Include the octave if displayed.' },
  'pattern-length': { title: 'Pattern length', prep: 'Read the pattern length. Keep its scale mode unchanged.', edit: 'Change only the pattern length. Several stored fields may change; that is fine.' },
  tempo: { title: 'Pattern tempo', prep: 'If your box offers pattern/global tempo modes, select pattern tempo before capturing. Read the tempo on the screen.', edit: 'Change only the tempo and record both displayed values. Keep the tempo mode unchanged.' },
  swing: { title: 'Swing', prep: 'Read the swing value on the screen.', edit: 'Change only swing and record both displayed values, including the percent sign if shown.' },
  layout: { title: 'Pitch on another track and step', track: 2, step: 5, prep: 'Place a trig on the chosen track and step before taking the before snapshot.', edit: 'Change only that trig’s pitch. Include the octave if displayed.' },
  'default-note': { title: 'Track default note', track: 1, prep: 'Use a trig without an individual pitch lock on this track.', edit: 'Change only the track’s default note. Leave the trig unlocked.' },
  custom: { title: 'Another edit', track: 1, step: 1, prep: 'Describe the requested experiment in the note. Prepare the box before taking the before snapshot.', edit: 'Make the one requested edit and record what the screen showed.' },
};
export const STANDARD = ['trig', 'velocity', 'length', 'micro', 'pitch', 'pattern-length', 'tempo', 'swing'];
export function checklistFromURL(url) {
  const query = new URL(url).searchParams.get('checklist');
  if (!query) return [...STANDARD];
  const ids = query.split(',');
  if (!ids.length || ids.length > 20 || ids.some(id => !Object.hasOwn(EXPERIMENTS, id))) {
    throw new Error('This checklist link is not recognised. Choose an experiment below or use the standard checklist.');
  }
  return [...new Set(ids)];
}
export function checklistLink(url, ids) {
  if (!ids.length || ids.some(id => !Object.hasOwn(EXPERIMENTS, id))) throw new Error('Unknown experiment');
  const link = new URL(url); link.searchParams.set('checklist', ids.join(',')); return link.href;
}
export function issueLink(url) {
  const issue = new URL(url).searchParams.get('issue');
  return /^[1-9]\d*$/.test(issue ?? '')
    ? `https://github.com/zooloo303/digi-roll/issues/${issue}`
    : 'https://github.com/zooloo303/digi-roll/issues/new?template=map-my-device.yml';
}
export function detailErrors(id, details, { after = false } = {}) {
  const recipe = EXPERIMENTS[id];
  if (!recipe) return ['Choose an experiment.'];
  const errors = [];
  for (const field of ['track', 'step']) if (recipe[field] != null
      && (!/^\d+$/.test(String(details[field])) || +details[field] < 1 || +details[field] > 128)) {
    errors.push(`Enter the ${field} number shown on your box (1–128).`);
  }
  if (!details.before?.trim() && !details.beforeUnknown) errors.push('Enter the before value or choose unknown / not displayed.');
  if (after && !details.after?.trim() && !details.afterUnknown) errors.push('Enter the after value or choose unknown / not displayed.');
  if (id === 'custom' && !details.note?.trim()) errors.push('Describe the requested edit in the note.');
  return errors;
}
export function experimentNote(id, details) {
  const r = EXPERIMENTS[id];
  return [r.title, r.track != null ? `track ${details.track}` : '', r.step != null ? `step ${details.step}` : '',
    `${details.beforeUnknown ? 'unknown / not displayed' : details.before} → ${details.afterUnknown ? 'unknown / not displayed' : details.after}`,
    details.note?.trim()].filter(Boolean).join('; ');
}
