// Checks that page signatures separate "same page, slightly moved" from
// "a different page in the same place" (used to avoid double auto-captures).
import { createRequire } from 'node:module';
import { Detector, PAGE_CHANGE_DISTANCE, signatureDistance } from '../src/scan/detect.js';
import { randomQuad, renderScene, rng } from './synth.js';

const cv = createRequire(import.meta.url)('@techstark/opencv-js');
while (!cv.Mat) await new Promise((r) => setTimeout(r, 20));
const detector = new Detector(cv);
const rand = rng(99);
const W = 640;
const H = 360;

function sig(quad, textSeed, seed) {
  const found = detector.detect(renderScene({ W, H, quad, textSeed, seed, bg: 'dark' }));
  return found ? detector.signature(found.quad) : null;
}

const same = [];
const different = [];
for (let i = 0; i < 10; i++) {
  const q = randomQuad(rand, W, H);
  const jitter = q.map((p) => ({ x: p.x + (rand() - 0.5) * 6, y: p.y + (rand() - 0.5) * 6 }));
  const a = sig(q, i, 1);
  const b = sig(jitter, i, 2);
  const c = sig(jitter, i + 100, 3);
  if (!a || !b || !c) {
    console.log(`case ${i}: page not detected (${!!a}, ${!!b}, ${!!c})`);
    process.exit(1);
  }
  same.push(signatureDistance(a, b));
  different.push(signatureDistance(a, c));
}
const maxSame = Math.max(...same);
const minDiff = Math.min(...different);
console.log(`Signature distance: same page max ${maxSame.toFixed(3)}, different page min ${minDiff.toFixed(3)}`);
// Require a safety margin on both sides of the threshold.
const ok = maxSame < PAGE_CHANGE_DISTANCE * 0.8 && minDiff > PAGE_CHANGE_DISTANCE * 1.2;
console.log(ok ? 'PASSED' : 'FAILED');
process.exit(ok ? 0 : 1);
