// Template-matching tracker: follows whatever is under a layer's box from
// frame f0 forwards and backwards, with mild scale estimation for zooms.
import { makeCanvas } from './media.js';

function toGray(canvas, k) {
  const w = Math.max(8, Math.round(canvas.width * k));
  const h = Math.max(8, Math.round(canvas.height * k));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  return { w, h, g };
}

// Bilinear sample a (cx,cy)-centred box of size bw×bh into an ow×oh patch.
function samplePatch(img, cx, cy, bw, bh, ow, oh) {
  const out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(img.h - 1.001, Math.max(0, cy - bh / 2 + ((y + 0.5) * bh) / oh - 0.5));
    const y0 = sy | 0;
    const fy = sy - y0;
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(img.w - 1.001, Math.max(0, cx - bw / 2 + ((x + 0.5) * bw) / ow - 0.5));
      const x0 = sx | 0;
      const fx = sx - x0;
      const i = y0 * img.w + x0;
      const top = img.g[i] * (1 - fx) + img.g[i + 1] * fx;
      const bot = img.g[i + img.w] * (1 - fx) + img.g[i + img.w + 1] * fx;
      out[y * ow + x] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

function zeroMean(t) {
  let m = 0;
  for (const v of t) m += v;
  m /= t.length;
  let n = 0;
  const z = new Float32Array(t.length);
  for (let i = 0; i < t.length; i++) {
    z[i] = t[i] - m;
    n += z[i] * z[i];
  }
  return { z, norm: Math.sqrt(n) || 1 };
}

// Integer-offset NCC search of template (tw×th) around (cx,cy) ± R.
function search(img, tpl, tw, th, cx, cy, R) {
  let best = { x: cx, y: cy, score: -2 };
  const evalAt = (x, y) => {
    const x0 = Math.round(x - tw / 2);
    const y0 = Math.round(y - th / 2);
    if (x0 < 0 || y0 < 0 || x0 + tw > img.w || y0 + th > img.h) return -2;
    let sum = 0;
    let sum2 = 0;
    let cross = 0;
    for (let j = 0; j < th; j++) {
      const row = (y0 + j) * img.w + x0;
      for (let i = 0; i < tw; i++) {
        const v = img.g[row + i];
        sum += v;
        sum2 += v * v;
        cross += tpl.z[j * tw + i] * v;
      }
    }
    const n = tw * th;
    const varI = sum2 - (sum * sum) / n;
    return varI > 1e-6 ? cross / (tpl.norm * Math.sqrt(varI)) : -2;
  };
  const step = R > 10 ? 2 : 1;
  for (let dy = -R; dy <= R; dy += step) {
    for (let dx = -R; dx <= R; dx += step) {
      const s = evalAt(cx + dx, cy + dy);
      if (s > best.score) best = { x: cx + dx, y: cy + dy, score: s };
    }
  }
  if (step > 1) {
    const c = best;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const s = evalAt(c.x + dx, c.y + dy);
        if (s > best.score) best = { x: c.x + dx, y: c.y + dy, score: s };
      }
    }
  }
  return best;
}

const SCALE_PENALTY = 0.012;

/**
 * frames: source canvases; box: {x, y, w, h} in source px at frame f0.
 * Returns Map(frameIndex → {x, y, scale}) for fFrom..fTo (inclusive).
 */
export async function trackBox(frames, f0, fFrom, fTo, box, { scale = true, onProgress } = {}) {
  const k = Math.min(1, 44 / Math.max(box.w, box.h));
  const tw = Math.max(6, Math.round(box.w * k));
  const th = Math.max(6, Math.round(box.h * k));
  const gray = new Map();
  const getGray = (i) => {
    if (!gray.has(i)) gray.set(i, toGray(frames[i], k));
    return gray.get(i);
  };

  const result = new Map([[f0, { x: box.x, y: box.y, scale: 1 }]]);
  const total = fTo - fFrom;
  let done = 0;

  for (const dir of [1, -1]) {
    const startImg = getGray(f0);
    let cx = box.x * k;
    let cy = box.y * k;
    let sc = 1;
    let vx = 0;
    let vy = 0;
    let tplRaw = samplePatch(startImg, cx, cy, tw, th, tw, th);
    const origTpl = tplRaw;

    for (let f = f0 + dir; f >= fFrom && f <= fTo; f += dir) {
      const img = getGray(f);
      // Joint search over position and a few scale steps (handles zooms).
      let best = null;
      for (const m of scale ? [1, 0.95, 1.05] : [1]) {
        const s = sc * m;
        const sw = Math.max(4, Math.round(tw * s));
        const sh = Math.max(4, Math.round(th * s));
        const tpl = zeroMean(resample(tplRaw, tw, th, sw, sh));
        const R = Math.max(6, Math.round(Math.max(sw, sh) * 0.35));
        const r = search(img, tpl, sw, sh, cx + vx, cy + vy, R);
        // Slight bias towards "no change" so noise doesn't random-walk the scale.
        const score = r.score - (m === 1 ? 0 : SCALE_PENALTY);
        if (!best || score > best.score) best = { ...r, score, s };
      }
      if (best.score < -1) best = { x: cx, y: cy, score: 0, s: sc };
      sc = best.s;

      vx = (best.x - cx) * 0.5;
      vy = (best.y - cy) * 0.5;
      cx = best.x;
      cy = best.y;
      // Refresh the template slowly, anchored to the original to limit drift.
      const cur = samplePatch(img, cx, cy, tw * sc, th * sc, tw, th);
      const next = new Float32Array(cur.length);
      for (let i = 0; i < cur.length; i++) next[i] = cur[i] * 0.35 + tplRaw[i] * 0.45 + origTpl[i] * 0.2;
      tplRaw = next;

      result.set(f, { x: cx / k, y: cy / k, scale: sc });
      if (++done % 4 === 0) {
        onProgress?.(done / Math.max(1, total));
        await new Promise((r) => setTimeout(r));
      }
    }
  }
  return smooth(result);
}

function resample(src, w, h, ow, oh) {
  return samplePatch({ w, h, g: src }, w / 2, h / 2, w, h, ow, oh);
}

function smooth(map) {
  const keys = [...map.keys()].sort((a, b) => a - b);
  const out = new Map();
  keys.forEach((f, i) => {
    let x = 0, y = 0, s = 0, n = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(keys.length - 1, i + 1); j++) {
      const v = map.get(keys[j]);
      x += v.x; y += v.y; s += v.scale; n++;
    }
    out.set(f, { x: x / n, y: y / n, scale: s / n });
  });
  return out;
}
