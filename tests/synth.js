// Renders synthetic webcam-like scenes of a hand-held page with known corners.

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1e9) / 1e9;
  };
}

// Homography mapping the unit square to quad q (tl, tr, br, bl).
function squareToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

const hash = (a, b) => {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function pageColor(u, v, landscape) {
  const shade = 1 - 0.06 * v + 0.03 * u;
  let c = [244 * shade, 242 * shade, 236 * shade];
  const lineH = landscape ? 0.045 : 0.03;
  if (u > 0.1 && u < 0.9 && v > 0.1 && v < 0.88) {
    const row = Math.floor((v - 0.1) / lineH);
    const inRow = ((v - 0.1) / lineH) % 1;
    if (inRow > 0.25 && inRow < 0.65) {
      const word = Math.floor(u * 22);
      const inWord = (u * 22) % 1;
      if (hash(row, word) > 0.12 && inWord < 0.8 && !(hash(row, 99) < 0.2 && u > 0.6)) {
        c = [45, 45, 50];
      }
    }
  }
  if (u > 0.1 && u < 0.45 && v > 0.04 && v < 0.07) c = [30, 30, 35];
  return c;
}

const SKIN = [198, 146, 118];

function background(kind, x, y, W, H) {
  const u = x / W;
  const v = y / H;
  switch (kind) {
    case 'light':
      return [212 - 25 * v, 208 - 25 * v, 200 - 25 * v];
    case 'room':
    case 'cluttered': {
      // Shelves, a window (cluttered only) and a person behind the page.
      if (kind === 'cluttered' && u > 0.72 && u < 0.97 && v > 0.05 && v < 0.45) return [196 + 30 * v, 218 + 20 * v, 245];
      const fx = (u - 0.5) / 0.13;
      const fy = (v - 0.32) / 0.22;
      if (fx * fx + fy * fy < 1) return SKIN;
      if (v > 0.55 && Math.abs(u - 0.5) < 0.3) return [40, 52, 90];
      if (u < 0.25 && Math.floor(v * 8) % 2 === 0) {
        const k = Math.floor(u * 12) + Math.floor(v * 8) * 7;
        return [80 + 150 * hash(k, 1), 80 + 150 * hash(k, 2), 80 + 150 * hash(k, 3)];
      }
      return [110 - 30 * v, 95 - 30 * v, 85 - 30 * v];
    }
    case 'dark':
    default: {
      const t = 0.5 + 0.5 * Math.sin(u * 7 + v * 3);
      return [40 + 30 * t, 36 + 25 * t, 34 + 20 * t];
    }
  }
}

export function renderScene({ W = 1280, H = 720, quad, bg = 'dark', hands = true, seed = 1, noise = 3, landscape = false }) {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(W * H * 4);
  const inv = quad ? invert3(squareToQuad(quad)) : null;
  // Hands: a palm behind each side edge, a thumb in front of it.
  const handsList = [];
  if (quad && hands) {
    for (const [a, b] of [[0, 3], [1, 2]]) {
      const t = 0.35 + 0.3 * rand();
      const mx = quad[a].x + (quad[b].x - quad[a].x) * t;
      const my = quad[a].y + (quad[b].y - quad[a].y) * t;
      const out = a === 0 ? -1 : 1;
      handsList.push({ cx: mx + out * 0.045 * W, cy: my, rx: 0.06 * W, ry: 0.1 * H, front: false });
      handsList.push({ cx: mx - out * 0.004 * W, cy: my - 0.02 * H, rx: 0.014 * W, ry: 0.035 * H, front: true });
    }
  }
  const inHand = (x, y, front) =>
    handsList.some((h) => h.front === front && ((x - h.cx) / h.rx) ** 2 + ((y - h.cy) / h.ry) ** 2 < 1);

  const sub = [0.25, 0.75];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const sy of sub) {
        for (const sx of sub) {
          const X = x + sx;
          const Y = y + sy;
          let c;
          if (inHand(X, Y, true)) c = SKIN;
          else {
            let onPage = false;
            if (inv) {
              const w = inv[6] * X + inv[7] * Y + inv[8];
              const u = (inv[0] * X + inv[1] * Y + inv[2]) / w;
              const v = (inv[3] * X + inv[4] * Y + inv[5]) / w;
              if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
                c = pageColor(u, v, landscape);
                onPage = true;
              }
            }
            if (!onPage) c = inHand(X, Y, false) ? SKIN : background(bg, X, Y, W, H);
          }
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (y * W + x) * 4;
      const n = () => (rand() - 0.5) * 2 * noise;
      data[i] = r / 4 + n();
      data[i + 1] = g / 4 + n();
      data[i + 2] = b / 4 + n();
      data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

// Random page quad: aspect, size, rotation and perspective tilt.
export function randomQuad(rand, W, H, { landscape = false, maxRot = 25 } = {}) {
  for (;;) {
    const aspect = rand() < 0.5 ? 1.294 : 1.414;
    const ph = H * (0.5 + 0.4 * rand());
    const pH = landscape ? ph * 0.8 : ph;
    const pw = landscape ? pH * aspect : ph / aspect;
    const cx = W / 2 + (rand() - 0.5) * 0.3 * W;
    const cy = H / 2 + (rand() - 0.5) * 0.15 * H;
    const rot = ((rand() - 0.5) * 2 * maxRot * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const pts = [
      [-pw / 2, -pH / 2],
      [pw / 2, -pH / 2],
      [pw / 2, pH / 2],
      [-pw / 2, pH / 2],
    ].map(([x, y]) => ({
      x: cx + x * cos - y * sin + (rand() - 0.5) * 0.08 * pw,
      y: cy + x * sin + y * cos + (rand() - 0.5) * 0.08 * pH,
    }));
    const m = 0.03;
    if (pts.every((p) => p.x > m * W && p.x < (1 - m) * W && p.y > m * H && p.y < (1 - m) * H)) {
      return pts;
    }
  }
}
