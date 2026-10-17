// Accuracy test for the page detector on synthetic hand-held page scenes.
// Run with: npm test
import { createRequire } from 'node:module';
import { Detector } from '../src/scan/detect.js';
import { alignQuad, dist } from '../src/scan/geometry.js';
import { locatePage } from '../src/scan/pipeline.js';
import { buildCases, buildNegatives } from './cases.js';
import { renderScene } from './synth.js';

const require = createRequire(import.meta.url);

// The module object is a non-standard thenable, so it must never be awaited or
// returned from an async function. Poll for the runtime instead.
const cv = require('@techstark/opencv-js');
while (!cv.Mat) await new Promise((r) => setTimeout(r, 20));
const detector = new Detector(cv);
const W = 1280;
const H = 720;

function run(scene) {
  const img = renderScene({ W, H, ...scene });
  const mat = cv.matFromImageData(img);
  const blurred = new cv.Mat();
  cv.GaussianBlur(mat, blurred, new cv.Size(0, 0), 1.1, 1.1, cv.BORDER_DEFAULT);
  try {
    return locatePage(cv, detector, blurred);
  } finally {
    mat.delete();
    blurred.delete();
  }
}

const cases = buildCases(W, H);

let failures = 0;
const errors = [];
let missed = 0;
cases.forEach((scene, i) => {
  // Renderer samples pixel x over [x, x+1); detector uses pixel centres.
  const truth = scene.quad.map((p) => ({ x: p.x - 0.5, y: p.y - 0.5 }));
  const t0 = Date.now();
  const found = run({ ...scene, seed: i + 1 });
  if (process.env.VERBOSE) console.log(`  case ${i} ${Date.now() - t0}ms`);
  if (!found) {
    missed++;
    console.log(`  case ${i} (${scene.bg}${scene.landscape ? ', landscape' : ''}): NOT DETECTED`);
    return;
  }
  const q = alignQuad(truth, found);
  const errs = q.map((p, k) => dist(p, truth[k]));
  errors.push(...errs);
  const max = Math.max(...errs);
  if (max > 4) console.log(`  case ${i} (${scene.bg}): max corner error ${max.toFixed(2)}px`);
});

errors.sort((a, b) => a - b);
const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
const p95 = errors[Math.floor(errors.length * 0.95)];
const max = errors[errors.length - 1];
console.log(`Positive scenes: ${cases.length}, detected ${cases.length - missed}`);
console.log(`Corner error (px @ ${W}x${H}): mean ${mean.toFixed(2)}, p95 ${p95.toFixed(2)}, max ${max.toFixed(2)}`);
if (missed > 0) failures++;
if (mean > 1.5 || p95 > 3 || max > 6) failures++;

const negatives = buildNegatives();
negatives.forEach((scene, i) => {
  const found = run({ ...scene, hands: false, seed: 1000 + i });
  console.log(`Negative ${i} (${scene.bg}${scene.quad ? ', cut off' : ', empty'}): ${found ? 'FALSE DETECTION' : 'ok'}`);
  if (found) failures++;
});

console.log(failures ? `\nFAILED (${failures})` : '\nPASSED');
process.exit(failures ? 1 : 0);
