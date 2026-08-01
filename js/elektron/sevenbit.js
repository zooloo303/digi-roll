// 7-bit ↔ 8-bit payload packing, Elektron flavour.
//
// Wire format: groups of up to 7 data bytes, each preceded by one header byte
// carrying their high bits — header bit 6 is the MSB of the first data byte,
// bit 5 the second, and so on. A short final group keeps its header byte with
// the high bits still packed from the top; absent trailing bytes are omitted.
//
// Ported from elk-herd's src/ByteArray/SevenBit.elm — BSD-2-Clause, © mzero.

// 8-bit data → 7-bit-safe wire bytes.
export function encode7(data) {
  const out = new Uint8Array(data.length + Math.ceil(data.length / 7));
  let o = 0;
  for (let g = 0; g < data.length; g += 7) {
    const end = Math.min(g + 7, data.length);
    let head = 0;
    for (let i = g; i < end; i++) head |= (data[i] & 0x80) >> (i - g + 1);
    out[o++] = head;
    for (let i = g; i < end; i++) out[o++] = data[i] & 0x7f;
  }
  return out;
}

// 7-bit wire bytes → 8-bit data.
export function decode7(wire) {
  if (wire.length % 8 === 1) throw new Error('7-bit data ends with a lone header byte');
  const out = new Uint8Array(wire.length - Math.ceil(wire.length / 8));
  let o = 0;
  for (let g = 0; g < wire.length; g += 8) {
    const head = wire[g];
    const end = Math.min(g + 8, wire.length);
    for (let i = g + 1; i < end; i++) out[o++] = wire[i] | ((head << (i - g)) & 0x80);
  }
  return out;
}
