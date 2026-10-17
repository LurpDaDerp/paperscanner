// Runs all OpenCV work off the main thread.
import { Detector } from './detect.js';
import { locatePage } from './pipeline.js';
import { pageGeometry, warpPage } from './warp.js';

let cv = null;
let detector = null;

async function loadOpenCV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load OpenCV (${res.status})`);
  // OpenCV.js is a classic UMD script; indirect eval runs it in global scope,
  // where it registers `self.cv`. (Module workers cannot use importScripts.)
  (0, eval)(await res.text());
  const mod = self.cv;
  const start = Date.now();
  // The module is a non-standard thenable, so it is never awaited directly.
  while (!mod.Mat) {
    if (Date.now() - start > 60000) throw new Error('OpenCV took too long to initialise');
    await new Promise((r) => setTimeout(r, 20));
  }
  cv = mod;
  detector = new Detector(cv);
}

const toImage = ({ width, height, buffer }) => ({ width, height, data: new Uint8ClampedArray(buffer) });

function withMat(image, fn) {
  const mat = cv.matFromImageData(toImage(image));
  try {
    return fn(mat);
  } finally {
    mat.delete();
  }
}

const handlers = {
  init: async ({ url }) => {
    await loadOpenCV(url);
    return {};
  },

  // Live detection on a small frame. Returns the quad and a page signature.
  detect: ({ image }) => {
    const found = detector.detect(toImage(image));
    return found ? { quad: found.quad, signature: detector.signature(found.quad) } : { quad: null };
  },

  // Finds the page on a full-resolution frame (no warping).
  locate: ({ image, hint }) => ({ quad: withMat(image, (mat) => locatePage(cv, detector, mat, hint)) }),

  // Produces the final page image. With `detect`, the page is located first
  // (using `quad` as a hint); otherwise `quad` is used exactly as given.
  process: ({ image, quad, detect }) =>
    withMat(image, (mat) => {
      const q = detect ? locatePage(cv, detector, mat, quad) : quad;
      if (!q) return { quad: null };
      const geometry = pageGeometry(q, image.width, image.height);
      const pixels = warpPage(cv, mat, q, geometry.width, geometry.height);
      return { quad: q, geometry, buffer: pixels.buffer, transfer: [pixels.buffer] };
    }),
};

self.onmessage = async ({ data }) => {
  const { id, type, ...args } = data;
  try {
    const { transfer = [], ...result } = await handlers[type](args);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
