// Deterministic scene lists shared by the test and the debug tool.
import { randomQuad, rng } from './synth.js';

export function buildCases(W, H) {
  const cases = [];
  const rand = rng(42);
  const bgs = ['dark', 'light', 'cluttered'];
  for (let i = 0; i < 36; i++) cases.push({ bg: bgs[i % 3], quad: randomQuad(rand, W, H) });
  for (let i = 0; i < 9; i++) cases.push({ bg: bgs[i % 3], landscape: true, quad: randomQuad(rand, W, H, { landscape: true }) });
  for (let i = 0; i < 6; i++) cases.push({ bg: bgs[i % 3], quad: randomQuad(rand, W, H, { maxRot: 50 }) });
  for (let i = 0; i < 6; i++) cases.push({ bg: bgs[i % 3], hands: false, noise: 6, quad: randomQuad(rand, W, H) });
  return cases;
}

export function buildNegatives() {
  return [
    { bg: 'dark', quad: null },
    { bg: 'light', quad: null },
    // A room with shelves and a person (a clean bright window would rightly
    // be outlined as a rectangle, so it is left out here).
    { bg: 'room', quad: null },
    // Page cut off by the frame edge.
    { bg: 'dark', quad: [{ x: -60, y: 100 }, { x: 500, y: 90 }, { x: 510, y: 640 }, { x: -50, y: 650 }] },
    { bg: 'cluttered', quad: [{ x: 700, y: 200 }, { x: 1400, y: 200 }, { x: 1400, y: 700 }, { x: 700, y: 700 }] },
    { bg: 'light', quad: [{ x: 300, y: -80 }, { x: 900, y: -80 }, { x: 900, y: 500 }, { x: 300, y: 500 }] },
  ];
}
