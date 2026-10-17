// Renders one test scene and draws truth (green) and detection (red).
// Usage: node tests/debug.mjs <outDir> <caseIndex | n<negativeIndex>>
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Detector } from '../src/scan/detect.js';
import { locatePage } from '../src/scan/pipeline.js';
import { buildCases, buildNegatives } from './cases.js';
import { encodePNG } from './png.js';
import { renderScene } from './synth.js';

const cv = createRequire(import.meta.url)('@techstark/opencv-js');
while (!cv.Mat) await new Promise((r) => setTimeout(r, 20));
const [outDir, id] = process.argv.slice(2);
const W = 1280;
const H = 720;
const neg = id.startsWith('n');
const index = Number(neg ? id.slice(1) : id);
const scene = neg ? { ...buildNegatives()[index], hands: false, seed: 1000 + index } : { ...buildCases(W, H)[index], seed: index + 1 };
const img = renderScene({ W, H, ...scene });
const mat = cv.matFromImageData(img);
const blurred = new cv.Mat();
cv.GaussianBlur(mat, blurred, new cv.Size(0, 0), scene.blur ?? 1.1, scene.blur ?? 1.1, cv.BORDER_DEFAULT);
const found = locatePage(cv, new Detector(cv), blurred);
const fmt = (q) => q && q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('  ');
console.log('truth', fmt(scene.quad));
console.log('found', fmt(found));
const draw = (q, color) =>
  q.forEach((p, i) => {
    const r = q[(i + 1) % 4];
    cv.line(mat, new cv.Point(Math.round(p.x), Math.round(p.y)), new cv.Point(Math.round(r.x), Math.round(r.y)), color, 2);
  });
if (scene.quad) draw(scene.quad, [0, 255, 0, 255]);
if (found) draw(found, [255, 0, 0, 255]);
writeFileSync(`${outDir}/case-${id}.png`, encodePNG({ data: mat.data, width: img.width, height: img.height }));
