// Document edge detection. Environment-agnostic: works on any ImageData-like
// object ({ data, width, height }) so it runs in the browser and in Node tests.
import {
  dist,
  fitLine,
  intersectLines,
  lineDistance,
  isConvex,
  lineThrough,
  maxAreaQuad,
  orderCorners,
  polygonArea,
  quadAngles,
  robustFitLine,
} from './geometry.js';

export const MIN_AREA_FRAC = 0.03;
const MAX_AREA_FRAC = 0.97;
const MIN_SIDE_SUPPORT = 0.7;
const MIN_MEAN_SUPPORT = 0.82;

// Converts RGBA to luma and "whiteness" (min of R, G, B). White paper is
// bright in every channel, while skin and most backgrounds are not.
function toChannels({ data, width, height }) {
  const n = width * height;
  const gray = new Uint8Array(n);
  const white = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j];
    const g = data[j + 1];
    const b = data[j + 2];
    gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
    white[i] = r < g ? (r < b ? r : b) : g < b ? g : b;
  }
  return { gray, white };
}


// Bilinear interpolation of a point inside a quad at (u, v) in [0, 1]^2.
function quadPoint(q, u, v) {
  const top = { x: q[0].x + (q[1].x - q[0].x) * u, y: q[0].y + (q[1].y - q[0].y) * u };
  const bot = { x: q[3].x + (q[2].x - q[3].x) * u, y: q[3].y + (q[2].y - q[3].y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

function meanInside(channel, width, height, q) {
  let sum = 0;
  let count = 0;
  for (let i = 1; i < 12; i++) {
    for (let j = 1; j < 12; j++) {
      const p = quadPoint(q, i / 12, j / 12);
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      sum += channel[y * width + x];
      count++;
    }
  }
  return count ? sum / count : 0;
}

// Fraction of each side backed by a real page edge: an edge pixel nearby and
// a brightness step across the side with the same polarity as the rest of
// that side. Text lines crossed by a fake side fail the polarity test.
export function edgeSupport(frame, q, N = 48) {
  const { edges, gray, white, width, height } = frame;
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const at = (ch, x, y) => {
    const xx = Math.round(x);
    const yy = Math.round(y);
    return xx >= 0 && yy >= 0 && xx < width && yy < height ? ch[yy * width + xx] : -1;
  };
  const steps = new Float32Array(N);
  return q.map((a, i) => {
    const b = q[(i + 1) % 4];
    const len = dist(a, b) || 1;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    let balance = 0;
    for (let k = 0; k < N; k++) {
      const t = 0.03 + (0.94 * k) / (N - 1);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      steps[k] = 0;
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (let dx = -1; dx <= 1 && !hit; dx++) hit = at(edges, x + dx, y + dy) > 0;
      }
      if (!hit) continue;
      // Inside minus outside, in whichever channel shows the larger step.
      const gi = at(gray, x - 3 * nx, y - 3 * ny);
      const go = at(gray, x + 3 * nx, y + 3 * ny);
      const wi = at(white, x - 3 * nx, y - 3 * ny);
      const wo = at(white, x + 3 * nx, y + 3 * ny);
      if (gi < 0 || go < 0) continue;
      const d = Math.abs(wi - wo) > Math.abs(gi - go) ? wi - wo : gi - go;
      if (Math.abs(d) >= 8) {
        steps[k] = d;
        balance += Math.sign(d);
      }
    }
    const sign = balance >= 0 ? 1 : -1;
    let hits = 0;
    for (let k = 0; k < N; k++) if (steps[k] * sign >= 8) hits++;
    return hits / N;
  });
}

// True when the page's own brightness continues past any side, i.e. that side
// is not the page boundary (e.g. a text line on a page cut off by the frame).
export function paperBeyondSides(frame, q) {
  const { white, width, height } = frame;
  const inside = [];
  for (let i = 1; i < 12; i++) {
    for (let j = 1; j < 12; j++) {
      const p = quadPoint(q, i / 12, j / 12);
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (x >= 0 && y >= 0 && x < width && y < height) inside.push(white[y * width + x]);
    }
  }
  inside.sort((a, b) => a - b);
  const paper = inside[Math.floor(inside.length * 0.8)] - 12;
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const N = 24;
  return q.some((a, i) => {
    const b = q[(i + 1) % 4];
    const len = dist(a, b) || 1;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    let count = 0;
    let valid = 0;
    for (let k = 0; k < N; k++) {
      const t = 0.1 + (0.8 * k) / (N - 1);
      let best = -1;
      for (let off = 4; off <= 16; off += 2) {
        const x = Math.round(a.x + (b.x - a.x) * t + nx * off);
        const y = Math.round(a.y + (b.y - a.y) * t + ny * off);
        if (x >= 0 && y >= 0 && x < width && y < height) best = Math.max(best, white[y * width + x]);
      }
      if (best < 0) continue;
      valid++;
      if (best >= paper) count++;
    }
    return valid >= N / 2 && count >= 0.6 * valid;
  });
}

export function validateQuad(q, width, height, minAreaFrac = MIN_AREA_FRAC) {
  if (!q || q.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  if (!isConvex(q)) return false;
  const tol = 2;
  if (q.some((p) => p.x < -tol || p.y < -tol || p.x > width - 1 + tol || p.y > height - 1 + tol)) {
    return false;
  }
  const area = polygonArea(q) / (width * height);
  if (area < minAreaFrac || area > MAX_AREA_FRAC) return false;
  if (quadAngles(q).some((a) => a < 35 || a > 145)) return false;
  const sides = q.map((p, i) => dist(p, q[(i + 1) % 4]));
  if (Math.min(...sides) < 0.1 * Math.min(width, height)) return false;
  // Opposite sides should not differ wildly (extreme perspective = bad scan).
  if (Math.max(sides[0], sides[2]) / Math.min(sides[0], sides[2]) > 2.5) return false;
  if (Math.max(sides[1], sides[3]) / Math.min(sides[1], sides[3]) > 2.5) return false;
  const a = (sides[0] + sides[2]) / 2;
  const b = (sides[1] + sides[3]) / 2;
  if (Math.max(a, b) / Math.min(a, b) > 4) return false;
  // Reject quads with a side running along the frame border: the page is cut off.
  const m = 0.012 * Math.max(width, height) + 1;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const r = q[(i + 1) % 4];
    if (p.x < m && r.x < m) return false;
    if (p.y < m && r.y < m) return false;
    if (p.x > width - 1 - m && r.x > width - 1 - m) return false;
    if (p.y > height - 1 - m && r.y > height - 1 - m) return false;
  }
  return true;
}

// Snaps each side of a rough quad to the contour points along it, then
// intersects the fitted lines. Recovers corners hidden by fingers. Iterates
// with a shrinking tolerance so a badly truncated corner converges.
function fitSidesToContour(rough, pts) {
  let q = rough;
  for (const tolFrac of [0.05, 0.025, 0.015]) {
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const len = dist(a, b);
      const line = lineThrough(a, b);
      const tol = Math.max(2, tolFrac * len);
      const near = [];
      for (const p of pts) {
        const t = ((p.x - a.x) * line.dx + (p.y - a.y) * line.dy) / len;
        if (t < 0.05 || t > 0.95) continue;
        if (Math.abs((p.x - a.x) * line.dy - (p.y - a.y) * line.dx) <= tol) near.push(p);
      }
      const fitted = near.length >= 8 ? robustFitLine(near, null, Math.max(6, near.length * 0.3)) : null;
      lines.push(fitted || line);
    }
    const next = [];
    for (let i = 0; i < 4; i++) {
      const p = intersectLines(lines[(i + 3) % 4], lines[i]);
      if (!p || dist(p, rough[i]) > 0.15 * dist(rough[0], rough[2])) return q;
      next.push(p);
    }
    q = next;
  }
  return q;
}

function matToPoints(mat) {
  const d = mat.data32S;
  const pts = new Array(d.length / 2);
  for (let i = 0; i < d.length; i += 2) pts[i / 2] = { x: d[i], y: d[i + 1] };
  return pts;
}

export class Detector {
  constructor(cv) {
    this.cv = cv;
    this.last = null; // { gray, width, height } of the last processed frame
  }

  // Returns { quad, score } in the input's pixel coordinates, or null.
  detect(image, { minAreaFrac = MIN_AREA_FRAC, debug = null } = {}) {
    const cv = this.cv;
    const { width, height } = image;
    const { gray, white } = toChannels(image);
    const mats = [];
    const track = (m) => (mats.push(m), m);
    const candidates = [];
    let edgeMap;

    try {
      const grayMat = track(new cv.Mat(height, width, cv.CV_8UC1));
      grayMat.data.set(gray);
      const whiteMat = track(new cv.Mat(height, width, cv.CV_8UC1));
      whiteMat.data.set(white);
      const grayBlur = track(new cv.Mat());
      const whiteBlur = track(new cv.Mat());
      cv.GaussianBlur(grayMat, grayBlur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      cv.GaussianBlur(whiteMat, whiteBlur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      this.last = { gray: new Uint8Array(grayBlur.data), white: new Uint8Array(whiteBlur.data), width, height };

      const kernel3 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
      const kernel7 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7)));

      // Strategy 1: Canny edges on luma and on whiteness. The union of both
      // edge maps is kept to verify that candidate sides lie on real edges.
      const edges = track(new cv.Mat());
      const whiteEdges = track(new cv.Mat());
      cv.Canny(grayBlur, edges, 40, 100, 3, true);
      cv.Canny(whiteBlur, whiteEdges, 40, 100, 3, true);
      cv.bitwise_or(edges, whiteEdges, edges);

      // Strategy 2: straight line segments, combined into quads. Works even
      // when the page region touches other objects or is split by text.
      const segments = track(new cv.Mat());
      const minSide = Math.min(width, height);
      cv.HoughLinesP(edges, segments, 1, Math.PI / 180, 30, 0.1 * minSide, 6);

      cv.dilate(edges, edges, kernel3, new cv.Point(-1, -1), 1);
      edgeMap = new Uint8Array(edges.data);
      this.last.edges = edgeMap;
      this.#collect(edges, cv.RETR_LIST, minAreaFrac, candidates, track);
      this.#linesToQuads(segments.data32S, minAreaFrac, candidates);

      // Strategy 3: Otsu segmentation of whiteness (bright page vs. darker scene).
      const bin = track(new cv.Mat());
      cv.threshold(whiteBlur, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel7);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kernel7);
      this.#collect(bin, cv.RETR_EXTERNAL, minAreaFrac, candidates, track);
    } finally {
      for (const m of mats) m.delete();
    }

    const frame = this.last;
    let best = null;
    for (const c of candidates) {
      const q = c.quad;
      const reject = (reason) => debug && debug.push({ quad: q, reason });
      if (!validateQuad(q, width, height, minAreaFrac)) {
        reject('geometry');
        continue;
      }
      const quadArea = polygonArea(q);
      const support = edgeSupport(frame, q);
      const meanSupport = support.reduce((a, b) => a + b, 0) / 4;
      if (Math.min(...support) < MIN_SIDE_SUPPORT || meanSupport < MIN_MEAN_SUPPORT) {
        reject(`support ${support.map((v) => v.toFixed(2))}`);
        continue;
      }
      if (paperBeyondSides(frame, q)) {
        reject('paper continues beyond a side');
        continue;
      }
      if (debug) debug.push({ quad: q, reason: `ok ${support.map((v) => v.toFixed(2))}` });
      // Prefer large, well-supported, bright quads with content (text, marks)
      // near the centre of view: that is where people hold a page.
      const brightness = meanInside(white, width, height, q) / 255;
      const content = Math.min(1, meanInside(edgeMap, width, height, q) / 255 / 0.1);
      const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4 - width / 2;
      const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4 - height / 2;
      const centrality = (1 - Math.hypot(cx, cy) / Math.hypot(width, height)) ** 2;
      const score =
        (quadArea / (width * height)) *
        meanSupport *
        centrality *
        (0.75 + 0.25 * brightness) *
        (0.6 + 0.4 * content);
      if (!best || score > best.score) best = { quad: q, score };
    }
    if (best) {
      const refined = refineQuad(this.last.gray, width, height, best.quad, 4);
      if (validateQuad(refined, width, height, minAreaFrac)) best.quad = refined;
    }
    return best;
  }

  #collect(binary, mode, minAreaFrac, out, track) {
    const cv = this.cv;
    const { width, height } = this.last;
    const minArea = minAreaFrac * width * height * 0.6;
    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(binary, contours, hierarchy, mode, cv.CHAIN_APPROX_NONE);
    const count = contours.size();
    for (let i = 0; i < count; i++) {
      const cnt = contours.get(i);
      try {
        const area = cv.contourArea(cnt);
        if (area < minArea) continue;
        const quad = this.#contourToQuad(cnt, minArea);
        if (quad) out.push({ quad });
      } finally {
        cnt.delete();
      }
    }
  }

  // Groups segments into lines, then forms quads from two pairs of roughly
  // parallel lines.
  #linesToQuads(seg, minAreaFrac, out) {
    const { width, height } = this.last;
    const groups = [];
    for (let i = 0; i < seg.length; i += 4) {
      const a = { x: seg[i], y: seg[i + 1] };
      const b = { x: seg[i + 2], y: seg[i + 3] };
      let theta = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
      theta = ((theta % Math.PI) + Math.PI) % Math.PI;
      const rho = ((a.x + b.x) / 2) * Math.cos(theta) + ((a.y + b.y) / 2) * Math.sin(theta);
      const g = groups.find((g) => {
        let dt = Math.abs(g.theta - theta);
        dt = Math.min(dt, Math.PI - dt);
        const r = ((a.x + b.x) / 2) * Math.cos(g.theta) + ((a.y + b.y) / 2) * Math.sin(g.theta);
        return dt < 0.05 && Math.abs(r - g.rho) < 4;
      });
      if (g) g.pts.push(a, b);
      else groups.push({ theta, rho, pts: [a, b] });
    }
    // Rank by the extent each line covers (HoughLinesP returns many
    // overlapping segments, so summed segment length would favour text rows).
    for (const g of groups) {
      g.line = fitLine(g.pts);
      const proj = g.pts.map((p) => (p.x - g.line.px) * g.line.dx + (p.y - g.line.py) * g.line.dy);
      g.extent = Math.max(...proj) - Math.min(...proj);
    }
    groups.sort((g, h) => h.extent - g.extent);
    const lines = groups.slice(0, 30).map((g) => g.line);
    const dir = lines.map((l) => Math.atan2(l.dy, l.dx));
    const angleBetween = (i, j) => {
      let d = Math.abs(dir[i] - dir[j]) % Math.PI;
      return Math.min(d, Math.PI - d);
    };
    const minGap = 0.1 * Math.min(width, height);
    const pairs = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        if (angleBetween(i, j) > 0.45) continue;
        const mid = { x: lines[j].px, y: lines[j].py };
        if (lineDistance(lines[i], mid) < minGap) continue;
        pairs.push([i, j]);
      }
    }
    for (let p = 0; p < pairs.length; p++) {
      for (let r = p + 1; r < pairs.length; r++) {
        const [a, b] = pairs[p];
        const [c, d] = pairs[r];
        if (angleBetween(a, c) < 0.7 || angleBetween(b, d) < 0.7) continue;
        const corners = [
          intersectLines(lines[a], lines[c]),
          intersectLines(lines[c], lines[b]),
          intersectLines(lines[b], lines[d]),
          intersectLines(lines[d], lines[a]),
        ];
        if (corners.some((pt) => !pt)) continue;
        const quad = orderCorners(corners);
        if (!validateQuad(quad, width, height, minAreaFrac)) continue;
        if (this.#supported(quad, 24)) out.push({ quad });
      }
    }
  }

  #supported(q, samples) {
    const s = edgeSupport(this.last, q, samples);
    const mean = (s[0] + s[1] + s[2] + s[3]) / 4;
    return Math.min(...s) >= MIN_SIDE_SUPPORT && mean >= MIN_MEAN_SUPPORT ? mean : 0;
  }

  // Converts a contour to a page quad. The convex hull handles thumbs over the
  // page; when the page contour has merged with something else (a face, an
  // arm), falls back to the 4 polygon vertices best supported by edges.
  #contourToQuad(cnt, minArea) {
    const cv = this.cv;
    const hull = new cv.Mat();
    const approx = new cv.Mat();
    try {
      const pts = matToPoints(cnt);
      const hullQuad = this.#hullQuad(cnt, hull, approx, pts);
      if (hullQuad && this.#supported(hullQuad, 32)) return hullQuad;

      const peri = cv.arcLength(cnt, true);
      let eps = 0.01;
      cv.approxPolyDP(cnt, approx, eps * peri, true);
      while (approx.rows > 16 && eps < 0.05) {
        eps *= 1.4;
        cv.approxPolyDP(cnt, approx, eps * peri, true);
      }
      const poly = matToPoints(approx);
      if (poly.length < 4 || poly.length > 16) return hullQuad;
      let best = null;
      let bestScore = 0;
      const n = poly.length;
      for (let i = 0; i < n - 3; i++) {
        for (let j = i + 1; j < n - 2; j++) {
          for (let k = j + 1; k < n - 1; k++) {
            for (let l = k + 1; l < n; l++) {
              const quad = [poly[i], poly[j], poly[k], poly[l]];
              const area = polygonArea(quad);
              if (area < minArea || area <= bestScore || !isConvex(quad)) continue;
              const support = this.#supported(quad, 24);
              if (support && area * support > bestScore) {
                bestScore = area * support;
                best = quad;
              }
            }
          }
        }
      }
      return best ? orderCorners(fitSidesToContour(orderCorners(best), pts)) : hullQuad;
    } finally {
      hull.delete();
      approx.delete();
    }
  }

  #hullQuad(cnt, hull, approx, pts) {
    const cv = this.cv;
    cv.convexHull(cnt, hull, false, true);
    const peri = cv.arcLength(hull, true);
    let eps = 0.005;
    cv.approxPolyDP(hull, approx, eps * peri, true);
    while (approx.rows > 12 && eps < 0.05) {
      eps *= 1.5;
      cv.approxPolyDP(hull, approx, eps * peri, true);
    }
    if (approx.rows < 4) return null;
    const rough = maxAreaQuad(matToPoints(approx));
    return rough ? orderCorners(fitSidesToContour(orderCorners(rough), pts)) : null;
  }

  // Coarse, lighting-normalized thumbnail of the page under `quad` in the last
  // frame. Used to tell whether the page in view has changed.
  signature(quad) {
    const { gray, width, height } = this.last;
    const W = 12;
    const H = 16;
    const S = 6; // subsamples per cell side, averaged (low-pass)
    const sig = new Float32Array(W * H);
    let mean = 0;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        let sum = 0;
        for (let sj = 0; sj < S; sj++) {
          for (let si = 0; si < S; si++) {
            const p = quadPoint(quad, (i + (si + 0.5) / S) / W, (j + (sj + 0.5) / S) / H);
            const x = Math.min(width - 1, Math.max(0, Math.round(p.x)));
            const y = Math.min(height - 1, Math.max(0, Math.round(p.y)));
            sum += gray[y * width + x];
          }
        }
        const v = sum / (S * S);
        sig[j * W + i] = v;
        mean += v;
      }
    }
    mean /= sig.length;
    let sd = 0;
    for (const v of sig) sd += (v - mean) ** 2;
    sd = Math.sqrt(sd / sig.length) || 1;
    for (let k = 0; k < sig.length; k++) sig[k] = (sig[k] - mean) / sd;
    return sig;
  }
}

// Signature distance above which the page in view counts as a new page.
export const PAGE_CHANGE_DISTANCE = 0.25;

export function signatureDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function sampleBilinear(img, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = img[y0 * w + x0];
  const b = img[y0 * w + x1];
  const c = img[y1 * w + x0];
  const d = img[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// Sub-pixel edge refinement on a (blurred) grayscale image. For each side of
// the quad, searches along the outward normal for the outermost edge with the
// page's polarity (so headings or borders printed near the edge are skipped),
// fits a robust line through those points and intersects neighbouring lines.
export function refineQuad(gray, width, height, quad, radius) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const R = Math.ceil(radius);
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const len = dist(a, b);
    const base = lineThrough(a, b);
    let nx = -base.dy;
    let ny = base.dx;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const samples = Math.max(20, Math.min(160, Math.round(len / 5)));

    // Intensity profile along the outward normal, from inside (-R) to outside (+R).
    const profiles = [];
    const steps = [];
    for (let k = 0; k < samples; k++) {
      const t = 0.06 + (0.88 * k) / (samples - 1);
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const vals = new Float32Array(2 * R + 3);
      let ok = true;
      for (let s = -R - 1; s <= R + 1 && ok; s++) {
        const v = sampleBilinear(gray, width, height, px + nx * s, py + ny * s);
        ok = !Number.isNaN(v);
        vals[s + R + 1] = v;
      }
      if (!ok) continue;
      const grad = new Float32Array(2 * R + 1);
      for (let s = 0; s < grad.length; s++) grad[s] = vals[s + 2] - vals[s];
      profiles.push({ px, py, grad });
      steps.push(vals[vals.length - 1] - vals[0]);
    }
    if (profiles.length < 8) {
      lines.push(null);
      continue;
    }
    // Page polarity: is the outside darker or brighter than the page?
    steps.sort((p, q) => p - q);
    const sign = steps[Math.floor(steps.length / 2)] >= 0 ? 1 : -1;

    const pts = [];
    const weights = [];
    for (const { px, py, grad } of profiles) {
      let bestS = -1;
      for (let s = grad.length - 2; s >= 1; s--) {
        const g = sign * grad[s];
        if (g >= 8 && g >= sign * grad[s - 1] && g >= sign * grad[s + 1]) {
          bestS = s;
          break;
        }
      }
      if (bestS < 0) continue;
      const g0 = grad[bestS - 1];
      const g1 = grad[bestS];
      const g2 = grad[bestS + 1];
      const denom = g0 - 2 * g1 + g2;
      const sub = Math.abs(denom) > 1e-6 ? Math.max(-0.5, Math.min(0.5, (0.5 * (g0 - g2)) / denom)) : 0;
      const off = bestS - R + sub;
      pts.push({ x: px + nx * off, y: py + ny * off });
      weights.push(sign * g1);
    }
    const minInliers = Math.max(8, 0.3 * samples);
    lines.push(pts.length >= minInliers ? robustFitLine(pts, weights, minInliers) : null);
  }

  const out = [];
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4] || lineThrough(quad[(i + 3) % 4], quad[i]);
    const l2 = lines[i] || lineThrough(quad[i], quad[(i + 1) % 4]);
    const p = intersectLines(l1, l2);
    if (!p || dist(p, quad[i]) > 2.5 * radius) return quad;
    out.push(p);
  }
  return isConvex(out) ? out : quad;
}
