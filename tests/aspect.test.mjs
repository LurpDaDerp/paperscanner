// Checks that page proportions are recovered from perspective views.
import { pageGeometry } from '../src/scan/warp.js';
import { rng } from './synth.js';

const W = 1280;
const H = 720;
const rand = rng(7);

// Projects a w x h rectangle (in mm) rotated in 3D and placed `z` mm away.
function project(w, h, { yaw, pitch, roll, z, f, ox, oy }) {
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => {
    // roll (z), then pitch (x), then yaw (y)
    let X = x * cr - y * sr;
    let Y = x * sr + y * cr;
    let Z = 0;
    [Y, Z] = [Y * cp - Z * sp, Y * sp + Z * cp];
    [X, Z] = [X * cy + Z * sy, -X * sy + Z * cy];
    Z += z;
    X += (ox * z) / f;
    Y += (oy * z) / f;
    return { x: W / 2 + (f * X) / Z, y: H / 2 + (f * Y) / Z };
  });
}

const papers = [
  { name: 'Letter', w: 215.9, h: 279.4 },
  { name: 'A4', w: 210, h: 297 },
];
let failures = 0;
let worst = 0;
let total = 0;
for (const paper of papers) {
  for (let i = 0; i < 60; i++) {
    const deg = Math.PI / 180;
    const f = 700 + rand() * 600;
    const landscape = i % 4 === 0;
    const pose = {
      yaw: (rand() - 0.5) * 50 * deg,
      pitch: (rand() - 0.5) * 50 * deg,
      roll: (rand() - 0.5) * 40 * deg,
      z: 380 + rand() * 250,
      f,
      ox: (rand() - 0.5) * 200,
      oy: (rand() - 0.5) * 100,
    };
    // ±1px corner noise, like real detections.
    const quad = (landscape ? project(paper.h, paper.w, pose) : project(paper.w, paper.h, pose)).map((p) => ({
      x: p.x + (rand() - 0.5) * 2,
      y: p.y + (rand() - 0.5) * 2,
    }));
    const g = pageGeometry(quad, W, H);
    const isLandscape = g.width > g.height;
    const ratio = Math.max(g.width, g.height) / Math.min(g.width, g.height);
    const err = Math.abs(ratio / (paper.h / paper.w) - 1);
    worst = Math.max(worst, err);
    total++;
    if (g.format !== paper.name || isLandscape !== landscape) {
      failures++;
      console.log(`  ${paper.name}${landscape ? ' landscape' : ''} f=${f.toFixed(0)}: got ${g.format} ${isLandscape ? 'landscape' : 'portrait'} (ratio ${ratio.toFixed(3)})`);
    }
  }
}
console.log(`Aspect: ${total - failures}/${total} pages got the right paper size and orientation; worst ratio error ${(worst * 100).toFixed(1)}%`);
console.log(failures ? 'FAILED' : 'PASSED');
process.exit(failures ? 1 : 0);
