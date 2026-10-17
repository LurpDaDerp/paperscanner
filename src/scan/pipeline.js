// High-accuracy page location on a full-resolution frame: coarse detection on
// a downscaled copy, then sub-pixel edge refinement at (near) full resolution.
import { refineQuad } from './detect.js';
import { quadDistance } from './geometry.js';

export const DETECT_SIZE = 640; // longest side used for detection
const REFINE_SIZE = 2000; // longest side used for edge refinement

// Converts pixel-centre coordinates between image scales.
export const rescale = (q, s) => q.map((p) => ({ x: (p.x + 0.5) * s - 0.5, y: (p.y + 0.5) * s - 0.5 }));

function resized(cv, src, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(src.cols, src.rows));
  if (scale === 1) return { mat: src.clone(), scale };
  const mat = new cv.Mat();
  const size = new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale));
  cv.resize(src, mat, size, 0, 0, cv.INTER_AREA);
  return { mat, scale: mat.cols / src.cols };
}

// Refines a quad (in full-image coordinates) against the image edges.
export function refineOnImage(cv, rgba, quad) {
  const { mat: small, scale } = resized(cv, rgba, REFINE_SIZE);
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  try {
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    const w = blur.cols;
    const h = blur.rows;
    const diag = Math.hypot(w, h);
    let q = rescale(quad, scale);
    q = refineQuad(blur.data, w, h, q, Math.max(6, 0.006 * diag));
    q = refineQuad(blur.data, w, h, q, 3);
    return rescale(q, 1 / scale);
  } finally {
    small.delete();
    gray.delete();
    blur.delete();
  }
}

// Finds the page in a full-resolution RGBA Mat. `hint` (full-image coords) is
// the live tracker's quad; it is used when detection on this exact frame fails
// or disagrees badly. Returns a quad in full-image coordinates, or null.
export function locatePage(cv, detector, rgba, hint = null) {
  const { mat: small, scale } = resized(cv, rgba, DETECT_SIZE);
  let found;
  try {
    found = detector.detect({ data: small.data, width: small.cols, height: small.rows });
  } finally {
    small.delete();
  }
  let quad = found ? rescale(found.quad, 1 / scale) : null;
  if (hint) {
    const diag = Math.hypot(rgba.cols, rgba.rows);
    if (!quad || quadDistance(hint, quad) > 0.08 * diag) quad = hint;
  }
  return quad ? refineOnImage(cv, rgba, quad) : null;
}
