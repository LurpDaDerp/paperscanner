// Simulates detection streams to check tracking and auto-capture behaviour.
import { AutoCapture, Tracker } from '../src/tracker.js';

const size = { width: 640, height: 360 };
const FRAME = 70; // ms between detections
const page = [
  { x: 220, y: 60 },
  { x: 420, y: 70 },
  { x: 410, y: 320 },
  { x: 210, y: 310 },
];
const sigA = new Float32Array(192).map((_, i) => Math.sin(i));
const sigB = new Float32Array(192).map((_, i) => Math.cos(i * 1.7));
const shift = (q, dx, dy) => q.map((p) => ({ x: p.x + dx, y: p.y + dy }));
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;

// Each step: [durationMs, (t) => detection]
function simulate(steps) {
  const tracker = new Tracker();
  const auto = new AutoCapture();
  const captures = [];
  let now = 0;
  for (const [duration, frame] of steps) {
    for (let t = 0; t < duration; t += FRAME, now += FRAME) {
      tracker.update(frame(t), size, now);
      auto.update(tracker, now);
      if (auto.shouldCapture(tracker, now)) {
        captures.push(now);
        auto.captured(tracker, now);
      }
    }
  }
  return captures;
}

const held = (sig = sigA, q = page, jitter = 1.5) => () => ({
  quad: q.map((p) => ({ x: p.x + rnd() * jitter, y: p.y + rnd() * jitter })),
  signature: sig,
});
const none = () => ({ quad: null });

const checks = [
  ['steady page is captured once', simulate([[5000, held()]]), (c) => c.length === 1 && c[0] >= 900 && c[0] < 1300],
  ['moving page is not captured', simulate([[3000, (t) => ({ quad: shift(page, t / 15, 0), signature: sigA })]]), (c) => c.length === 0],
  ['short dropouts are bridged', simulate([[400, held()], [140, none], [700, held()]]), (c) => c.length === 1],
  ['page removed and shown again is captured again', simulate([[2000, held()], [800, none], [2000, held()]]), (c) => c.length === 2],
  ['page swapped in place is captured', simulate([[2000, held(sigA)], [2500, held(sigB)]]), (c) => c.length === 2 && c[1] >= 2000 + 900],
  ['same page moved a lot is captured again', simulate([[2000, held()], [300, (t) => ({ quad: shift(page, t / 2, 0), signature: sigA })], [2000, held(sigA, shift(page, 150, 0))]]), (c) => c.length === 2],
  ['a one-frame false detection is ignored', simulate([[2000, held()], [70, () => ({ quad: shift(page, 200, 0), signature: sigB })], [2000, held()]]), (c) => c.length === 1],
  ['tiny pages are not auto-captured', simulate([[3000, held(sigA, page.map((p) => ({ x: 320 + (p.x - 320) * 0.2, y: 180 + (p.y - 180) * 0.2 })))]]), (c) => c.length === 0],
];

let failed = 0;
for (const [name, captures, ok] of checks) {
  const pass = ok(captures);
  if (!pass) failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name} (captures at ${captures.join(', ') || 'none'})`);
}
console.log(failed ? 'FAILED' : 'PASSED');
process.exit(failed ? 1 : 0);
