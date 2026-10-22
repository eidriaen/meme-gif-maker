// Renders the project frame-by-frame and encodes a GIF with gifenc.
import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc.esm.js';
import { makeCanvas } from './media.js';

/**
 * order: list of source frame indices to emit (handles trim/reverse/boomerang)
 * render(ctx, frameIndex, k): draws one frame at scale k
 */
export async function encodeGif({ width, height, order, delays, render, colors = 256, onProgress }) {
  const c = makeCanvas(width, height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const enc = GIFEncoder();
  for (let i = 0; i < order.length; i++) {
    const f = order[i];
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    render(ctx, f);
    const { data } = ctx.getImageData(0, 0, width, height);
    const palette = quantize(data, colors);
    const index = applyPalette(data, palette);
    enc.writeFrame(index, width, height, { palette, delay: delays[i], repeat: 0 });
    onProgress?.((i + 1) / order.length);
    await new Promise((r) => setTimeout(r));
  }
  enc.finish();
  return new Blob([enc.bytes()], { type: 'image/gif' });
}
