// Measures live detection time per frame at the app's detection size.
import { createRequire } from 'node:module';
import { Detector } from '../src/scan/detect.js';
import { buildCases } from './cases.js';
import { renderScene } from './synth.js';

const cv = createRequire(import.meta.url)('@techstark/opencv-js');
while (!cv.Mat) await new Promise((r) => setTimeout(r, 20));
const detector = new Detector(cv);
const frames = buildCases(1280, 720).slice(0, 12).map((scene, i) => {
  const img = renderScene({ W: 640, H: 360, ...scene, quad: scene.quad.map((p) => ({ x: p.x / 2, y: p.y / 2 })), seed: i });
  return img;
});
for (const f of frames) detector.detect(f); // warm up
const times = [];
for (let r = 0; r < 3; r++) {
  for (const f of frames) {
    const t = performance.now();
    detector.detect(f);
    times.push(performance.now() - t);
  }
}
times.sort((a, b) => a - b);
console.log(`detect @640x360: median ${times[times.length >> 1].toFixed(1)}ms, max ${times[times.length - 1].toFixed(1)}ms`);
