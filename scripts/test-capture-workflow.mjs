// Run against a local server. Playwright is dev tooling, never a runtime dependency.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-capture-workflow.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    window.sim = { bytes: new Uint8Array(31744), sent: [], slot: null, delay: 0, corrupt: false, productId: 30 };
    window.sim.bytes[3] = 11;
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => {
      const { parseSysEx, buildApiMessage, buildDumpMessage } = await import('/js/elektron/protocol.js');
      const input = { id: 'input', name: 'Elektron Syntakt', handlers: new Set(),
        addEventListener(t, fn) { this.handlers.add(fn); }, removeEventListener(t, fn) { this.handlers.delete(fn); } };
      const text = s => [...s].map(c => c.charCodeAt(0));
      const output = { id: 'output', name: input.name, send(raw) {
        const m = parseSysEx(raw); window.sim.sent.push({ kind: m.kind, type: m.type, apiId: m.apiId, index: m.index });
        let reply;
        if (m.kind === 'api') reply = buildApiMessage(1, m.apiId + 128,
          m.apiId === 1 ? [window.sim.productId, 0, ...text('Syntakt'), 0] : [...text('0082'), 0, ...text('1.40'), 0], m.msgId);
        else if (m.family === 22 && m.type >= 0x60 && m.type <= 0x6e) {
          reply = buildDumpMessage(22, m.type - 16, window.sim.slot ?? m.index, window.sim.bytes);
          if (window.sim.corrupt) reply[reply.length - 5] ^= 1;
        }
        if (reply) setTimeout(() => { for (const fn of input.handlers) fn({ data: reply }); }, window.sim.delay);
      } };
      return { inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]) };
    } });
  });
  const url = (process.env.LAB_URL || 'http://127.0.0.1:8765/difflab.html') + '?checklist=trig,velocity,micro&issue=8';
  await page.goto(url);
  await page.selectOption('#port', 'output'); await page.click('#connect');
  await page.waitForFunction(() => document.querySelector('#deviceInfo').textContent.includes('Syntakt'));
  assert.equal(await page.locator('#capA').isDisabled(), true);
  await page.fill('#experimentBefore', 'empty'); await page.click('#capA');
  await page.waitForFunction(() => !document.querySelector('#capB').disabled);
  assert.equal(await page.locator('#experimentBefore').isDisabled(), true);
  assert.equal(await page.locator('#experimentSelect').isDisabled(), true);
  await page.evaluate(() => { window.sim.bytes[4] = 3; window.sim.bytes[5] = 129; window.sim.delay = 250; });
  await page.click('#capB');
  assert.equal(await page.locator('#labProbe').isDisabled(), true);
  await page.waitForFunction(() => !document.querySelector('#experimentAfter').disabled && document.querySelector('#diffPane').textContent.includes('2 bytes'));
  assert.equal(await page.locator('#saveExperiment').isDisabled(), true);
  await page.fill('#experimentAfter', 'trig on'); await page.click('#saveExperiment');
  assert.equal(await page.locator('#saveExperiment').isDisabled(), true);
  assert.equal(await page.locator('#capB').isDisabled(), true);
  await page.click('#nextExperiment');
  assert.equal(await page.locator('#experimentSelect').inputValue(), 'velocity');
  assert.equal(await page.locator('#capB').isDisabled(), true);
  assert.equal(await page.locator('#saveExperiment').isDisabled(), true);
  assert.equal(await page.locator('#experimentAfter').inputValue(), '');
  await page.check('#beforeUnknown'); await page.click('#capA');
  await page.waitForFunction(() => !document.querySelector('#capB').disabled);
  // Wrong returned slot cannot become a pair, even with a pinned requested slot.
  await page.evaluate(() => { window.sim.slot = 1; }); await page.click('#capB');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('baseline is'));
  assert.equal(await page.locator('#saveExperiment').isDisabled(), true);
  await page.evaluate(() => { window.sim.slot = null; window.sim.corrupt = true; }); await page.click('#capB');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('corrupt'));
  assert.equal(await page.locator('#saveExperiment').isDisabled(), true);
  await page.evaluate(() => { window.sim.corrupt = false; window.sim.delay = 0; });
  await page.click('#capB'); // unchanged is allowed
  await page.waitForFunction(() => document.querySelector('#diffPane').textContent.includes('Nothing changed'));
  await page.check('#afterUnknown'); await page.click('#saveExperiment');
  await page.click('#nextExperiment');
  assert.equal(await page.locator('#experimentSelect').inputValue(), 'micro');
  assert.equal(await page.locator('#saveExperiment').isDisabled(), true);
  await page.fill('#experimentBefore', '0'); await page.click('#capA');
  await page.waitForFunction(() => !document.querySelector('#capB').disabled);
  // A reconnect invalidates the active pair while retaining saved evidence.
  await page.click('#connect'); await page.waitForFunction(() => !document.querySelector('#connect').disabled);
  assert.equal(await page.locator('#capB').isDisabled(), true);
  assert.match(await page.locator('#sessionSummary').textContent(), /2 experiment/);
  console.log('Capture cycles and error handling passed; running the real probe loop against simulated replies.');
  // Exercise the real probe with the simulator, including session report retention.
  await page.click('#labProbe');
  await page.waitForFunction(() => !document.querySelector('#labProbe').disabled, null, { timeout: 45000 });
  assert.match(await page.locator('#sessionSummary').textContent(), /1 probe report/);
  const downloaded = page.waitForEvent('download'); await page.click('#downloadSession');
  const download = await downloaded; const zip = '/tmp/digiroll-workflow.zip'; await download.saveAs(zip);
  const files = JSON.parse(execFileSync('python3', ['-c',
    'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))', zip], { encoding: 'utf8' }));
  const session = JSON.parse(files['session.json']);
  assert.equal(session.pairs.length, 2); assert.equal(session.reports.length, 1);
  assert.equal(session.pairs[0].experiment.before, 'empty');
  assert.equal(session.pairs[1].experiment.beforeUnknown, true);
  assert.equal(session.pairs[1].experiment.afterUnknown, true);
  // Every exported pair remains openable by the existing reader.
  await page.click('#guideToggle');
  const pairPath = '/tmp/digiroll-workflow-pair.json'; fs.writeFileSync(pairPath, files['pairs/capture-001.json']);
  await page.setInputFiles('#labImportPairInput', pairPath);
  await page.waitForFunction(() => document.querySelector('#captureInfo').textContent.includes('from digiroll-workflow-pair'));
  assert.equal(await page.locator('#labExportPair').isDisabled(), true);
  await page.click('#guideToggle');
  assert.equal(await page.locator('#saveExperiment').isDisabled(), true);
  await page.evaluate(() => { window.sim.productId = 12; });
  await page.click('#connect'); await page.waitForFunction(() => !document.querySelector('#connect').disabled);
  assert.match(await page.locator('#sessionSummary').textContent(), /0\/3 checklist/);
  await page.evaluate(() => { window.sim.productId = 30; });
  await page.click('#connect'); await page.waitForFunction(() => !document.querySelector('#connect').disabled);
  assert.match(await page.locator('#sessionSummary').textContent(), /2\/3 checklist/);
  const sent = await page.evaluate(() => window.sim.sent);
  assert.ok(sent.every(m => m.kind === 'api' ? [1, 2].includes(m.apiId) : m.type >= 0x60 && m.type <= 0x6e));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/digiroll-capture-workflow.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.goto((process.env.LAB_URL || 'http://127.0.0.1:8765/difflab.html') + '?checklist=layout&issue=8');
  assert.equal(await page.locator('#experimentTrack').inputValue(), '2');
  assert.equal(await page.locator('#experimentStep').inputValue(), '5');
  assert.equal(await page.locator('#sessionIssue').getAttribute('href'), 'https://github.com/zooloo303/digi-roll/issues/8');
  console.log('PASS: fresh cycles, displayed/unknown values, multi-byte and unchanged pairs, corrupt/mismatched captures, busy controls, reconnect, probe, ZIP, imported-pair isolation, no writes, no page errors, narrow layout.');
} finally { await browser.close(); }
