import { describe, it, expect } from 'vitest';
import { isMacChromium152, isIdentityTimeout, identifyWithConnectionHelp } from '../js/midi-connection-help.js';

describe('MIDI connection guidance', () => {
  it('limits the known-browser clue to Mac Chromium 152, including derivatives', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36';
    expect(isMacChromium152(mac)).toBe(true);
    expect(isMacChromium152(`${mac} Edg/152.0.0.0`)).toBe(true);
    for (const ua of [mac.replace('Macintosh', 'Windows NT 10.0'), mac.replace('152.', '151.'), mac.replace('152.', '153.'), 'Safari/605.1', '']) {
      expect(isMacChromium152(ua)).toBe(false);
    }
  });
  it('recognizes only identity/version timeouts, not permission or write errors', () => {
    expect(isIdentityTimeout(new Error('no reply to API request 0x01 (3 tries)'))).toBe(true);
    expect(isIdentityTimeout(new Error('no reply to API request 0x02 (3 tries)'))).toBe(true);
    for (const msg of ['Access denied', 'no reply to API request 0x20 (3 tries)', 'write failed']) {
      expect(isIdentityTimeout(new Error(msg))).toBe(false);
    }
  });
  it('preserves identity and original failures without changing connection policy', async () => {
    const identity = { name: 'Digitone II', supported: true };
    expect(await identifyWithConnectionHelp({ identify: async () => identity })).toBe(identity);
    const failure = new Error('no reply to API request 0x01 (3 tries)');
    await expect(identifyWithConnectionHelp({ identify: async () => { throw failure; } })).rejects.toBe(failure);
  });
});
