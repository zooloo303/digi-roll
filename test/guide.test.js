import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guidePlan, guideState, guideDoneText, plainDiffSummary } from '../js/labs/guide.js';

// The guided walkthrough, without a browser.
//
// This is wording and sequencing, and both are load-bearing: a contributor gets
// one first impression, nobody here can watch them have it, and the failure mode
// is silent (they close the tab). Same reason `copy-hint.test.js` exists.
//
// Two things it guards that aren't obvious:
//   - the step machine has to walk *backwards* when a contributor restarts an
//     experiment, or the panel tells them to do something they've already done;
//   - the copy must not leak the protocol vocabulary the panel exists to hide.

const step = (g, key) => g.steps.find(s => s.key === key);

describe('guidePlan', () => {
  it('offers the probe step for a box digi-roll does not recognise', () => {
    expect(guidePlan({ boxKnown: false })).toContain('probe');
  });

  // Probing a DT2 or DN2 would be busywork: their family bytes are already
  // known, so the step would ask for something we have.
  it('skips the probe step for a box we already talk to', () => {
    const plan = guidePlan({ boxKnown: true });
    expect(plan).not.toContain('probe');
    expect(plan[0]).toBe('connect');
    expect(plan.at(-1)).toBe('share');
  });

  it('numbers the steps in the order they are physically done', () => {
    expect(guidePlan({ boxKnown: false }))
      .toEqual(['connect', 'probe', 'baseline', 'edit', 'note', 'share']);
  });
});

describe('guideState', () => {
  it('opens on step one with nothing connected', () => {
    const g = guideState();
    expect(g.current).toBe('connect');
    expect(g.complete).toBe(false);
    expect(step(g, 'connect').state).toBe('now');
    expect(step(g, 'share').state).toBe('todo');
  });

  it('shows the whole path at once, so the end is visible from the start', () => {
    // Seeing that there are six steps and how far along you are is most of what
    // stops someone abandoning halfway.
    const g = guideState();
    expect(g.steps).toHaveLength(6);
    expect(g.steps.map(s => s.number)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const s of g.steps) expect(s.title).toBeTruthy();
  });

  it('advances to the probe once connected to an unrecognised box', () => {
    const g = guideState({ connected: true });
    expect(g.current).toBe('probe');
    expect(step(g, 'connect').state).toBe('done');
  });

  it('advances straight to the baseline on a box we already know', () => {
    const g = guideState({ connected: true, boxKnown: true });
    expect(g.current).toBe('baseline');
  });

  it('asks for the one edit once a baseline is held', () => {
    const g = guideState({ connected: true, probeDone: true, hasBaseline: true });
    expect(g.current).toBe('edit');
    expect(step(g, 'edit').body).toMatch(/one/i);
  });

  // The note is the single most valuable artifact a contributor produces: the
  // offsets are meaningless without knowing which knob moved. So a diff with an
  // empty note is not a finished experiment.
  it('will not move past the note step while the note box is empty', () => {
    const base = { connected: true, probeDone: true, hasBaseline: true, hasDiff: true };
    expect(guideState({ ...base, noteFilled: false }).current).toBe('note');
    expect(guideState({ ...base, noteFilled: true }).current).toBe('share');
  });

  it('is complete only once a pair has actually been exported', () => {
    const done = {
      connected: true, probeDone: true, hasBaseline: true,
      hasDiff: true, noteFilled: true, exported: true,
    };
    expect(guideState(done).complete).toBe(true);
    expect(guideState({ ...done, exported: false }).complete).toBe(false);
  });

  // Going backwards has to work without anything resetting the panel: hitting
  // "Capture baseline" again starts a fresh experiment, and the guide must walk
  // back to "change one thing" rather than still claiming that step is done.
  it('walks back a step when a fresh baseline discards the diff', () => {
    const g = guideState({
      connected: true, probeDone: true, hasBaseline: true,
      hasDiff: false, noteFilled: false, exported: false,
    });
    expect(g.current).toBe('edit');
    expect(step(g, 'baseline').state).toBe('done');
    expect(step(g, 'note').state).toBe('todo');
  });

  it('marks exactly one step as current', () => {
    const g = guideState({ connected: true, probeDone: true, hasBaseline: true });
    expect(g.steps.filter(s => s.state === 'now')).toHaveLength(1);
  });
});

describe('the guided copy avoids the vocabulary it exists to hide', () => {
  // The whole point of guided mode is that "family byte", "0x61" and "offset
  // 88812" are not words a contributor should have to meet. If one leaks back
  // into the copy, the panel is just the old hint with more padding.
  const allCopy = [
    ...guidePlan({ boxKnown: false }).flatMap(() => []),
    ...guideState({ connected: true }).steps.flatMap(s => [s.title, s.body]),
    guideDoneText({ exportedCount: 1 }),
    guideDoneText({ exportedCount: 3 }),
    plainDiffSummary({ regions: 0 }),
    plainDiffSummary({ regions: 2, bytes: 8, annotated: false }),
    plainDiffSummary({ regions: 1, bytes: 1, annotated: true }),
  ].join(' ');

  for (const jargon of [/0x[0-9a-f]/i, /family byte/i, /\boffset/i, /opcode/i, /paramId/i, /sysex/i, /uint16/i]) {
    it(`says nothing matching ${jargon}`, () => {
      expect(allCopy).not.toMatch(jargon);
    });
  }

  it('names buttons that actually exist on the page', () => {
    // A step that tells someone to press a button we renamed is worse than no
    // step at all, so the controls are checked against the real difflab.html.
    const html = readFileSync(fileURLToPath(new URL('../difflab.html', import.meta.url)), 'utf8');
    for (const s of guideState({ connected: true }).steps) {
      if (s.control === 'note box') continue; // an input, not a labelled button
      expect(html).toContain(`>${s.control}<`);
    }
  });
});

describe('plainDiffSummary', () => {
  it('explains an empty diff as a thing to check, not a failure', () => {
    const t = plainDiffSummary({ regions: 0 });
    expect(t).toMatch(/same slot/);
    expect(t).toMatch(/worth reporting/);
  });

  it('tells the contributor they do not have to read the hex', () => {
    // The moment the screen fills with bytes is the moment people conclude they
    // broke something or that they are expected to interpret it.
    for (const args of [{ regions: 1, bytes: 1 }, { regions: 3, bytes: 40 }]) {
      expect(plainDiffSummary(args)).toMatch(/don't have to read/);
    }
  });

  it('counts a single byte in one place without reading like a template', () => {
    expect(plainDiffSummary({ regions: 1, bytes: 1 })).toMatch(/a single byte, in one place/);
    expect(plainDiffSummary({ regions: 2, bytes: 8 })).toMatch(/8 bytes, in 2 separate places/);
  });

  it('says the positions are unmapped when the box has no struct map', () => {
    expect(plainDiffSummary({ regions: 1, bytes: 4, annotated: false }))
      .toMatch(/nobody has mapped your box yet/);
    expect(plainDiffSummary({ regions: 1, bytes: 4, annotated: true }))
      .toMatch(/which part of the pattern/);
  });
});

describe('guideDoneText', () => {
  it('points a finished contributor at the next pair rather than just thanking them', () => {
    expect(guideDoneText({ exportedCount: 1 })).toMatch(/another/i);
  });

  it('reminds someone with several files to attach them together', () => {
    const t = guideDoneText({ exportedCount: 3 });
    expect(t).toMatch(/3 files saved/);
    expect(t).toMatch(/same issue/);
  });
});

// A checklist reading "✓ ✓ 3 ✓ ✓ 6" looks broken, and makes the reader distrust
// the one instruction the panel is actually giving them. Every route to that
// state is one where the later flags are lying — importing someone else's pair
// is the real one (difflab.js filters it, this is the belt to that braces).
describe('guideState never ticks a step past the current one', () => {
  it('shows nothing after the current step as done, whatever the flags claim', () => {
    const g = guideState({
      connected: false, hasBaseline: true, hasDiff: true, noteFilled: true,
    });
    expect(g.current).toBe('connect');
    const after = g.steps.slice(g.steps.findIndex(s => s.state === 'now') + 1);
    expect(after.every(s => s.state === 'todo')).toBe(true);
    expect(g.steps.filter(s => s.state === 'done')).toHaveLength(0);
  });

  it('still ticks everything before the current step', () => {
    const g = guideState({ connected: true, probeDone: true, hasBaseline: true });
    expect(g.steps.map(s => s.state))
      .toEqual(['done', 'done', 'done', 'now', 'todo', 'todo']);
  });
});
