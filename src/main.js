import './style.css';
import { Camera } from './camera.js';
import { Engine } from './engine.js';
import { createPage, disposePage, rotatePage } from './pages.js';
import { buildPdf, downloadBlob, scanFilename } from './pdf.js';
import { DETECT_SIZE, rescale } from './scan/pipeline.js';
import { AUTO_MIN_AREA, AutoCapture, Tracker } from './tracker.js';

const $ = (id) => document.getElementById(id);
const MODE_KEY = 'paperscanner.mode';

const el = {
  views: { home: $('view-home'), scan: $('view-scan'), review: $('view-review') },
  start: $('start'),
  stage: $('stage'),
  video: $('video'),
  overlay: $('overlay'),
  flash: $('flash'),
  hint: $('hint'),
  closeScan: $('close-scan'),
  switchCamera: $('switch-camera'),
  stageMessage: $('stage-message'),
  stageMessageText: $('stage-message-text'),
  stageMessageAction: $('stage-message-action'),
  modeButtons: [...document.querySelectorAll('.segmented [data-mode]')],
  shutter: $('shutter'),
  shutterProgress: $('shutter-progress'),
  done: $('done'),
  doneThumb: $('done-thumb'),
  count: $('count'),
  grid: $('grid'),
  empty: $('empty'),
  pageCount: $('page-count'),
  download: $('download'),
  scanMore: $('scan-more'),
  clear: $('clear'),
  emptyStart: $('empty-start'),
  toast: $('toast'),
};

const state = {
  view: 'home',
  pages: [],
  dirty: false, // pages changed since the last download
  scanning: false, // detection loop running
  session: 0, // invalidates stale async work when the scanner restarts
  busy: false, // a capture is being processed
  engineReady: false,
  engineError: null,
  mode: readMode(),
};

const engine = new Engine();
const camera = new Camera(el.video);
const tracker = new Tracker();
const auto = new AutoCapture();

engine.ready.then(
  () => {
    state.engineReady = true;
    updateShutter();
  },
  (err) => {
    state.engineError = err;
    if (state.view === 'scan') showStageMessage('The scanner failed to load. Check your connection and reload the page.', 'Reload', () => location.reload());
  },
);

function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'manual' ? 'manual' : 'auto';
  } catch {
    return 'auto';
  }
}

// ---------------------------------------------------------------- Views

function show(view) {
  state.view = view;
  for (const [name, node] of Object.entries(el.views)) {
    const active = name === view;
    node.toggleAttribute('data-active', active);
    node.inert = !active;
  }
}

async function openScanner() {
  show('scan');
  await startScanner();
}

function leaveScanner() {
  stopScanner();
  if (state.pages.length) openReview();
  else show('home');
}

function openReview() {
  stopScanner();
  renderGrid();
  show('review');
}

// ---------------------------------------------------------------- Scanner

async function startScanner() {
  const session = ++state.session;
  hideStageMessage();
  tracker.reset();
  auto.armed = true;
  setHint('Starting camera…', true);
  updateShutter();
  if (state.engineError) {
    showStageMessage('The scanner failed to load. Check your connection and reload the page.', 'Reload', () => location.reload());
    return;
  }
  // A slow start usually means the browser is showing its permission prompt.
  const permissionHint = setTimeout(() => {
    if (session === state.session) setHint('Allow camera access to continue', true);
  }, 1200);
  try {
    await camera.start();
  } catch (err) {
    if (session !== state.session) return;
    showStageMessage(err.message, err.retry === false ? null : 'Try again', () => startScanner());
    return;
  } finally {
    clearTimeout(permissionHint);
  }
  if (session !== state.session || state.view !== 'scan') {
    camera.stop();
    return;
  }
  el.video.classList.add('live');
  camera.devices().then((list) => {
    el.switchCamera.hidden = list.length < 2;
  });
  state.scanning = true;
  updateShutter();
  detectLoop(session);
  renderLoop(session);
}

function stopScanner() {
  state.session++;
  state.scanning = false;
  camera.stop();
  el.video.classList.remove('live');
  tracker.reset();
  setProgress(0);
  updateShutter();
}

camera.onEnded = () => {
  if (state.view !== 'scan') return;
  state.scanning = false;
  el.video.classList.remove('live');
  updateShutter();
  showStageMessage('The camera was disconnected.', 'Try again', () => startScanner());
};

function showStageMessage(text, action, onAction) {
  el.stageMessageText.textContent = text;
  el.stageMessageAction.hidden = !action;
  el.stageMessageAction.textContent = action || '';
  el.stageMessageAction.onclick = onAction;
  el.stageMessage.hidden = false;
  el.hint.hidden = true;
}

function hideStageMessage() {
  el.stageMessage.hidden = true;
  el.hint.hidden = false;
}

const nextVideoFrame = () =>
  new Promise((resolve) => {
    if (el.video.requestVideoFrameCallback && !document.hidden) el.video.requestVideoFrameCallback(() => resolve());
    else setTimeout(resolve, 60);
  });

const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });

async function detectLoop(session) {
  while (session === state.session && state.scanning) {
    await nextVideoFrame();
    if (session !== state.session || !state.scanning) return;
    const { videoWidth: vw, videoHeight: vh } = el.video;
    if (!state.engineReady || state.busy || document.hidden || !vw || el.video.readyState < 2) {
      updateHint();
      continue;
    }
    const s = Math.min(1, DETECT_SIZE / Math.max(vw, vh));
    const w = Math.round(vw * s);
    const h = Math.round(vh * s);
    if (detectCanvas.width !== w || detectCanvas.height !== h) {
      detectCanvas.width = w;
      detectCanvas.height = h;
    }
    detectCtx.drawImage(el.video, 0, 0, w, h);
    let result;
    try {
      result = await engine.detect(detectCtx.getImageData(0, 0, w, h));
    } catch (err) {
      console.error(err);
      continue;
    }
    if (session !== state.session || state.busy) continue;
    const now = performance.now();
    tracker.update(result, { width: w, height: h }, now);
    auto.update(tracker, now);
    setProgress(state.mode === 'auto' ? auto.progress(tracker, now) : 0);
    updateHint();
    if (state.mode === 'auto' && auto.shouldCapture(tracker, now)) capture();
  }
}

// ---------------------------------------------------------------- Overlay

let shown = null; // quad currently drawn (stage CSS px), eased towards the target
let shownAlpha = 0;

// Maps detection-frame coordinates to stage CSS pixels (video is object-fit: contain).
function videoRect() {
  const { clientWidth: sw, clientHeight: sh } = el.stage;
  const { videoWidth: vw, videoHeight: vh } = el.video;
  if (!vw || !vh) return null;
  const s = Math.min(sw / vw, sh / vh);
  return { x: (sw - vw * s) / 2, y: (sh - vh * s) / 2, w: vw * s, h: vh * s, vw, vh };
}

function toStage(quad, size) {
  const r = videoRect();
  if (!r) return null;
  const k = r.w / size.width;
  return quad.map((p) => ({ x: r.x + (p.x + 0.5) * k, y: r.y + (p.y + 0.5) * k }));
}

function renderLoop(session) {
  const ctx = el.overlay.getContext('2d');
  const frame = () => {
    if (session !== state.session) {
      ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
      shown = null;
      shownAlpha = 0;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = el.stage.clientWidth;
    const h = el.stage.clientHeight;
    if (el.overlay.width !== Math.round(w * dpr) || el.overlay.height !== Math.round(h * dpr)) {
      el.overlay.width = Math.round(w * dpr);
      el.overlay.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const target = tracker.quad ? toStage(tracker.quad, tracker.size) : null;
    if (target) {
      shown = shown ? shown.map((p, i) => ({ x: p.x + (target[i].x - p.x) * 0.35, y: p.y + (target[i].y - p.y) * 0.35 })) : target;
    }
    shownAlpha += ((target ? 1 : 0) - shownAlpha) * 0.2;
    if (shown && shownAlpha > 0.01) {
      drawPageOverlay(ctx, shown, w, h, shownAlpha);
    } else if (!target) {
      shown = null;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Dims the scene around the page, outlines it and marks its corners.
function drawPageOverlay(ctx, quad, w, h, alpha) {
  const progress = state.mode === 'auto' ? auto.progress(tracker, performance.now()) : 0;
  const page = new Path2D();
  quad.forEach((p, i) => (i ? page.lineTo(p.x, p.y) : page.moveTo(p.x, p.y)));
  page.closePath();

  ctx.globalAlpha = alpha;
  const outside = new Path2D();
  outside.rect(0, 0, w, h);
  outside.addPath(page);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fill(outside, 'evenodd');
  ctx.fillStyle = `rgba(255, 255, 255, ${0.06 + 0.12 * progress})`;
  ctx.fill(page);

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 6;
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.stroke(page);

  // Corner brackets along both sides meeting at each corner.
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  quad.forEach((p, i) => {
    for (const q of [quad[(i + 1) % 4], quad[(i + 3) % 4]]) {
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const k = Math.min(22, len * 0.2) / len;
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + (q.x - p.x) * k, p.y + (q.y - p.y) * k);
    }
  });
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- Hints & controls

let hintText = '';
let hintChangedAt = 0;
let hintTimer = 0;

function setHint(text, immediate = false) {
  if (text === hintText) return;
  const now = performance.now();
  clearTimeout(hintTimer);
  // Avoid flicker: keep each hint up for a moment before swapping.
  const wait = immediate ? 0 : Math.max(0, 450 - (now - hintChangedAt));
  hintTimer = setTimeout(() => {
    hintText = text;
    hintChangedAt = performance.now();
    el.hint.classList.add('swap');
    setTimeout(() => {
      el.hint.textContent = text;
      el.hint.classList.remove('swap');
    }, 150);
  }, wait);
}

function updateHint() {
  if (!state.engineReady) return setHint('Loading scanner…');
  if (!state.scanning || el.video.readyState < 2) return setHint('Starting camera…');
  if (state.busy) return;
  const now = performance.now();
  if (!tracker.quad) {
    return setHint(state.mode === 'auto' && !auto.armed ? 'Captured. Show the next page' : 'Hold a page up to the camera');
  }
  if (tracker.area < AUTO_MIN_AREA) return setHint('Move the page closer');
  if (state.mode === 'manual') return setHint('Press the shutter to capture');
  if (!auto.armed) return setHint('Captured. Show the next page');
  return setHint(auto.progress(tracker, now) > 0.15 ? 'Hold still…' : 'Hold steady');
}

function setProgress(p) {
  el.shutter.classList.toggle('counting', p > 0.05);
  el.shutterProgress.style.strokeDashoffset = String(232.5 * (1 - p));
}

function updateShutter() {
  el.shutter.disabled = !(state.engineReady && state.scanning) || state.busy;
}

function setMode(mode) {
  state.mode = mode;
  for (const b of el.modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not remembered; harmless.
  }
  setProgress(0);
  updateHint();
}

function updateDone() {
  const n = state.pages.length;
  el.done.disabled = n === 0;
  el.count.textContent = String(n);
  const last = state.pages[n - 1];
  el.doneThumb.style.backgroundImage = last ? `url("${last.thumb}")` : '';
}

// ---------------------------------------------------------------- Capture

function flash() {
  el.flash.classList.remove('go');
  void el.flash.offsetWidth;
  el.flash.classList.add('go');
}

async function capture() {
  if (state.busy || !state.engineReady || !state.scanning || el.video.readyState < 2) return;
  const { videoWidth: vw, videoHeight: vh } = el.video;
  state.busy = true;
  updateShutter();
  el.shutter.classList.add('busy');
  setProgress(0);

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = vw;
  frameCanvas.height = vh;
  const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
  frameCtx.drawImage(el.video, 0, 0, vw, vh);
  // Flash right away when a page is in view; otherwise only once one is found.
  const tracked = !!tracker.quad;
  if (tracked) flash();

  const trackedQuad = tracked ? rescale(tracker.quad, vw / tracker.size.width) : null;
  const flyFrom = tracked ? toStage(tracker.quad, tracker.size) : null;

  try {
    const result = await engine.process(frameCtx.getImageData(0, 0, vw, vh), { quad: trackedQuad, detect: true });
    if (!result.quad) {
      toast('No page found. Hold the whole page in view.');
      return;
    }
    if (!tracked) flash();
    auto.captured(tracker, performance.now());
    const page = await createPage(result);
    state.pages.push(page);
    state.dirty = true;
    flyToStack(page, flyFrom);
    updateDone();
    el.count.classList.remove('bump');
    void el.count.offsetWidth;
    el.count.classList.add('bump');
  } catch (err) {
    console.error(err);
    toast("Couldn't capture the page. Please try again.");
  } finally {
    state.busy = false;
    el.shutter.classList.remove('busy');
    updateShutter();
  }
}

// Animates the new page's thumbnail from where it was detected into the Done button.
function flyToStack(page, fromQuad) {
  if (state.view !== 'scan' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const stage = el.stage.getBoundingClientRect();
  let from;
  if (fromQuad) {
    const xs = fromQuad.map((p) => p.x);
    const ys = fromQuad.map((p) => p.y);
    from = { x: stage.left + Math.min(...xs), y: stage.top + Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  } else {
    const r = videoRect();
    from = { x: stage.left + r.x, y: stage.top + r.y, w: r.w, h: r.h };
  }
  const to = el.doneThumb.getBoundingClientRect();
  const img = new Image();
  img.src = page.thumb;
  img.className = 'flyer';
  img.alt = '';
  Object.assign(img.style, { left: `${from.x}px`, top: `${from.y}px`, width: `${from.w}px`, height: `${from.h}px` });
  document.body.append(img);
  const dx = to.left + to.width / 2 - (from.x + from.w / 2);
  const dy = to.top + to.height / 2 - (from.y + from.h / 2);
  const s = Math.min(to.width / from.w, to.height / from.h);
  img
    .animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(0, ${-12}px) scale(0.92)`, opacity: 1, offset: 0.25 },
        { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0.6 },
      ],
      { duration: 650, easing: 'cubic-bezier(0.5, 0, 0.2, 1)', fill: 'forwards' },
    )
    .finished.finally(() => img.remove());
}

// ---------------------------------------------------------------- Review

const ICONS = {
  rotate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
};

function renderGrid() {
  const n = state.pages.length;
  el.pageCount.textContent = `${n} ${n === 1 ? 'page' : 'pages'}`;
  el.download.disabled = n === 0;
  el.clear.hidden = n === 0;
  el.empty.hidden = n > 0;
  el.grid.hidden = n === 0;
  el.grid.replaceChildren(...state.pages.map((page, i) => card(page, i)));
}

function card(page, index) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = page.id;
  li.style.animationDelay = `${Math.min(index, 12) * 30}ms`;
  const format = page.geometry.format || '';
  li.innerHTML = `
    <img alt="Page ${index + 1}" src="${page.thumb}" />
    <span class="card-label">${index + 1}</span>
    <span class="card-format">${format}</span>
    <div class="card-actions">
      <button class="icon-btn glass" data-action="rotate" aria-label="Rotate page ${index + 1}" title="Rotate">${ICONS.rotate}</button>
      <button class="icon-btn glass" data-action="delete" aria-label="Delete page ${index + 1}" title="Delete">${ICONS.trash}</button>
    </div>`;
  return li;
}

el.grid.addEventListener('click', async (e) => {
  const li = e.target.closest('.card');
  if (!li || li.classList.contains('leaving')) return;
  const page = state.pages.find((p) => p.id === Number(li.dataset.id));
  if (!page) return;
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'rotate') {
    await rotatePage(page);
    state.dirty = true;
    const img = li.querySelector('img');
    img.src = page.thumb;
    img.classList.remove('turn');
    void img.offsetWidth;
    img.classList.add('turn');
  } else if (action === 'delete') {
    li.classList.add('leaving');
    await new Promise((r) => setTimeout(r, 280));
    state.pages = state.pages.filter((p) => p !== page);
    disposePage(page);
    state.dirty = state.pages.length > 0;
    renderGrid();
    updateDone();
  }
});

let clearTimer = 0;
el.clear.addEventListener('click', () => {
  if (!el.clear.classList.contains('confirm')) {
    el.clear.classList.add('confirm');
    el.clear.textContent = 'Tap again to clear';
    clearTimer = setTimeout(resetClear, 3000);
    return;
  }
  resetClear();
  for (const p of state.pages) disposePage(p);
  state.pages = [];
  state.dirty = false;
  updateDone();
  renderGrid();
});

function resetClear() {
  clearTimeout(clearTimer);
  el.clear.classList.remove('confirm');
  el.clear.textContent = 'Start over';
}

el.download.addEventListener('click', async () => {
  if (!state.pages.length || el.download.disabled) return;
  const label = el.download.querySelector('span');
  const icon = el.download.querySelector('svg');
  el.download.disabled = true;
  label.textContent = 'Preparing…';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  icon.replaceWith(spinner);
  try {
    const blob = await buildPdf(state.pages);
    downloadBlob(blob, scanFilename());
    state.dirty = false;
  } catch (err) {
    console.error(err);
    toast("Couldn't create the PDF. Please try again.");
  } finally {
    spinner.replaceWith(icon);
    label.textContent = 'Download PDF';
    el.download.disabled = state.pages.length === 0;
  }
});

// ---------------------------------------------------------------- Toast

let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
}

// ---------------------------------------------------------------- Wiring

el.start.addEventListener('click', openScanner);
el.emptyStart.addEventListener('click', openScanner);
el.scanMore.addEventListener('click', openScanner);
el.closeScan.addEventListener('click', leaveScanner);
el.done.addEventListener('click', openReview);
el.shutter.addEventListener('click', () => capture());
el.switchCamera.addEventListener('click', async () => {
  const session = state.session;
  el.switchCamera.disabled = true;
  tracker.reset();
  try {
    await camera.next();
  } catch (err) {
    if (session === state.session) showStageMessage(err.message, 'Try again', () => startScanner());
  } finally {
    el.switchCamera.disabled = false;
  }
});
for (const b of el.modeButtons) b.addEventListener('click', () => setMode(b.dataset.mode));
setMode(state.mode);

document.addEventListener('keydown', (e) => {
  if (state.view !== 'scan') return;
  if (e.key === 'Escape') leaveScanner();
  else if ((e.key === ' ' || e.code === 'Space') && !e.target.closest('button, input')) {
    e.preventDefault();
    if (!el.shutter.disabled) capture();
  }
});

document.addEventListener('visibilitychange', () => {
  // Frames from before the tab was hidden say nothing about the page now.
  if (!document.hidden) tracker.reset();
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty && state.pages.length) {
    e.preventDefault();
    e.returnValue = '';
  }
});

updateDone();

if (import.meta.env.DEV) window.__scanner = { state, tracker, auto, camera, engine };
