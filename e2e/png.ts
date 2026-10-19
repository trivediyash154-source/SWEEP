import { inflateSync } from 'node:zlib';

/** Minimal decoder for the 8-bit, non-interlaced RGB/RGBA PNGs Playwright writes (filters 0–4). */
export function decodePng(buf: Buffer): { width: number; height: number; channels: number; data: Uint8Array } {
  let p = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('Unsupported PNG (bit depth or interlace).');
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (!channels) throw new Error('Unsupported PNG colour type.');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels]! : 0;
      let v = raw[src + x]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** WCAG relative luminance of the pixel at (x, y). */
export function luminanceAt(img: ReturnType<typeof decodePng>, x: number, y: number): number {
  const i = (Math.round(y) * img.width + Math.round(x)) * img.channels;
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(img.data[i]!) + 0.7152 * lin(img.data[i + 1]!) + 0.0722 * lin(img.data[i + 2]!);
}

export const contrastRatio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
