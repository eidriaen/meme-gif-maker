// Layer model, keyframe interpolation, animation presets and drawing.

export const FONTS = {
  impact: { label: 'Impact', css: "Impact, Anton, 'Arial Narrow', sans-serif", weight: '400' },
  anton: { label: 'Anton', css: "Anton, Impact, sans-serif", weight: '400' },
  archivo: { label: 'Arial Black', css: "'Arial Black', 'Archivo Black', sans-serif", weight: '900' },
  bangers: { label: 'Bangers', css: "Bangers, Impact, cursive", weight: '400' },
  comic: { label: 'Comic', css: "'Comic Sans MS', 'Comic Neue', cursive", weight: '700' },
  sans: { label: 'Helvetica', css: "'Helvetica Neue', Arial, sans-serif", weight: '700' },
  serif: { label: 'Serif', css: "Georgia, 'Times New Roman', serif", weight: '700' },
  mono: { label: 'Mono', css: "'Courier New', monospace", weight: '700' },
};

export const ANIM_IN = {
  none: 'None', fade: 'Fade', pop: 'Pop', zoom: 'Zoom', drop: 'Drop + bounce', spin: 'Spin in',
  slideL: 'Slide from left', slideR: 'Slide from right', slideT: 'Slide from top', slideB: 'Slide from bottom',
  type: 'Typewriter (text)',
};
export const ANIM_OUT = {
  none: 'None', fade: 'Fade', pop: 'Shrink', zoom: 'Zoom out', spin: 'Spin out',
  slideL: 'Slide to left', slideR: 'Slide to right', slideT: 'Slide to top', slideB: 'Slide to bottom',
};
export const ANIM_LOOP = {
  none: 'None', shake: 'Shake', pulse: 'Pulse', wiggle: 'Wiggle', bounce: 'Bounce', float: 'Float',
  spin: 'Spin', flash: 'Flash', rainbow: 'Rainbow (text)', grow: 'Slow grow',
};

let nextId = 1;
export const bumpId = (id) => (nextId = Math.max(nextId, id + 1));

function base(clip, extra) {
  return {
    id: nextId++,
    visible: true,
    start: 0,
    end: clip.frames.length - 1,
    ease: 'smooth',
    animIn: 'none', inDur: 0.4,
    animOut: 'none', outDur: 0.4,
    animLoop: 'none', loopAmt: 1,
    ...extra,
  };
}

export function newTextLayer(clip, text = 'TOP TEXT', where = 'top') {
  const { width: W, height: H } = clip;
  const size = Math.max(16, Math.round(Math.min(H * 0.13, W * 0.11)));
  const y = where === 'top' ? size * 0.9 : where === 'bottom' ? H - size * 0.9 : H / 2;
  return base(clip, {
    type: 'text',
    text,
    font: 'impact',
    size,
    fill: '#ffffff',
    stroke: '#000000',
    strokeW: 0.08,
    upper: true,
    align: 'center',
    wrap: 0.94,
    shadow: false,
    keys: [{ f: 0, x: W / 2, y, s: 1, r: 0, o: 1 }],
  });
}

export function newImageLayer(clip, asset) {
  const { width: W, height: H } = clip;
  const w = Math.round(Math.min(asset.width, W * 0.4, (H * 0.5 * asset.width) / asset.height));
  return base(clip, {
    type: 'image',
    asset: asset.id,
    w: Math.max(8, w),
    flip: false,
    keys: [{ f: 0, x: W / 2, y: H / 2, s: 1, r: 0, o: 1 }],
  });
}

export function layerLabel(L) {
  if (L.type === 'text') return (L.text || '(empty text)').split('\n')[0].slice(0, 28);
  return L.name || 'Image';
}

// ---------- keyframes ----------

const EASE = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  hold: () => 0,
};

export function evalBase(L, f) {
  const ks = L.keys;
  if (ks.length === 1 || f <= ks[0].f) return { ...ks[0] };
  const last = ks[ks.length - 1];
  if (f >= last.f) return { ...last };
  let i = 0;
  while (ks[i + 1].f <= f) i++;
  const a = ks[i];
  const b = ks[i + 1];
  const t = (EASE[L.ease] || EASE.smooth)((f - a.f) / (b.f - a.f));
  return {
    f,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    s: a.s + (b.s - a.s) * t,
    r: a.r + (b.r - a.r) * t,
    o: a.o + (b.o - a.o) * t,
  };
}

export const isAnimated = (L) => !!L.keyed || L.keys.length > 1;
export const keyIndexAt = (L, f) => (isAnimated(L) ? L.keys.findIndex((k) => k.f === f) : -1);

// Apply an edit made "at frame f": static layers change their one key,
// animated layers get a keyframe at f (created from the interpolated pose).
export function editAt(L, f, vals) {
  let k;
  if (!isAnimated(L)) {
    k = L.keys[0];
  } else {
    k = L.keys.find((q) => q.f === f);
    if (!k) k = insertKey(L, f);
  }
  Object.assign(k, vals);
}

export function insertKey(L, f) {
  const k = { ...evalBase(L, f), f };
  const i = L.keys.findIndex((q) => q.f > f);
  if (i < 0) L.keys.push(k);
  else L.keys.splice(i, 0, k);
  return k;
}

export function addKeyframe(L, f) {
  if (!isAnimated(L)) {
    // First keyframe pins the current pose at f; edits on other frames then add keys.
    L.keys[0].f = f;
    L.keyed = true;
    return;
  }
  if (!L.keys.some((k) => k.f === f)) insertKey(L, f);
}

export function removeKeyframe(L, f) {
  const i = L.keys.findIndex((k) => k.f === f);
  if (i < 0) return;
  if (L.keys.length > 1) L.keys.splice(i, 1);
  else L.keyed = false;
}

export function clearAnimation(L, f) {
  L.keys = [{ ...evalBase(L, f), f: 0 }];
  L.keyed = false;
}

// ---------- presets ----------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const backOut = (t) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
const bounceOut = (t) => {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
const noise = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function applyEntry(kind, p, st, W, H) {
  const e = easeOut(p);
  switch (kind) {
    case 'fade': st.o *= p; break;
    case 'pop': st.s *= Math.max(0, backOut(p)); break;
    case 'zoom': st.s *= e; break;
    case 'drop': st.y -= (1 - bounceOut(p)) * H; break;
    case 'spin': st.r -= (1 - e) * 360; st.s *= e; break;
    case 'slideL': st.x -= (1 - e) * W; break;
    case 'slideR': st.x += (1 - e) * W; break;
    case 'slideT': st.y -= (1 - e) * H; break;
    case 'slideB': st.y += (1 - e) * H; break;
    case 'type': st.reveal = p; break;
  }
}

// Full evaluated pose for drawing at frame f, or null when hidden.
// tl = { cum: ms at each frame start (length N+1) }
export function evalLayer(L, f, tl, W, H) {
  if (!L.visible || f < L.start || f > L.end) return null;
  const st = evalBase(L, f);
  st.reveal = 1;
  st.hue = null;
  const t = (tl.cum[f] - tl.cum[L.start]) / 1000;
  const remaining = (tl.cum[L.end] - tl.cum[f]) / 1000;

  if (L.animIn !== 'none') applyEntry(L.animIn, L.inDur > 0 ? clamp01(t / L.inDur) : 1, st, W, H);
  if (L.animOut !== 'none') applyEntry(L.animOut, L.outDur > 0 ? clamp01(remaining / L.outDur) : 1, st, W, H);

  const a = L.loopAmt;
  switch (L.animLoop) {
    case 'shake':
      st.x += (noise(f * 2) - 0.5) * 0.05 * W * a;
      st.y += (noise(f * 2 + 1) - 0.5) * 0.05 * W * a;
      st.r += (noise(f * 3 + 7) - 0.5) * 6 * a;
      break;
    case 'pulse': st.s *= 1 + 0.1 * a * Math.sin(2 * Math.PI * t * 2); break;
    case 'wiggle': st.r += 10 * a * Math.sin(2 * Math.PI * t * 2.5); break;
    case 'bounce': st.y -= Math.abs(Math.sin(Math.PI * t * 2.5)) * 0.06 * H * a; break;
    case 'float': st.y += Math.sin(2 * Math.PI * t * 0.8) * 0.03 * H * a; break;
    case 'spin': st.r += 270 * t * a; break;
    case 'flash': st.o *= Math.floor(t * 8 / Math.max(0.2, a)) % 2 ? 0 : 1; break;
    case 'rainbow': st.hue = (t * 360 * a) % 360; break;
    case 'grow': st.s *= 1 + 0.25 * a * t; break;
  }
  return st;
}

// ---------- measuring & drawing ----------

const measureCtx = document.createElement('canvas').getContext('2d');

export function fontString(L) {
  const f = FONTS[L.font] || FONTS.impact;
  return `${f.weight} ${L.size}px ${f.css}`;
}

export function layoutText(L, W) {
  const raw = L.upper ? L.text.toUpperCase() : L.text;
  measureCtx.font = fontString(L);
  const maxW = Math.max(L.size, L.wrap * W);
  const lines = [];
  for (const para of raw.split('\n')) {
    const words = para.split(/ +/);
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (line && measureCtx.measureText(test).width > maxW) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  const widths = lines.map((l) => measureCtx.measureText(l).width);
  const lineH = L.size * 1.08;
  const pad = L.size * L.strokeW;
  return {
    lines,
    widths,
    lineH,
    w: Math.max(L.size * 0.5, ...widths) + pad * 2,
    h: lines.length * lineH + pad * 2,
  };
}

export function layerSize(L, W, assets) {
  if (L.type === 'text') {
    const t = layoutText(L, W);
    return { w: t.w, h: t.h };
  }
  const a = assets.get(L.asset);
  return { w: L.w, h: a ? (L.w * a.height) / a.width : L.w };
}

export function assetFrameAt(asset, tSec) {
  if (asset.frames.length === 1) return asset.frames[0];
  let ms = (tSec * 1000) % asset.total;
  for (let i = 0; i < asset.frames.length; i++) {
    ms -= asset.delays[i];
    if (ms < 0) return asset.frames[i];
  }
  return asset.frames[asset.frames.length - 1];
}

export function drawLayer(ctx, L, st, k, W, assets, tSec) {
  if (st.o <= 0.001 || st.s <= 0.001) return;
  ctx.save();
  ctx.translate(st.x * k, st.y * k);
  ctx.rotate((st.r * Math.PI) / 180);
  ctx.scale(st.s * k, st.s * k);
  ctx.globalAlpha = Math.min(1, st.o);

  if (L.type === 'text') {
    const t = layoutText(L, W);
    ctx.font = fontString(L);
    ctx.textBaseline = 'middle';
    ctx.textAlign = L.align;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    const inner = t.w - L.size * L.strokeW * 2;
    const x = L.align === 'left' ? -inner / 2 : L.align === 'right' ? inner / 2 : 0;
    let budget = st.reveal < 1 ? Math.floor(st.reveal * t.lines.join('').length) : Infinity;
    const fill = st.hue == null ? L.fill : `hsl(${st.hue}, 100%, 60%)`;
    t.lines.forEach((line, i) => {
      if (budget <= 0) return;
      const shown = line.slice(0, budget);
      budget -= line.length;
      const y = -((t.lines.length - 1) * t.lineH) / 2 + i * t.lineH;
      if (L.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.65)';
        ctx.shadowBlur = L.size * 0.12;
        ctx.shadowOffsetY = L.size * 0.05;
      }
      if (L.strokeW > 0) {
        ctx.strokeStyle = L.stroke;
        ctx.lineWidth = L.size * L.strokeW * 2;
        ctx.strokeText(shown, x, y);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = fill;
      ctx.fillText(shown, x, y);
      ctx.shadowColor = 'transparent';
    });
  } else {
    const a = assets.get(L.asset);
    if (a) {
      const h = (L.w * a.height) / a.width;
      if (L.flip) ctx.scale(-1, 1);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(assetFrameAt(a, tSec), -L.w / 2, -h / 2, L.w, h);
    }
  }
  ctx.restore();
}

// Point (source coords) inside the layer's rotated box?
export function hitTest(L, st, W, assets, px, py, pad = 0) {
  const { w, h } = layerSize(L, W, assets);
  const dx = px - st.x;
  const dy = py - st.y;
  const a = (-st.r * Math.PI) / 180;
  const lx = (dx * Math.cos(a) - dy * Math.sin(a)) / st.s;
  const ly = (dx * Math.sin(a) + dy * Math.cos(a)) / st.s;
  return Math.abs(lx) <= w / 2 + pad / st.s && Math.abs(ly) <= h / 2 + pad / st.s;
}

export function boxCorners(L, st, W, assets) {
  const { w, h } = layerSize(L, W, assets);
  const a = (st.r * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pt = (lx, ly) => ({
    x: st.x + (lx * c - ly * s) * st.s,
    y: st.y + (lx * s + ly * c) * st.s,
  });
  return {
    tl: pt(-w / 2, -h / 2), tr: pt(w / 2, -h / 2), br: pt(w / 2, h / 2), bl: pt(-w / 2, h / 2),
    top: pt(0, -h / 2), w, h,
  };
}
