// Prints detector candidates for one test case. Usage: node tests/cands.mjs <caseIndex>
import { createRequire } from 'node:module';
import { Detector } from '../src/scan/detect.js';
import { buildCases, buildNegatives } from './cases.js';
import { renderScene } from './synth.js';
const cv = createRequire(import.meta.url)('@techstark/opencv-js');
while (!cv.Mat) await new Promise((r) => setTimeout(r, 20));

const id = process.argv[2];
const neg = id.startsWith('n');
const i = Number(neg ? id.slice(1) : id);
const scene = neg ? { ...buildNegatives()[i], hands: false, seed: 1000 + i } : { ...buildCases(1280, 720)[i], seed: i + 1 };
const img = renderScene({ W: 1280, H: 720, ...scene });
const mat = cv.matFromImageData(img);
const small = new cv.Mat();
cv.GaussianBlur(mat, mat, new cv.Size(0, 0), scene.blur ?? 1.1, scene.blur ?? 1.1, cv.BORDER_DEFAULT);
const scale = Math.min(1, 640 / Math.max(img.width, img.height));
cv.resize(mat, small, new cv.Size(Math.round(img.width * scale), Math.round(img.height * scale)), 0, 0, cv.INTER_AREA);
const debug = [];
new Detector(cv).detect({ data: small.data, width: small.cols, height: small.rows }, { debug });
const fmt = (q) => q.map((p) => `${(p.x / scale).toFixed(0)},${(p.y / scale).toFixed(0)}`).join(' ');
if (scene.quad) console.log('truth', fmt(scene.quad.map((p) => ({ x: p.x * scale, y: p.y * scale }))));
for (const d of debug) console.log(d.reason.padEnd(30), fmt(d.quad));
if (process.argv[3]) {
  const { writeFileSync } = await import('node:fs');
  const { encodePNG } = await import('./png.js');
  const d = new Detector(cv);
  d.detect({ data: small.data, width: small.cols, height: small.rows });
  const e = d.last.edges;
  const rgba = new Uint8ClampedArray(small.cols * small.rows * 4);
  for (let k = 0; k < e.length; k++) {
    const v = e[k] ? 255 : d.last.gray[k] / 3;
    rgba.set([v, v, v, 255], k * 4);
  }
  writeFileSync(process.argv[3], encodePNG({ data: rgba, width: small.cols, height: small.rows }));
}
