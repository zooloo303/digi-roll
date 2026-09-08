// Read-only real-hardware check; requires separately installed Playwright.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-browser-midi.mjs
// MIDI_WORKAROUND=1 repeats with MidiMacUmp disabled. Never writes to a device.
import fs from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.LAB_URL || 'http://127.0.0.1:8765/difflab.html';
const workaround = process.env.MIDI_WORKAROUND === '1';
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: false,
  args: workaround ? ['--disable-features=MidiMacUmp'] : [] });
const report = { at: new Date().toISOString(), browser: browser.version(), workaround, url, devices: [] };
try {
  const context = await browser.newContext();
  await context.grantPermissions(['midi', 'midi-sysex'], { origin: new URL(url).origin });
  const page = await context.newPage();
  await page.goto(url);
  report.devices = await page.evaluate(async () => {
    const { ElektronDevice } = await import('./js/elektron/device.js');
    const { defaultRequestFor } = await import('./js/labs/probe.js');
    const access = await navigator.requestMIDIAccess({ sysex: true });
    const inputs = [...access.inputs.values()];
    const results = [];
    for (const output of access.outputs.values()) {
      if (!/Elektron (Digitakt II|Digitone II|Analog Four)/i.test(output.name)) continue;
      const input = inputs.find(i => i.name === output.name);
      if (!input) continue;
      const device = new ElektronDevice(input, output);
      const result = { port: output.name, ok: false };
      try {
        result.identity = await device.identify();
        const request = defaultRequestFor(result.identity.family);
        const dump = await device.fetchDump(result.identity.family, request, 0);
        result.dump = { family: dump.msg.family, request, returnedIndex: dump.msg.index,
          bytes: dump.raw.length, checksumOk: dump.msg.checksumOk, countOk: dump.msg.countOk };
        result.ok = true;
      } catch (error) { result.error = error.message; }
      finally { device.close(); await input.close(); await output.close(); }
      results.push(result);
    }
    return results;
  });
  console.log(JSON.stringify(report, null, 2));
  if (process.env.MIDI_REPORT) await fs.writeFile(process.env.MIDI_REPORT, JSON.stringify(report, null, 2) + '\n');
  if (!report.devices.length || report.devices.some(d => !d.ok)) process.exitCode = 1;
} finally { await browser.close(); }
