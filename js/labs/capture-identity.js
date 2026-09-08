// A MIDI port label is not a verified model or firmware identity. Keep the
// fallback visibly unverified, with no inferred family or write capability.
export function captureIdentity(device) {
  return device?.identity ?? {
    name: `${device?.output?.name || 'MIDI device'} (identity unavailable)`,
    productId: null, slug: 'elektron', family: null, version: '', build: '',
    supported: false,
  };
}
