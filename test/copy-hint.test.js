import { describe, it, expect } from 'vitest';
import { copyHintHtml } from '../js/labs/copy-hint.js';

// Box-to-box copying is only possible in the console, and the two facts that
// make it work are invisible in the row: the loaded source is held in memory,
// and the destination is whatever is connected now. This text is the only place
// the user is told, so each state has to say the right thing.
describe('copyHintHtml', () => {
  const source = { deviceName: 'Digitone II', label: 'A01' };

  it('with no source loaded, names Connect as the destination picker', () => {
    const html = copyHintHtml();
    expect(html).toMatch(/<b>Connect<\/b> is how you choose it/);
    expect(html).toMatch(/Load a source first/);
  });

  it('with a source and no box, says the source keeps waiting', () => {
    const html = copyHintHtml({ source });
    expect(html).toMatch(/Digitone II A01<\/b> is held in memory/);
    expect(html).toMatch(/it stays held: connect a box/);
  });

  it('on the same model, spells out the whole box-to-box route', () => {
    const html = copyHintHtml({ source, targetName: 'Digitone II', crossing: false });
    // The actual answer to "how do I get this into my other box?"
    expect(html).toMatch(/switch the device dropdown at the top/);
    expect(html).toMatch(/the held source survives that/);
    expect(html).toMatch(/Save \.syx/); // the alternative, named as the aside it is
  });

  it('when crossing models, says lanes translate and what to press', () => {
    const html = copyHintHtml({ source, targetName: 'Digitakt II', crossing: true });
    expect(html).toMatch(/Digitone II → Digitakt II/);
    expect(html).toMatch(/matched by parameter name/);
    expect(html).toMatch(/anything untranslatable is listed before you commit/);
    expect(html).toMatch(/Copy to track/);
  });

  // A device name is whatever the box reported over SysEx, so it goes in as text.
  // `<` and `&` are the two that matter in a text node; a lone `>` is inert.
  it('escapes device names rather than trusting them as markup', () => {
    const html = copyHintHtml({ source: { deviceName: '<b>&', label: 'A01' } });
    expect(html).toContain('&lt;b>&amp; A01');
    expect(html).not.toContain('<b>&<');
  });
});
