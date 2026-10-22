import { clipFromFile, clipFromUrl, makeCanvas } from './media.js';
import {
  FONTS, ANIM_IN, ANIM_OUT, ANIM_LOOP, bumpId,
  newTextLayer, newImageLayer, layerLabel,
  evalBase, evalLayer, editAt, addKeyframe, removeKeyframe, clearAnimation, keyIndexAt, isAnimated,
  drawLayer, hitTest, boxCorners, layerSize,
} from './layers.js';
import { trackBox } from './track.js';
import { removeBackground } from './bgremove.js';
import { giphySearch } from './giphy.js';
import { encodeGif } from './export.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dpr = () => window.devicePixelRatio || 1;

// ---------- state ----------

const S = {
  clip: null,
  cum: [0],
  frame: 0,
  playing: false,
  layers: [],
  sel: null,
  out: { start: 0, end: 0, speed: 1, width: 0, colors: 256, reverse: false, boomerang: false },
};
const assets = new Map();
let assetSeq = 1;
const sel = () => S.layers.find((l) => l.id === S.sel) || null;

const settings = loadSettings();

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('mgm.settings') || '{}');
  } catch {}
  const s = { giphyKey: window.APP_CONFIG?.giphyKey || '', rating: 'r', maxSide: 720, ...saved };
  const fromUrl = new URLSearchParams(location.search).get('giphy');
  if (fromUrl) {
    s.giphyKey = fromUrl;
    history.replaceState(null, '', location.pathname);
    saveSettings(s);
  }
  return s;
}
function saveSettings(s = settings) {
  try {
    localStorage.setItem('mgm.settings', JSON.stringify(s));
  } catch {}
}

function addAsset(clip, name) {
  const id = assetSeq++;
  const a = { id, name, width: clip.width, height: clip.height, frames: clip.frames, delays: clip.delays,
    total: clip.delays.reduce((x, y) => x + y, 0) || 100 };
  assets.set(id, a);
  return a;
}

// ---------- history ----------

const hist = { stack: [], i: -1 };
const snapshot = () => JSON.stringify({ layers: S.layers, sel: S.sel, out: S.out });
function commit() {
  const s = snapshot();
  if (hist.stack[hist.i] === s) return;
  hist.stack.length = hist.i + 1;
  hist.stack.push(s);
  if (hist.stack.length > 150) hist.stack.shift();
  hist.i = hist.stack.length - 1;
  updateUndo();
}
function undo(step) {
  const j = hist.i + step;
  if (j < 0 || j >= hist.stack.length) return;
  hist.i = j;
  const o = JSON.parse(hist.stack[j]);
  S.layers = o.layers;
  S.sel = o.sel;
  S.out = o.out;
  refreshAll();
  updateUndo();
}
function updateUndo() {
  $('#btnUndo').disabled = hist.i <= 0;
  $('#btnRedo').disabled = hist.i >= hist.stack.length - 1;
}

// ---------- loading ----------

async function busy(text, fn) {
  $('#busyText').textContent = text;
  $('#busy').hidden = false;
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), true);
  } finally {
    $('#busy').hidden = true;
  }
}

function setClip(clip) {
  pause();
  const N = clip.frames.length;
  const prevN = S.clip?.frames.length;
  S.clip = clip;
  S.cum = [0];
  clip.delays.forEach((d, i) => S.cum.push(S.cum[i] + d));
  S.frame = 0;
  S.out.start = 0;
  S.out.end = N - 1;
  // Keep existing layers so a caption can be tried on different GIFs.
  for (const L of S.layers) {
    if (L.end >= prevN - 1 || L.end > N - 1) L.end = N - 1;
    L.start = Math.min(L.start, L.end);
    L.keys.forEach((k) => (k.f = Math.min(k.f, N - 1)));
    L.keys = L.keys.filter((k, i, a) => i === 0 || k.f !== a[i - 1].f);
  }
  $('#empty').hidden = true;
  $('#view').hidden = false;
  $('#transport').hidden = false;
  $('#panel').hidden = false;
  $('#hint').hidden = false;
  $('#btnExport').disabled = false;
  hist.stack = [];
  hist.i = -1;
  commit();
  fitStage();
  refreshAll();
  if (N > 1) play();
}

async function loadSource(getClip) {
  const clip = await busy('Loading GIF…', getClip);
  if (clip) setClip(clip);
}

async function addOverlay(getClip, name) {
  if (!S.clip) return loadSource(getClip);
  const clip = await busy('Loading image…', getClip);
  if (!clip) return;
  const a = addAsset(clip, name);
  const L = newImageLayer(S.clip, a);
  L.name = name;
  L.keys[0].f = S.frame;
  S.layers.push(L);
  select(L.id);
  commit();
}

function addText() {
  if (!S.clip) return;
  const hasTop = S.layers.some((l) => l.type === 'text' && l.keys[0].y < S.clip.height / 3);
  const L = hasTop ? newTextLayer(S.clip, 'BOTTOM TEXT', 'bottom') : newTextLayer(S.clip, 'TOP TEXT', 'top');
  S.layers.push(L);
  select(L.id);
  commit();
  const ta = $('#pText');
  ta.focus();
  ta.select();
}

// ---------- rendering ----------

const view = $('#view');
const vctx = view.getContext('2d');
let dispK = 1;
let checker = null;

function fitStage() {
  if (!S.clip) return;
  const stage = $('#stage');
  const availW = stage.clientWidth - 2;
  const mobile = window.innerWidth <= 900;
  const availH = Math.max(200, window.innerHeight * (mobile ? 0.48 : 0.72));
  const { width: W, height: H } = S.clip;
  const k = Math.min(availW / W, availH / H, mobile ? 99 : 3);
  const cssW = Math.round(W * k);
  const cssH = Math.round(H * k);
  view.style.width = `${cssW}px`;
  view.style.height = `${cssH}px`;
  view.width = Math.round(cssW * dpr());
  view.height = Math.round(cssH * dpr());
  dispK = view.width / W;
  render();
}

function renderFrame(ctx, f, k) {
  const { width: W, height: H } = S.clip;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(S.clip.frames[f], 0, 0, W * k, H * k);
  for (const L of S.layers) {
    const st = evalLayer(L, f, S, W, H);
    if (st) drawLayer(ctx, L, st, k, W, assets, (S.cum[f] - S.cum[L.start]) / 1000);
  }
}

function render() {
  if (!S.clip) return;
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!checker) {
    const c = makeCanvas(16, 16);
    const x = c.getContext('2d');
    x.fillStyle = '#2a2a36';
    x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#353544';
    x.fillRect(0, 0, 8, 8);
    x.fillRect(8, 8, 8, 8);
    checker = vctx.createPattern(c, 'repeat');
  }
  vctx.fillStyle = checker;
  vctx.fillRect(0, 0, view.width, view.height);
  renderFrame(vctx, S.frame, dispK);
  drawSelection();
  drawTimeline();
  $('#frameLabel').textContent = `${S.frame + 1}/${S.clip.frames.length}`;
}

function handlesFor(L) {
  const { width: W, height: H } = S.clip;
  const st = evalLayer(L, S.frame, S, W, H);
  if (!st) return null;
  const c = boxCorners(L, st, W, assets);
  const P = (p) => ({ x: p.x * dispK, y: p.y * dispK });
  const center = P(st);
  const top = P(c.top);
  let dx = top.x - center.x;
  let dy = top.y - center.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  if (len < 2) { dx = 0; dy = -1; }
  const off = 26 * dpr();
  let anchor = top;
  let rot = { x: top.x + dx * off, y: top.y + dy * off };
  if (rot.y < 10 * dpr() || rot.x < 0 || rot.x > view.width) {
    // No room above (e.g. top text): put the rotate handle below the box instead.
    anchor = { x: 2 * center.x - top.x, y: 2 * center.y - top.y };
    rot = { x: anchor.x - dx * off, y: anchor.y - dy * off };
  }
  return {
    st, center, top: anchor,
    corners: [c.tl, c.tr, c.br, c.bl].map(P),
    scale: P(c.br),
    rot,
  };
}

function drawSelection() {
  const L = sel();
  if (!L || S.playing) return;
  const h = handlesFor(L);
  if (!h) return;
  const r = dpr();
  vctx.save();
  vctx.lineWidth = 1.5 * r;
  vctx.strokeStyle = '#ffcc33';
  vctx.setLineDash([6 * r, 4 * r]);
  vctx.beginPath();
  h.corners.forEach((p, i) => (i ? vctx.lineTo(p.x, p.y) : vctx.moveTo(p.x, p.y)));
  vctx.closePath();
  vctx.stroke();
  vctx.setLineDash([]);
  vctx.beginPath();
  vctx.moveTo(h.top.x, h.top.y);
  vctx.lineTo(h.rot.x, h.rot.y);
  vctx.stroke();
  for (const [p, shape] of [[h.scale, 'sq'], [h.rot, 'ci']]) {
    vctx.fillStyle = '#ffcc33';
    vctx.strokeStyle = '#1b1600';
    vctx.lineWidth = 1.5 * r;
    vctx.beginPath();
    if (shape === 'sq') vctx.rect(p.x - 7 * r, p.y - 7 * r, 14 * r, 14 * r);
    else vctx.arc(p.x, p.y, 7.5 * r, 0, Math.PI * 2);
    vctx.fill();
    vctx.stroke();
  }
  vctx.restore();
}

// ---------- timeline ----------

const tl = $('#timeline');
const tctx = tl.getContext('2d');
const TL_PAD = 10;

function tlX(f, w) {
  const N = S.clip.frames.length;
  return TL_PAD + ((f + 0.5) / N) * (w - TL_PAD * 2);
}

function drawTimeline() {
  const r = dpr();
  const cw = tl.clientWidth;
  const ch = tl.clientHeight;
  if (tl.width !== Math.round(cw * r)) tl.width = Math.round(cw * r);
  if (tl.height !== Math.round(ch * r)) tl.height = Math.round(ch * r);
  tctx.setTransform(r, 0, 0, r, 0, 0);
  tctx.clearRect(0, 0, cw, ch);
  const N = S.clip.frames.length;
  const fw = (cw - TL_PAD * 2) / N;

  tctx.fillStyle = '#20202b';
  roundRect(tctx, 0, 6, cw, ch - 12, 8);
  tctx.fill();
  // ticks
  tctx.fillStyle = '#3a3a4a';
  const every = Math.max(1, Math.ceil(N / (cw / 6)));
  for (let f = 0; f < N; f += every) tctx.fillRect(tlX(f, cw) - 0.5, ch - 12, 1, 4);
  // trimmed-away regions
  tctx.fillStyle = 'rgba(0,0,0,.45)';
  tctx.fillRect(TL_PAD, 6, tlX(S.out.start, cw) - fw / 2 - TL_PAD, ch - 12);
  const endX = tlX(S.out.end, cw) + fw / 2;
  tctx.fillRect(endX, 6, cw - TL_PAD - endX, ch - 12);

  const L = sel();
  if (L) {
    tctx.fillStyle = 'rgba(255,204,51,.22)';
    const x0 = tlX(L.start, cw) - fw / 2;
    const x1 = tlX(L.end, cw) + fw / 2;
    roundRect(tctx, x0, 14, x1 - x0, 8, 3);
    tctx.fill();
    if (isAnimated(L)) {
      tctx.fillStyle = '#ffcc33';
      tctx.strokeStyle = '#1b1600';
      tctx.lineWidth = 1;
      const many = L.keys.length > N * 0.6;
      for (const k of L.keys) {
        const x = tlX(k.f, cw);
        const s = many ? 3 : 5;
        tctx.beginPath();
        tctx.moveTo(x, 18 - s);
        tctx.lineTo(x + s, 18);
        tctx.lineTo(x, 18 + s);
        tctx.lineTo(x - s, 18);
        tctx.closePath();
        tctx.fill();
        if (!many) tctx.stroke();
      }
    }
  }
  const px = tlX(S.frame, cw);
  tctx.fillStyle = '#fff';
  tctx.fillRect(px - 1, 4, 2, ch - 8);
  tctx.beginPath();
  tctx.arc(px, ch - 9, 4, 0, Math.PI * 2);
  tctx.fill();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h);
}

function frameFromTimeline(e) {
  const rect = tl.getBoundingClientRect();
  const N = S.clip.frames.length;
  const t = (e.clientX - rect.left - TL_PAD) / (rect.width - TL_PAD * 2);
  return clamp(Math.floor(t * N), 0, N - 1);
}
tl.addEventListener('pointerdown', (e) => {
  if (!S.clip) return;
  tl.setPointerCapture(e.pointerId);
  pause();
  setFrame(frameFromTimeline(e));
  const move = (ev) => setFrame(frameFromTimeline(ev));
  const up = () => {
    tl.removeEventListener('pointermove', move);
    tl.removeEventListener('pointerup', up);
    tl.removeEventListener('pointercancel', up);
  };
  tl.addEventListener('pointermove', move);
  tl.addEventListener('pointerup', up);
  tl.addEventListener('pointercancel', up);
});

function setFrame(f) {
  S.frame = clamp(f, 0, S.clip.frames.length - 1);
  render();
  syncInspector();
}

// ---------- playback ----------

function playOrder() {
  const o = S.out;
  let seq = [];
  for (let f = o.start; f <= o.end; f++) seq.push(f);
  if (o.reverse) seq.reverse();
  if (o.boomerang && seq.length > 2) seq = seq.concat(seq.slice(1, -1).reverse());
  return seq;
}
const frameDelay = (f) => Math.max(20, Math.round(S.clip.delays[f] / S.out.speed / 10) * 10);

let playIdx = 0;
let lastT = 0;
let acc = 0;
function play() {
  if (!S.clip || S.clip.frames.length < 2) return;
  S.playing = true;
  const order = playOrder();
  playIdx = Math.max(0, order.indexOf(S.frame));
  S.frame = order[playIdx];
  lastT = performance.now();
  acc = 0;
  $('#btnPlay').textContent = '❚❚';
  requestAnimationFrame(tick);
}
function pause() {
  if (!S.playing) return;
  S.playing = false;
  $('#btnPlay').textContent = '▶';
  render();
  syncInspector();
}
function tick(now) {
  if (!S.playing) return;
  acc += now - lastT;
  lastT = now;
  const order = playOrder();
  let changed = false;
  let guard = 0;
  while (acc >= frameDelay(order[playIdx % order.length]) && guard++ < 50) {
    acc -= frameDelay(order[playIdx % order.length]);
    playIdx = (playIdx + 1) % order.length;
    changed = true;
  }
  if (changed) {
    S.frame = order[playIdx % order.length];
    render();
  }
  requestAnimationFrame(tick);
}

// ---------- canvas interaction ----------

const pointers = new Map();
let drag = null;

function toSource(e) {
  const r = view.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * S.clip.width,
    y: ((e.clientY - r.top) / r.height) * S.clip.height,
    cx: (e.clientX - r.left) * (view.width / r.width),
    cy: (e.clientY - r.top) * (view.height / r.height),
  };
}

function layerAt(p) {
  const { width: W, height: H } = S.clip;
  for (let i = S.layers.length - 1; i >= 0; i--) {
    const L = S.layers[i];
    const st = evalLayer(L, S.frame, S, W, H);
    if (st && hitTest(L, st, W, assets, p.x, p.y, 6 / (dispK / dpr()))) return L;
  }
  return null;
}

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return {
    d: Math.hypot(b.x - a.x, b.y - a.y),
    a: Math.atan2(b.y - a.y, b.x - a.x),
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
  };
}

view.addEventListener('pointerdown', (e) => {
  if (!S.clip) return;
  view.setPointerCapture(e.pointerId);
  const p = toSource(e);
  pointers.set(e.pointerId, p);
  pause();

  const cur = sel();
  if (pointers.size === 2 && cur) {
    drag = { mode: 'pinch', L: cur, base: evalBase(cur, S.frame), start: pinchInfo() };
    return;
  }
  if (pointers.size > 1) return;

  const h = cur && handlesFor(cur);
  const near = (q) => Math.hypot(p.cx - q.x, p.cy - q.y) < 20 * dpr();
  let mode = null;
  let L = cur;
  if (h && near(h.rot)) mode = 'rotate';
  else if (h && near(h.scale)) mode = 'scale';
  else {
    L = layerAt(p);
    if (L) mode = 'move';
    select(L ? L.id : null);
  }
  if (!mode) return;
  const st = evalLayer(L, S.frame, S, S.clip.width, S.clip.height);
  drag = { mode, L, start: p, base: evalBase(L, S.frame), center: { x: st.x, y: st.y } };
});

view.addEventListener('pointermove', (e) => {
  if (!S.clip) return;
  const p = toSource(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  if (!drag) {
    if (e.pointerType === 'mouse') {
      const cur = sel();
      const h = cur && handlesFor(cur);
      const near = (q) => h && Math.hypot(p.cx - q.x, p.cy - q.y) < 20 * dpr();
      view.style.cursor = h && near(h.rot) ? 'grab' : h && near(h.scale) ? 'nwse-resize' : layerAt(p) ? 'move' : 'default';
    }
    return;
  }
  const { L, base } = drag;
  if (drag.mode === 'pinch') {
    if (pointers.size < 2) return;
    const now = pinchInfo();
    const s0 = drag.start;
    editAt(L, S.frame, {
      s: clamp(base.s * (now.d / s0.d), 0.03, 20),
      r: base.r + ((now.a - s0.a) * 180) / Math.PI,
      x: base.x + (now.mx - s0.mx),
      y: base.y + (now.my - s0.my),
    });
  } else if (drag.mode === 'move') {
    editAt(L, S.frame, { x: base.x + (p.x - drag.start.x), y: base.y + (p.y - drag.start.y) });
  } else if (drag.mode === 'scale') {
    const c = drag.center;
    const d0 = Math.hypot(drag.start.x - c.x, drag.start.y - c.y) || 1;
    const d1 = Math.hypot(p.x - c.x, p.y - c.y);
    editAt(L, S.frame, { s: clamp(base.s * (d1 / d0), 0.03, 20) });
  } else if (drag.mode === 'rotate') {
    const c = drag.center;
    const a0 = Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
    const a1 = Math.atan2(p.y - c.y, p.x - c.x);
    let r = base.r + ((a1 - a0) * 180) / Math.PI;
    if (e.shiftKey) r = Math.round(r / 15) * 15;
    else if (Math.abs(r - Math.round(r / 90) * 90) < 3) r = Math.round(r / 90) * 90;
    editAt(L, S.frame, { r });
  }
  render();
  syncInspector();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (drag && (pointers.size === 0 || drag.mode === 'pinch')) {
    drag = null;
    commit();
    render();
  }
}
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);
view.addEventListener('dblclick', () => {
  const L = sel();
  if (L?.type === 'text') {
    $('#pText').focus();
    $('#pText').select();
  }
});

// ---------- layers panel ----------

function select(id) {
  S.sel = id;
  renderLayerList();
  syncInspector();
  render();
}

function renderLayerList() {
  const ul = $('#layerList');
  ul.innerHTML = '';
  $('#noLayers').hidden = S.layers.length > 0;
  [...S.layers].reverse().forEach((L) => {
    const li = document.createElement('li');
    li.className = (L.id === S.sel ? 'sel ' : '') + (L.visible ? '' : 'off');
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    if (L.type === 'text') {
      thumb.textContent = 'T';
    } else {
      const a = assets.get(L.asset);
      if (a) thumb.style.backgroundImage = `url(${a.frames[0].toDataURL()})`;
    }
    const name = document.createElement('span');
    name.className = 'lname';
    name.textContent = layerLabel(L);
    if (isAnimated(L) || L.animIn !== 'none' || L.animLoop !== 'none' || L.animOut !== 'none') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = ' ● animated';
      name.append(tag);
    }
    li.append(thumb, name);
    const btn = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'lbtn';
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.onclick = (ev) => {
        ev.stopPropagation();
        fn();
        commit();
        refreshAll();
      };
      li.append(b);
    };
    btn(L.visible ? '👁' : '◌', L.visible ? 'Hide' : 'Show', () => (L.visible = !L.visible));
    btn('↑', 'Move up', () => moveLayer(L, 1));
    btn('↓', 'Move down', () => moveLayer(L, -1));
    btn('⧉', 'Duplicate', () => duplicate(L));
    btn('✕', 'Delete', () => deleteLayer(L));
    li.onclick = () => select(L.id);
    ul.append(li);
  });
}

function moveLayer(L, dir) {
  const i = S.layers.indexOf(L);
  const j = i + dir;
  if (j < 0 || j >= S.layers.length) return;
  [S.layers[i], S.layers[j]] = [S.layers[j], S.layers[i]];
}
function duplicate(L) {
  const c = JSON.parse(JSON.stringify(L));
  c.id = Math.max(0, ...S.layers.map((l) => l.id)) + 1;
  bumpId(c.id);
  c.keys.forEach((k) => {
    k.x += 12;
    k.y += 12;
  });
  S.layers.splice(S.layers.indexOf(L) + 1, 0, c);
  S.sel = c.id;
}
function deleteLayer(L) {
  S.layers = S.layers.filter((l) => l !== L);
  if (S.sel === L.id) S.sel = null;
}

// ---------- inspector ----------

function fillSelect(el, entries) {
  el.innerHTML = Object.entries(entries)
    .map(([v, l]) => `<option value="${v}">${typeof l === 'string' ? l : l.label}</option>`)
    .join('');
}
fillSelect($('#pFont'), FONTS);
fillSelect($('#aIn'), ANIM_IN);
fillSelect($('#aOut'), ANIM_OUT);
fillSelect($('#aLoop'), ANIM_LOOP);

function setVal(id, v) {
  const el = $(id);
  if (document.activeElement === el && el.type !== 'range') return;
  if (el.type === 'checkbox') el.checked = !!v;
  else el.value = v;
}

function syncInspector() {
  const L = sel();
  $('#inspector').hidden = !L;
  syncOutput();
  if (!L || !S.clip) return;
  const { width: W, height: H } = S.clip;
  $('#textProps').hidden = L.type !== 'text';
  $('#imageProps').hidden = L.type !== 'image';
  if (L.type === 'text') {
    setVal('#pText', L.text);
    setVal('#pFont', L.font);
    setVal('#pSize', L.size);
    setVal('#pFill', L.fill);
    setVal('#pStroke', L.stroke);
    setVal('#pStrokeW', L.strokeW);
    setVal('#pWrap', L.wrap);
    setVal('#pAlign', L.align);
    setVal('#pUpper', L.upper);
    setVal('#pShadow', L.shadow);
  } else {
    const a = assets.get(L.asset);
    const single = a && a.frames.length === 1;
    $('#btnRemoveBg').disabled = !single;
    $('#btnRemoveBg').title = single ? '' : 'Only for still images';
    $('#btnRestoreImg').hidden = L.origAsset == null;
    setVal('#pFlip', L.flip);
  }
  const b = evalBase(L, S.frame);
  for (const [id, min, max] of [['#tX', -W * 0.5, W * 1.5], ['#tY', -H * 0.5, H * 1.5]]) {
    $(id).min = Math.round(min);
    $(id).max = Math.round(max);
  }
  setVal('#tX', Math.round(b.x));
  setVal('#tY', Math.round(b.y));
  setVal('#tS', Math.round(b.s * 100));
  setVal('#tR', Math.round(b.r));
  setVal('#tO', Math.round(b.o * 100));
  $('#tSv').textContent = `${Math.round(b.s * 100)}%`;
  $('#tRv').textContent = `${Math.round(b.r)}°`;
  $('#tOv').textContent = `${Math.round(b.o * 100)}%`;
  setVal('#kEase', L.ease);

  const onKey = keyIndexAt(L, S.frame) >= 0;
  $('#kToggle').textContent = onKey ? '◇ Remove keyframe' : '◆ Add keyframe';
  $('#kPrev').disabled = !L.keys.some((k) => k.f < S.frame) || !isAnimated(L);
  $('#kNext').disabled = !L.keys.some((k) => k.f > S.frame) || !isAnimated(L);
  $('#kClear').disabled = !isAnimated(L);
  $('#kTrack').disabled = S.clip.frames.length < 2;
  const visible = S.frame >= L.start && S.frame <= L.end;
  $('#keyInfo').textContent = !visible
    ? '· hidden on this frame'
    : isAnimated(L)
      ? `· ${L.keys.length} keyframes${onKey ? ' · on a key' : ' · editing adds a key'}`
      : '· static';

  setVal('#vStart', L.start + 1);
  setVal('#vEnd', L.end + 1);
  $('#vStart').max = $('#vEnd').max = S.clip.frames.length;
  setVal('#aIn', L.animIn);
  setVal('#aOut', L.animOut);
  setVal('#aLoop', L.animLoop);
  setVal('#aInDur', L.inDur);
  setVal('#aOutDur', L.outDur);
  setVal('#aLoopAmt', L.loopAmt);
  $('#aInDurV').textContent = `${L.inDur}s`;
  $('#aOutDurV').textContent = `${L.outDur}s`;
  $('#aLoopAmtV').textContent = `${L.loopAmt}×`;
}

function syncOutput() {
  if (!S.clip) return;
  const o = S.out;
  const N = S.clip.frames.length;
  setVal('#oStart', o.start + 1);
  setVal('#oEnd', o.end + 1);
  $('#oStart').max = $('#oEnd').max = N;
  setVal('#oSpeed', o.speed);
  $('#oSpeedV').textContent = `${o.speed}×`;
  setVal('#oWidth', o.width);
  setVal('#oColors', o.colors);
  setVal('#oReverse', o.reverse);
  setVal('#oBoomerang', o.boomerang);
  const order = playOrder();
  const ms = order.reduce((s, f) => s + frameDelay(f), 0);
  const { w, h } = outSize();
  $('#oInfo').textContent = `${order.length} frames · ${(ms / 1000).toFixed(1)} s · ${w}×${h}px`;
}

function outSize() {
  const { width: W, height: H } = S.clip;
  const w = S.out.width && S.out.width < W ? S.out.width : W;
  return { w, h: Math.round((H * w) / W), k: w / W };
}

function refreshAll() {
  renderLayerList();
  syncInspector();
  render();
}

// Generic bindings: live update on input, history entry on change.
function bindLayer(id, apply, { event = 'input', relist = false } = {}) {
  const el = $(id);
  el.addEventListener(event, () => {
    const L = sel();
    if (!L) return;
    const v = el.type === 'checkbox' ? el.checked : el.value;
    apply(L, v);
    if (relist) renderLayerList();
    render();
    syncInspector();
    if (event === 'change') commit();
  });
  if (event !== 'change') el.addEventListener('change', () => commit());
}

bindLayer('#pText', (L, v) => (L.text = v), { relist: true });
bindLayer('#pFont', (L, v) => {
  L.font = v;
  document.fonts.load(`40px ${FONTS[v].css}`).then(render);
}, { event: 'change' });
bindLayer('#pSize', (L, v) => (L.size = clamp(+v || 10, 4, 600)));
bindLayer('#pFill', (L, v) => (L.fill = v));
bindLayer('#pStroke', (L, v) => (L.stroke = v));
bindLayer('#pStrokeW', (L, v) => (L.strokeW = +v));
bindLayer('#pWrap', (L, v) => (L.wrap = +v));
bindLayer('#pAlign', (L, v) => (L.align = v), { event: 'change' });
bindLayer('#pUpper', (L, v) => (L.upper = v), { event: 'change', relist: true });
bindLayer('#pShadow', (L, v) => (L.shadow = v), { event: 'change' });
bindLayer('#pFlip', (L, v) => (L.flip = v), { event: 'change' });

bindLayer('#tX', (L, v) => editAt(L, S.frame, { x: +v }));
bindLayer('#tY', (L, v) => editAt(L, S.frame, { y: +v }));
bindLayer('#tS', (L, v) => editAt(L, S.frame, { s: +v / 100 }));
bindLayer('#tR', (L, v) => editAt(L, S.frame, { r: +v }));
bindLayer('#tO', (L, v) => editAt(L, S.frame, { o: +v / 100 }));
bindLayer('#kEase', (L, v) => (L.ease = v), { event: 'change' });

const N1 = () => S.clip.frames.length - 1;
bindLayer('#vStart', (L, v) => {
  L.start = clamp((+v || 1) - 1, 0, N1());
  if (L.end < L.start) L.end = L.start;
}, { event: 'change' });
bindLayer('#vEnd', (L, v) => {
  L.end = clamp((+v || 1) - 1, 0, N1());
  if (L.start > L.end) L.start = L.end;
}, { event: 'change' });
bindLayer('#aIn', (L, v) => (L.animIn = v), { event: 'change', relist: true });
bindLayer('#aOut', (L, v) => (L.animOut = v), { event: 'change', relist: true });
bindLayer('#aLoop', (L, v) => (L.animLoop = v), { event: 'change', relist: true });
bindLayer('#aInDur', (L, v) => (L.inDur = +v));
bindLayer('#aOutDur', (L, v) => (L.outDur = +v));
bindLayer('#aLoopAmt', (L, v) => (L.loopAmt = +v));

const layerAction = (id, fn) =>
  $(id).addEventListener('click', () => {
    const L = sel();
    if (!L) return;
    fn(L);
    commit();
    refreshAll();
  });
layerAction('#vStartHere', (L) => {
  L.start = S.frame;
  if (L.end < L.start) L.end = S.frame;
});
layerAction('#vEndHere', (L) => {
  L.end = S.frame;
  if (L.start > L.end) L.start = S.frame;
});
layerAction('#kToggle', (L) => toggleKey(L));
layerAction('#kClear', (L) => clearAnimation(L, S.frame));
const jumpKey = (dir) => () => {
  const L = sel();
  if (!L) return;
  const ks = L.keys.map((k) => k.f).filter((f) => (dir > 0 ? f > S.frame : f < S.frame));
  if (ks.length) setFrame(dir > 0 ? Math.min(...ks) : Math.max(...ks));
};
$('#kPrev').onclick = jumpKey(-1);
$('#kNext').onclick = jumpKey(1);

function toggleKey(L) {
  if (keyIndexAt(L, S.frame) >= 0) removeKeyframe(L, S.frame);
  else addKeyframe(L, S.frame);
}

// Remove background (re-run from the original so the slider can be tuned).
let bgTimer = 0;
function runRemoveBg() {
  const L = sel();
  if (!L || L.type !== 'image') return;
  const orig = assets.get(L.origAsset ?? L.asset);
  const cur = assets.get(L.asset);
  if (!orig || orig.frames.length !== 1) return;
  const perPx = L.w / cur.width;
  const out = removeBackground(orig.frames[0], +$('#pTol').value);
  const a = addAsset({ width: out.width, height: out.height, frames: [out], delays: [100] }, orig.name);
  L.origAsset = orig.id;
  L.asset = a.id;
  L.w = perPx * out.width;
  commit();
  refreshAll();
}
$('#btnRemoveBg').onclick = runRemoveBg;
$('#pTol').addEventListener('input', () => {
  const L = sel();
  if (L?.origAsset == null) return;
  clearTimeout(bgTimer);
  bgTimer = setTimeout(runRemoveBg, 150);
});
layerAction('#btnRestoreImg', (L) => {
  const orig = assets.get(L.origAsset);
  const cur = assets.get(L.asset);
  L.w = (L.w / cur.width) * orig.width;
  L.asset = orig.id;
  delete L.origAsset;
});

$('#kTrack').onclick = async () => {
  const L = sel();
  if (!L) return;
  const f0 = S.frame;
  if (f0 < L.start || f0 > L.end) return toast('Move to a frame where the layer is visible first.', true);
  const b = evalBase(L, f0);
  const sz = layerSize(L, S.clip.width, assets);
  const box = { x: b.x, y: b.y, w: Math.max(12, sz.w * b.s), h: Math.max(12, sz.h * b.s) };
  pause();
  const res = await busy('Tracking motion…', () =>
    trackBox(S.clip.frames, f0, L.start, L.end, box, {
      onProgress: (p) => ($('#busyText').textContent = `Tracking motion… ${Math.round(p * 100)}%`),
    }),
  );
  if (!res) return;
  L.keys = [...res.entries()]
    .sort((a, c) => a[0] - c[0])
    .map(([f, v]) => ({ f, x: v.x, y: v.y, s: b.s * v.scale, r: b.r, o: b.o }));
  L.ease = 'linear';
  L.keyed = true;
  commit();
  refreshAll();
  toast(`Tracked ${L.keys.length} frames. Scrub through and nudge any frame that drifted.`);
};

// ---------- output panel ----------

function bindOut(id, apply, event = 'input') {
  const el = $(id);
  el.addEventListener(event, () => {
    apply(el.type === 'checkbox' ? el.checked : el.value);
    S.out.start = clamp(S.out.start, 0, N1());
    S.out.end = clamp(S.out.end, S.out.start, N1());
    syncOutput();
    render();
    if (event === 'change') commit();
  });
  if (event !== 'change') el.addEventListener('change', () => commit());
}
bindOut('#oStart', (v) => (S.out.start = (+v || 1) - 1), 'change');
bindOut('#oEnd', (v) => (S.out.end = (+v || 1) - 1), 'change');
bindOut('#oSpeed', (v) => (S.out.speed = +v));
bindOut('#oWidth', (v) => (S.out.width = +v), 'change');
bindOut('#oColors', (v) => (S.out.colors = +v), 'change');
bindOut('#oReverse', (v) => (S.out.reverse = v), 'change');
bindOut('#oBoomerang', (v) => (S.out.boomerang = v), 'change');
$('#oStartHere').onclick = () => {
  S.out.start = S.frame;
  if (S.out.end < S.frame) S.out.end = N1();
  commit();
  refreshAll();
};
$('#oEndHere').onclick = () => {
  S.out.end = Math.max(S.frame, S.out.start);
  commit();
  refreshAll();
};

// ---------- export ----------

let lastUrl = null;
async function doExport() {
  if (!S.clip) return;
  pause();
  const dlg = $('#dlgExport');
  $('#exProgress').hidden = false;
  $('#exResult').hidden = true;
  $('#exBar').value = 0;
  $('#exText').textContent = 'Rendering…';
  dlg.showModal();
  await document.fonts.ready;
  const { w, h, k } = outSize();
  const order = playOrder();
  try {
    const blob = await encodeGif({
      width: w,
      height: h,
      order,
      delays: order.map(frameDelay),
      colors: S.out.colors,
      render: (ctx, f) => renderFrame(ctx, f, k),
      onProgress: (p) => {
        $('#exBar').value = p;
        $('#exText').textContent = `Encoding frame ${Math.round(p * order.length)} of ${order.length}…`;
      },
    });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const name = `meme-${stamp}.gif`;
    $('#exImg').src = lastUrl;
    $('#exDownload').href = lastUrl;
    $('#exDownload').download = name;
    $('#exInfo').textContent = `${w}×${h}px · ${order.length} frames · ${(blob.size / 1024 / 1024).toFixed(2)} MB`;
    const file = new File([blob], name, { type: 'image/gif' });
    const canShare = navigator.canShare?.({ files: [file] });
    $('#exShare').hidden = !canShare;
    $('#exShare').onclick = () => navigator.share({ files: [file] }).catch(() => {});
    $('#exProgress').hidden = true;
    $('#exResult').hidden = false;
  } catch (e) {
    console.error(e);
    $('#exText').textContent = `Export failed: ${e.message}`;
  }
}
$('#btnExport').onclick = doExport;

// ---------- GIPHY ----------

const G = { mode: 'source', kind: 'gifs', offset: 0, query: null, loading: false };

function openGiphy(mode) {
  G.mode = mode;
  const kind = mode === 'overlay' ? 'stickers' : 'gifs';
  $('#giphyTitle').textContent = mode === 'overlay' ? 'Add a sticker or GIF on top' : 'Find a GIF';
  $('#dlgGiphy').showModal();
  if (kind !== G.kind || G.query === null) {
    setKind(kind);
    runGiphy(true);
  }
  if (window.innerWidth > 900) $('#giphyQuery').focus();
}

function setKind(kind) {
  G.kind = kind;
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  $('#giphyGrid').classList.toggle('stickers', kind === 'stickers');
}

async function runGiphy(reset) {
  const grid = $('#giphyGrid');
  const msg = $('#giphyMsg');
  if (!settings.giphyKey) {
    grid.innerHTML = '';
    msg.innerHTML = 'Searching needs a free GIPHY API key. <a href="#" id="toSettings">Add it in Settings</a>. ' +
      'Without a key you can still paste a GIPHY link below.';
    $('#toSettings').onclick = (e) => {
      e.preventDefault();
      $('#dlgGiphy').close();
      openSettings();
    };
    $('#giphyMore').hidden = true;
    return;
  }
  if (G.loading) return;
  G.loading = true;
  if (reset) {
    G.offset = 0;
    G.query = $('#giphyQuery').value;
    grid.innerHTML = '';
  }
  msg.textContent = 'Loading…';
  try {
    const r = await giphySearch({ key: settings.giphyKey, query: G.query, kind: G.kind, offset: G.offset, rating: settings.rating });
    msg.textContent = r.items.length || G.offset ? (G.query.trim() ? '' : 'Trending') : 'Nothing found.';
    for (const it of r.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = it.title;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = it.thumb;
      img.width = it.thumbW;
      img.height = it.thumbH;
      img.alt = it.title;
      b.append(img);
      b.onclick = () => pickGiphy(it.gif, it.title);
      grid.append(b);
    }
    G.offset += r.items.length;
    $('#giphyMore').hidden = G.offset >= r.total || !r.items.length;
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    G.loading = false;
  }
}

function pickGiphy(url, title) {
  $('#dlgGiphy').close();
  if (G.mode === 'overlay') addOverlay(() => clipFromUrl(url, 400), title || 'GIPHY');
  else loadSource(() => clipFromUrl(url, settings.maxSide));
}

$('#giphyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  runGiphy(true);
});
let searchTimer = 0;
$('#giphyQuery').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runGiphy(true), 450);
});
document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    setKind(b.dataset.kind);
    runGiphy(true);
  }),
);
$('#giphyMore').onclick = () => runGiphy(false);
$('#giphyUrlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#giphyUrl').value.trim();
  if (url) pickGiphy(url, 'Linked GIF');
  $('#giphyUrl').value = '';
});

// ---------- settings ----------

function openSettings() {
  $('#sKey').value = settings.giphyKey;
  $('#sRating').value = settings.rating;
  $('#sMax').value = settings.maxSide;
  $('#dlgSettings').showModal();
}
$('#sSave').onclick = (e) => {
  e.preventDefault();
  settings.giphyKey = $('#sKey').value.trim();
  settings.rating = $('#sRating').value;
  settings.maxSide = +$('#sMax').value;
  saveSettings();
  $('#dlgSettings').close();
  G.query = null;
  toast('Settings saved');
};
$('#btnSettings').onclick = openSettings;

// ---------- top-level wiring ----------

$('#btnFind').onclick = () => openGiphy('source');
$('#emptyFind').onclick = () => openGiphy('source');
$('#addSticker').onclick = () => openGiphy('overlay');
$('#addText').onclick = addText;
for (const id of ['#fileSource', '#fileSource2']) {
  $(id).addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) loadSource(() => clipFromFile(f, settings.maxSide));
  });
}
$('#fileOverlay').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) addOverlay(() => clipFromFile(f, 600), f.name.replace(/\.[^.]+$/, ''));
});
$('#urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#urlInput').value.trim();
  if (url) loadSource(() => clipFromUrl(url, settings.maxSide));
});
$('#btnPlay').onclick = () => (S.playing ? pause() : play());
$('#btnPrev').onclick = () => {
  pause();
  setFrame(S.frame - 1);
};
$('#btnNext').onclick = () => {
  pause();
  setFrame(S.frame + 1);
};
$('#btnUndo').onclick = () => undo(-1);
$('#btnRedo').onclick = () => undo(1);

// Drop / paste: first item becomes the GIF, later ones become overlays.
function ingestFile(f) {
  if (!S.clip) loadSource(() => clipFromFile(f, settings.maxSide));
  else addOverlay(() => clipFromFile(f, 600), f.name.replace(/\.[^.]+$/, ''));
}
function ingestUrl(url) {
  if (!/^https?:\/\//i.test(url)) return;
  if (!S.clip) loadSource(() => clipFromUrl(url, settings.maxSide));
  else addOverlay(() => clipFromUrl(url, 400), 'Image');
}
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) return ingestFile(f);
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (url) ingestUrl(url.split('\n')[0].trim());
});
window.addEventListener('paste', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const f = e.clipboardData?.files?.[0];
  if (f) {
    e.preventDefault();
    return ingestFile(f);
  }
  const text = e.clipboardData?.getData('text/plain')?.trim();
  if (text) ingestUrl(text);
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo(e.shiftKey ? 1 : -1);
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    undo(1);
  } else if (!S.clip) {
    return;
  } else if (e.key === ' ') {
    e.preventDefault();
    S.playing ? pause() : play();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    pause();
    setFrame(S.frame + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1));
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel()) {
    deleteLayer(sel());
    commit();
    refreshAll();
  } else if (e.key.toLowerCase() === 'k' && sel()) {
    toggleKey(sel());
    commit();
    refreshAll();
  } else if (e.key.toLowerCase() === 't') {
    addText();
  }
});

new ResizeObserver(() => fitStage()).observe($('#stage'));
window.addEventListener('resize', fitStage);
document.fonts.ready.then(render);
for (const f of Object.values(FONTS)) document.fonts.load(`40px ${f.css}`).catch(() => {});

let toastTimer = 0;
function toast(text, err = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast${err ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3500);
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for debugging / automated checks.
window.__app = { S, assets, setClip, render, renderFrame, select, commit, doExport };
