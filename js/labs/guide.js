// The diff lab, explained to someone who owns an Elektron box and not a compiler.
//
// The lab's controls are named after the protocol: "family byte", "0x61 pattern",
// "p-lock lane report". That is the right vocabulary for the person adding a
// `SPEC`, and the wrong one for the person we actually need — an Elektronaut with
// a Syntakt who is willing to press six buttons in order. Both audiences use the
// same page, so the difference has to be in what the page *says* and what it
// bothers showing.
//
// This module owns the saying. It is a pure step machine: given what the lab has
// managed to do so far, it returns which step the contributor is on and the
// sentence for each one. No DOM, no device, no bytes — same reason
// `copy-hint.js` is pure. Wording this load-bearing should be provable without a
// browser or a box, because a contributor gets exactly one first impression and
// nobody here can watch them have it.
//
// Rules the copy follows, and the reason each one is a rule:
//
// - **No hex, no opcodes, no offsets.** They are not a detail the contributor
//   needs; the probe fills the family byte in for them (`difflab.js` does this
//   on connect and again after a probe), and the export file carries the offsets
//   whether or not anyone reads them.
// - **Safety is stated as what the box does, not as what the code refuses.**
//   "This page has no button that changes your box" is checkable by looking at
//   the page. The real argument — that `fetchDump` throws on any opcode outside
//   0x60–0x6e — is in CONTRIBUTING.md for the people who can read it, and to
//   everyone else it only proves that overwriting patterns is a thing that can
//   happen.
// - **Every step is one physical action.** "Change exactly one thing on the box"
//   is the entire method; a step that bundles it with a click is a step someone
//   does in the wrong order.

// Each step: `key` for the state machine, `title` as the imperative, `body` as
// the plain-language why-and-how. `control` names the lab button it maps to, so
// the panel can point at the right thing without the copy hard-coding layout.
const STEP_TEXT = {
  connect: {
    title: 'Connect your box',
    control: 'Connect',
    body: 'Plug it into your computer over USB and switch it on. Pick it in the dropdown at the '
      + 'top, then hit <b>Connect</b>. It should say its own name and OS version back at you.',
  },
  probe: {
    title: 'Ask the box how it talks',
    control: 'Probe dump protocol',
    body: 'Hit <b>Probe dump protocol</b> and wait about twenty seconds. It asks your box a hundred '
      + 'polite questions and writes down which ones got an answer. When it finishes, hit '
      + '<b>Copy report</b> — that report on its own is already a real contribution, even if it '
      + 'found nothing. "This box stays silent" is a genuine result and it tells us where to look next.',
  },
  baseline: {
    title: 'Take a “before” snapshot',
    control: 'Capture baseline',
    body: 'Pick a pattern slot in your scratch project, then hit <b>Capture baseline</b>. This reads '
      + 'the pattern out of the box and remembers it. Nothing on your box changes.',
  },
  edit: {
    title: 'Change exactly one thing, then snapshot again',
    control: 'Capture + diff',
    body: 'On the box itself, change <em>one</em> thing and nothing else — put one trig on, or turn '
      + 'one knob one click, or nudge one note\'s length. Then come back and hit '
      + '<b>Capture + diff</b>. One change at a time is the whole trick: if you change two things, '
      + 'we can\'t tell which change caused what.',
  },
  note: {
    title: 'Say what you changed',
    control: 'note box',
    body: 'Type what you did into the note box, in normal words — “put a trig on track 1 step 1” or '
      + '“turned filter cutoff from 64 to 65”. This is the most valuable thing you give us. The '
      + 'numbers are meaningless to us without it, and you are the only person who knows what you touched.',
  },
  share: {
    title: 'Save the file and send it over',
    control: 'Export pair',
    body: 'Hit <b>Export pair</b> to save a small file with both snapshots and your note in it, then '
      + 'attach it to a mapping issue. You don\'t need to understand anything the page printed — the '
      + 'file has everything, and we can re-read it here without your box.',
  },
};

// Which steps apply. A box digi-roll already knows how to talk to has nothing to
// probe for, so offering the step would be busywork on the two boxes we own; for
// a contributor's box it is always step two.
export function guidePlan({ boxKnown = false } = {}) {
  return boxKnown
    ? ['connect', 'baseline', 'edit', 'note', 'share']
    : ['connect', 'probe', 'baseline', 'edit', 'note', 'share'];
}

// The lab state this reads, all of it already tracked by difflab.js:
//   connected   a box answered `identify`
//   boxKnown    digi-roll recognises its dump family byte
//   probeDone   a probe has run this session
//   hasBaseline a baseline capture is held
//   hasDiff     a second capture has been diffed against it
//   noteFilled  the note box is non-empty
//   exported    a capture pair has been saved this session
//
// Returns every step with a state, so the panel can show the whole path at once —
// seeing that there are six steps and four are ticked is most of what stops
// someone closing the tab.
export function guideState({
  connected = false, boxKnown = false, probeDone = false,
  hasBaseline = false, hasDiff = false, noteFilled = false, exported = false,
} = {}) {
  const done = {
    connect: connected,
    probe: probeDone,
    baseline: hasBaseline,
    edit: hasDiff,
    note: hasDiff && noteFilled,
    share: exported,
  };
  const plan = guidePlan({ boxKnown });

  // The current step is the first unfinished one, which makes going backwards
  // work for free: a fresh baseline un-ticks `edit`, and the panel walks back to
  // "change one thing" without anyone resetting it.
  const currentIndex = plan.findIndex(key => !done[key]);
  const current = currentIndex === -1 ? null : plan[currentIndex];

  return {
    current,
    complete: current === null,
    // Ticks are monotonic: nothing past the current step is ever shown as done,
    // even if the underlying flag says so. A checklist that reads ✓ ✓ 3 ✓ ✓ 6
    // looks broken and makes the reader distrust the one instruction they're
    // being given, and every way of reaching that state is one where the later
    // flags are lying anyway (a pair imported from a file being the one that
    // actually happened — see renderGuide in difflab.js).
    steps: plan.map((key, i) => ({
      key,
      number: i + 1,
      ...STEP_TEXT[key],
      state: currentIndex !== -1 && i > currentIndex ? 'todo'
        : done[key] ? 'done' : key === current ? 'now' : 'todo',
    })),
  };
}

// What to say once a pair is exported. A contributor who stops after one pair has
// still helped; one who keeps going is worth far more, so the finish line names
// the next lap rather than just congratulating.
export function guideDoneText({ exportedCount = 1 } = {}) {
  const saved = exportedCount > 1
    ? `<b>${exportedCount} files saved.</b> Attach them all to the same issue.`
    : '<b>Saved.</b> Attach that file to a mapping issue.';
  return saved + ' Upload through the GitHub website, rather than replying by email. '
    + 'Want to do another? Click <b>Capture baseline</b> before making the next edit. '
    + 'Then change one thing, hit <b>Capture + diff</b>, update the note, and <b>Export pair</b>. '
    + 'The baseline does not advance automatically.';
}

// The diff pane in plain language.
//
// A contributor's screen fills with hex the moment their first capture lands, and
// the honest thing to tell them is that it is not addressed to them. Without this
// they reasonably conclude they have done something wrong, or that they need to
// interpret it before posting — and the export file already contains everything
// this pane is showing.
export function plainDiffSummary({ regions = 0, bytes = 0, annotated = false } = {}) {
  if (!regions) {
    return 'Nothing changed between the two snapshots. Either the edit didn\'t land in this pattern '
      + '(check you edited the same slot you captured), or the box stores it somewhere this dump '
      + 'doesn\'t reach — which is itself worth reporting.';
  }
  const scale = regions === 1
    ? `Your edit moved ${bytes === 1 ? 'a single byte' : `${bytes} bytes`}, in one place.`
    : `Your edit moved ${bytes} bytes, in ${regions} separate places.`;
  return `${scale} ${annotated
    ? 'The labels say which part of the pattern each one lives in.'
    : 'The numbers below are raw positions in the file, because nobody has mapped your box yet — '
      + 'those positions are exactly the thing we\'re trying to learn.'} `
    + '<b>You don\'t have to read any of it.</b> Write down what you changed and export the pair.';
}
