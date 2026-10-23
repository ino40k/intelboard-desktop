// Rewrite only GIF loop metadata. Pixels, timing and the stored original are
// untouched; no multi-frame decoding or transcoding is needed.
export function loopingGif(buffer) {
  if (buffer.length < 14 || !/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)))
    throw new Error('Invalid GIF header');
  let at = 13 + (buffer[10] & 128 ? 3 * (1 << ((buffer[10] & 7) + 1)) : 0);
  if (at >= buffer.length) throw new Error('Truncated GIF');
  const loop = Buffer.concat([
    Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0]),
  ]);
  // One bounded output allocation, rather than accumulating one object per
  // frame/extension for large GIFs.
  const output = Buffer.allocUnsafe(buffer.length + loop.length);
  buffer.copy(output, 0, 0, at);
  output.write('GIF89a', 0, 'ascii');
  loop.copy(output, at);
  let written = at + loop.length;
  const subblocks = (start) => {
    let end = start;
    while (end < buffer.length) {
      const size = buffer[end++];
      if (size === 0) return end;
      end += size;
    }
    throw new Error('Truncated GIF sub-block');
  };
  while (at < buffer.length) {
    const start = at;
    if (buffer[at] === 0x3b) {
      written += buffer.copy(output, written, at);
      return output.subarray(0, written);
    }
    if (buffer[at] === 0x21) {
      const application = buffer[at + 1] === 0xff && buffer[at + 2] === 11;
      const name = buffer.toString('ascii', at + 3, at + 14);
      at = subblocks(at + 2);
      // Remove existing finite/infinite loop extensions before inserting ours.
      if (application && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(name)) continue;
    } else if (buffer[at] === 0x2c) {
      if (at + 10 > buffer.length) throw new Error('Truncated GIF image');
      const packed = buffer[at + 9];
      at += 10 + (packed & 128 ? 3 * (1 << ((packed & 7) + 1)) : 0);
      at = subblocks(at + 1); // Skip LZW minimum code size.
    } else throw new Error('Invalid GIF block');
    written += buffer.copy(output, written, start, at);
  }
  throw new Error('Missing GIF trailer');
}
