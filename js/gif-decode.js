// Minimal GIF89a decoder: returns fully composited RGBA frames (disposal-aware).

export function decodeGif(buffer) {
  const d = new Uint8Array(buffer);
  if (d.length < 13 || d[0] !== 0x47 || d[1] !== 0x49 || d[2] !== 0x46) throw new Error('Not a GIF file');

  let p = 6;
  const width = d[p] | (d[p + 1] << 8);
  const height = d[p + 2] | (d[p + 3] << 8);
  const flags = d[p + 4];
  p += 7;

  let gct = null;
  if (flags & 0x80) {
    const n = 2 << (flags & 7);
    gct = d.subarray(p, p + 3 * n);
    p += 3 * n;
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const frames = [];
  let gce = { disposal: 0, transIdx: -1, delay: 0 };

  while (p < d.length) {
    const b = d[p++];
    if (b === 0x21) {
      const label = d[p++];
      if (label === 0xf9) {
        const packed = d[p + 1];
        gce = {
          disposal: (packed >> 2) & 7,
          transIdx: packed & 1 ? d[p + 4] : -1,
          delay: (d[p + 2] | (d[p + 3] << 8)) * 10,
        };
      }
      p = skipSubBlocks(d, p);
    } else if (b === 0x2c) {
      const ix = d[p] | (d[p + 1] << 8);
      const iy = d[p + 2] | (d[p + 3] << 8);
      const iw = d[p + 4] | (d[p + 5] << 8);
      const ih = d[p + 6] | (d[p + 7] << 8);
      const f = d[p + 8];
      p += 9;
      let ct = gct;
      if (f & 0x80) {
        const n = 2 << (f & 7);
        ct = d.subarray(p, p + 3 * n);
        p += 3 * n;
      }
      const interlaced = (f & 0x40) !== 0;
      const minCode = d[p++];
      const start = p;
      let total = 0;
      for (let q = p; d[q]; q += d[q] + 1) total += d[q];
      const data = new Uint8Array(total);
      let o = 0;
      while (d[p]) {
        const len = d[p++];
        data.set(d.subarray(p, p + len), o);
        o += len;
        p += len;
      }
      p++;
      if (p <= start) break;

      const indices = lzw(data, minCode, iw * ih);
      const saved = gce.disposal === 3 ? rgba.slice() : null;
      const rows = interlaced ? interlaceRows(ih) : null;

      if (ct) {
        for (let y = 0; y < ih; y++) {
          const dy = iy + (rows ? rows[y] : y);
          if (dy >= height) continue;
          for (let x = 0; x < iw; x++) {
            const dx = ix + x;
            if (dx >= width) continue;
            const idx = indices[y * iw + x];
            if (idx === gce.transIdx) continue;
            const di = (dy * width + dx) * 4;
            rgba[di] = ct[idx * 3];
            rgba[di + 1] = ct[idx * 3 + 1];
            rgba[di + 2] = ct[idx * 3 + 2];
            rgba[di + 3] = 255;
          }
        }
      }

      frames.push({ data: rgba.slice(), delay: gce.delay <= 10 ? 100 : gce.delay });

      if (gce.disposal === 2) {
        for (let y = iy; y < Math.min(height, iy + ih); y++) {
          rgba.fill(0, (y * width + ix) * 4, (y * width + Math.min(width, ix + iw)) * 4);
        }
      } else if (saved) {
        rgba.set(saved);
      }
      gce = { disposal: 0, transIdx: -1, delay: 0 };
    } else {
      break; // 0x3b trailer or garbage
    }
  }

  if (!frames.length) throw new Error('GIF has no frames');
  return { width, height, frames };
}

function skipSubBlocks(d, p) {
  let len;
  while (p < d.length && (len = d[p++])) p += len;
  return p;
}

function interlaceRows(h) {
  const rows = new Array(h);
  let i = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) rows[i++] = y;
  }
  return rows;
}

function lzw(data, minCodeSize, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const MAX = 4096;
  const prefix = new Int16Array(MAX);
  const suffix = new Uint8Array(MAX);
  const stack = new Uint8Array(MAX + 1);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  for (let c = 0; c < clear; c++) suffix[c] = c;

  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let avail = clear + 2;
  let old = -1;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let pi = 0;
  let op = 0;

  while (op < pixelCount) {
    while (bits < codeSize) {
      if (pi >= data.length) return out;
      datum |= data[pi++] << bits;
      bits += 8;
    }
    let code = datum & codeMask;
    datum >>= codeSize;
    bits -= codeSize;

    if (code === clear) {
      codeSize = minCodeSize + 1;
      codeMask = (1 << codeSize) - 1;
      avail = clear + 2;
      old = -1;
      continue;
    }
    if (code === eoi) break;
    if (old === -1) {
      out[op++] = suffix[code];
      old = first = code;
      continue;
    }

    const inCode = code;
    let sp = 0;
    if (code >= avail) {
      stack[sp++] = first;
      code = old;
    }
    while (code > eoi) {
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    first = suffix[code];
    stack[sp++] = first;

    if (avail < MAX) {
      prefix[avail] = old;
      suffix[avail] = first;
      avail++;
      if (avail === 1 << codeSize && codeSize < 12) {
        codeSize++;
        codeMask = (1 << codeSize) - 1;
      }
    }
    old = inCode;
    while (sp > 0 && op < pixelCount) out[op++] = stack[--sp];
  }
  return out;
}
