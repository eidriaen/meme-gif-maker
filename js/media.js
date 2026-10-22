// Turns files / URLs into a "clip": { width, height, frames: [canvas], delays: [ms] }.
import { decodeGif } from './gif-decode.js';

export const MAX_SIDE = 720;

export async function clipFromFile(file, maxSide = MAX_SIDE) {
  const type = file.type || '';
  if (type === 'image/gif' || /\.gif$/i.test(file.name)) {
    return clipFromGifBuffer(await file.arrayBuffer(), maxSide);
  }
  if (type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
    return clipFromVideo(file, maxSide);
  }
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|avif|bmp)$/i.test(file.name)) {
    return clipFromImage(file, maxSide);
  }
  throw new Error(`Unsupported file type: ${type || file.name}`);
}

export async function clipFromUrl(url, maxSide = MAX_SIDE) {
  const res = await fetch(normalizeUrl(url), { mode: 'cors' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const name = url.split('?')[0].split('/').pop() || 'download';
  return clipFromFile(new File([blob], name, { type: blob.type }), maxSide);
}

// GIPHY page links → direct GIF. Everything else is fetched as-is.
export function normalizeUrl(url) {
  url = url.trim();
  const m =
    url.match(/giphy\.com\/(?:gifs|stickers|clips)\/(?:[\w-]*-)?([A-Za-z0-9]{8,})(?:[/?#]|$)/) ||
    url.match(/giphy\.com\/media\/(?:v1\.[^/]+\/)?([A-Za-z0-9]{8,})\//) ||
    url.match(/i\.giphy\.com\/([A-Za-z0-9]{8,})\.(?:gif|webp)/);
  if (m) return `https://i.giphy.com/${m[1]}.gif`;
  return url;
}

export function clipFromGifBuffer(buffer, maxSide = MAX_SIDE) {
  const gif = decodeGif(buffer);
  const k = Math.min(1, maxSide / Math.max(gif.width, gif.height));
  const w = Math.max(1, Math.round(gif.width * k));
  const h = Math.max(1, Math.round(gif.height * k));
  const full = makeCanvas(gif.width, gif.height);
  const fctx = full.getContext('2d');
  const frames = gif.frames.map((fr) => {
    fctx.putImageData(new ImageData(fr.data, gif.width, gif.height), 0, 0);
    if (k === 1) {
      const c = makeCanvas(w, h);
      c.getContext('2d').drawImage(full, 0, 0);
      return c;
    }
    return scaled(full, w, h);
  });
  return { width: w, height: h, frames, delays: gif.frames.map((f) => f.delay) };
}

async function clipFromImage(file, maxSide) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k);
  const h = Math.round(bmp.height * k);
  const c = scaled(bmp, w, h);
  return { width: w, height: h, frames: [c], delays: [100] };
}

async function clipFromVideo(file, maxSide, fps = 15, maxSeconds = 12) {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise((ok, fail) => {
      v.onloadeddata = ok;
      v.onerror = () => fail(new Error('Could not read this video'));
    });
    const dur = Math.min(v.duration || 0, maxSeconds);
    const k = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * k);
    const h = Math.round(v.videoHeight * k);
    const frames = [];
    const n = Math.max(1, Math.floor(dur * fps));
    for (let i = 0; i < n; i++) {
      v.currentTime = i / fps;
      await new Promise((ok) => (v.onseeked = ok));
      frames.push(scaled(v, w, h));
    }
    return { width: w, height: h, frames, delays: frames.map(() => Math.round(1000 / fps)) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function scaled(src, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

export function readClipboardFiles(e) {
  return [...(e.clipboardData?.files || [])];
}
