import { parseCapturePair } from './capture-pair.js';

// Original full pair JSON is kept verbatim; experiment metadata is separate.
export class CaptureSession {
  pairs = [];
  reports = [];
  revision = 0;
  downloadedRevision = 0;
  addPair(text, experiment) {
    const pair = parseCapturePair(text);
    if (pair.family !== pair.baseline.msg.family || pair.requestType !== pair.baseline.msg.type + 0x10
        || pair.index !== pair.baseline.msg.index) throw new Error('Capture metadata does not match the messages');
    if (pair.baseline.payload.length !== pair.after.payload.length) throw new Error('Snapshot sizes differ; take a fresh before snapshot.');
    const number = this.pairs.length + 1;
    this.pairs.push({ name: `pairs/capture-${String(number).padStart(3, '0')}.json`, text,
      experiment: structuredClone(experiment), device: pair.device, capturedAt: pair.capturedAt });
    this.revision++;
  }
  addReport(text, device) {
    this.reports.push({ text, device: structuredClone(device) }); this.revision++;
  }
  get hasUndownloaded() { return this.revision !== this.downloadedRevision; }
  files() {
    if (!this.pairs.length && !this.reports.length) throw new Error('Capture an experiment or run a probe first.');
    return [
      ...this.pairs.map(({ name, text }) => ({ name, text })),
      ...this.reports.map((r, i) => ({ name: `reports/probe-${i + 1}.txt`, text: r.text })),
      { name: 'session.json', text: JSON.stringify({ kind: 'digi-roll capture session', version: 1,
        pairs: this.pairs.map(({ text, ...p }) => p),
        reports: this.reports.map((r, i) => ({ file: `reports/probe-${i + 1}.txt`, device: r.device })),
      }, null, 2) },
      { name: 'README.txt', text: 'Full original capture pairs are in pairs/. Open each JSON with Open pair in the diff lab.\nExperiment details and displayed values are in session.json. Probe reports are in reports/ when a probe was run.\nA missing report means no probe was saved in this session. Unknown display values are explicitly recorded.\nAttach this ZIP through the GitHub issue website, wait for upload to finish, then post the comment. Email replies do not upload these files.\n' },
    ];
  }
}
