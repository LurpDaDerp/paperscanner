// Small 2D geometry helpers. A quad is always [tl, tr, br, bl] of {x, y}.

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

// Orders 4 points clockwise (in screen coordinates) starting at the top-left.
export function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  }
  return [0, 1, 2, 3].map((i) => ({ ...sorted[(start + i) % 4] }));
}

export function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// Interior angles in degrees.
export function quadAngles(q) {
  return q.map((p, i) => {
    const prev = q[(i + 3) % 4];
    const next = q[(i + 1) % 4];
    const ax = prev.x - p.x;
    const ay = prev.y - p.y;
    const bx = next.x - p.x;
    const by = next.y - p.y;
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  });
}

// Largest-area quadrilateral using vertices of a convex polygon (in order).
export function maxAreaQuad(poly) {
  const n = poly.length;
  if (n < 4) return null;
  if (n === 4) return poly.slice();
  let best = null;
  let bestArea = -1;
  for (let i = 0; i < n - 3; i++) {
    for (let j = i + 1; j < n - 2; j++) {
      for (let k = j + 1; k < n - 1; k++) {
        for (let l = k + 1; l < n; l++) {
          const quad = [poly[i], poly[j], poly[k], poly[l]];
          const area = polygonArea(quad);
          if (area > bestArea) {
            bestArea = area;
            best = quad;
          }
        }
      }
    }
  }
  return best;
}

// Weighted total-least-squares line fit. Returns {px, py, dx, dy} or null.
export function fitLine(points, weights) {
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < points.length; i++) {
    const w = weights ? weights[i] : 1;
    sw += w;
    mx += w * points[i].x;
    my += w * points[i].y;
  }
  if (sw <= 0) return null;
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < points.length; i++) {
    const w = weights ? weights[i] : 1;
    const dx = points[i].x - mx;
    const dy = points[i].y - my;
    sxx += w * dx * dx;
    sxy += w * dx * dy;
    syy += w * dy * dy;
  }
  // Principal eigenvector of the 2x2 covariance matrix.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: mx, py: my, dx: Math.cos(theta), dy: Math.sin(theta) };
}

export const lineDistance = (l, p) => Math.abs((p.x - l.px) * l.dy - (p.y - l.py) * l.dx);

// Fits a line, then repeatedly drops outliers and refits.
export function robustFitLine(points, weights, minInliers) {
  let pts = points;
  let ws = weights;
  let line = fitLine(pts, ws);
  for (let iter = 0; iter < 4 && line; iter++) {
    const res = pts.map((p) => lineDistance(line, p));
    const sorted = [...res].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const limit = Math.max(1, 2.5 * median);
    const keep = [];
    for (let i = 0; i < pts.length; i++) if (res[i] <= limit) keep.push(i);
    if (keep.length === pts.length) break;
    if (keep.length < minInliers) return null;
    pts = keep.map((i) => pts[i]);
    ws = ws ? keep.map((i) => ws[i]) : null;
    line = fitLine(pts, ws);
  }
  return pts.length >= minInliers ? line : null;
}

export function intersectLines(a, b) {
  const det = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(det) < 1e-6) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / det;
  return { x: a.px + t * a.dx, y: a.py + t * a.dy };
}

export const lineThrough = (a, b) => {
  const len = dist(a, b) || 1;
  return { px: a.x, py: a.y, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
};

export const scaleQuad = (q, s) => q.map((p) => ({ x: p.x * s, y: p.y * s }));

export const meanCornerDistance = (a, b) => a.reduce((s, p, i) => s + dist(p, b[i]), 0) / 4;

export const maxCornerDistance = (a, b) => Math.max(...a.map((p, i) => dist(p, b[i])));

// Cyclically shifts q so its corners line up best with ref (orderCorners can
// pick a different starting corner for pages rotated ~45 degrees).
export function alignQuad(ref, q) {
  let best = q;
  let bestD = Infinity;
  for (let s = 0; s < 4; s++) {
    const shifted = [0, 1, 2, 3].map((i) => q[(i + s) % 4]);
    const d = meanCornerDistance(ref, shifted);
    if (d < bestD) {
      bestD = d;
      best = shifted;
    }
  }
  return best;
}

export const quadDistance = (a, b) => meanCornerDistance(a, alignQuad(a, b));
