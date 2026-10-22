// "Magic wand from the edges": clears background connected to the image border,
// then softens the cut edge and crops to the remaining content.
import { makeCanvas } from './media.js';

export function removeBackground(srcCanvas, tolerance = 40) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(srcCanvas, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const seed = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  const tol2 = tolerance * tolerance * 3;

  const close = (i, s) => {
    if (d[i * 4 + 3] < 10) return true;
    const dr = d[i * 4] - d[s * 4];
    const dg = d[i * 4 + 1] - d[s * 4 + 1];
    const db = d[i * 4 + 2] - d[s * 4 + 2];
    return dr * dr + dg * dg + db * db <= tol2;
  };
  const push = (i, s) => {
    if (seed[i] !== -1 || !close(i, s)) return;
    seed[i] = s;
    queue[qt++] = i;
  };

  for (let x = 0; x < w; x++) {
    push(x, x);
    push((h - 1) * w + x, (h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w, y * w);
    push(y * w + w - 1, y * w + w - 1);
  }
  while (qh < qt) {
    const i = queue[qh++];
    const s = seed[i];
    const x = i % w;
    if (x > 0) push(i - 1, s);
    if (x < w - 1) push(i + 1, s);
    if (i >= w) push(i - w, s);
    if (i < n - w) push(i + w, s);
  }

  // Alpha mask with a 1px feather along the cut.
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = seed[i] === -1 ? d[i * 4 + 3] : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!alpha[i]) continue;
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          sum += alpha[yy * w + xx];
          cnt++;
        }
      }
      d[i * 4 + 3] = Math.round(Math.min(alpha[i], (sum / cnt) * 1.4));
    }
  }
  for (let i = 0; i < n; i++) if (!alpha[i]) d[i * 4 + 3] = 0;
  ctx.putImageData(img, 0, 0);
  return cropToContent(c, d);
}

function cropToContent(c, d) {
  const { width: w, height: h } = c;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return c;
  const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext('2d').drawImage(c, -x0, -y0);
  return out;
}
