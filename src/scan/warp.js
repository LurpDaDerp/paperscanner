// Output page geometry, perspective correction and document enhancement.
import { dist } from './geometry.js';

const FORMATS = [
  { name: 'Letter', ratio: 11 / 8.5, pt: [612, 792] },
  { name: 'A4', ratio: 297 / 210, pt: [595.28, 841.89] },
  { name: 'Legal', ratio: 14 / 8.5, pt: [612, 1008] },
];
const SNAP_TOLERANCE = Math.log(1.06);

// Estimates the real width/height ratio of the rectangle imaged as quad, using
// the camera model from Zhang & He, "Whiteboard scanning and image
// enhancement" (2007). Falls back to a typical webcam focal length when the
// focal length cannot be recovered (near-frontal views).
export function estimateAspect(quad, imageWidth, imageHeight) {
  const u0 = imageWidth / 2;
  const v0 = imageHeight / 2;
  const [tl, tr, br, bl] = quad.map((p) => [p.x - u0, p.y - v0, 1]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // m1 = tl, m2 = tr, m3 = bl, m4 = br
  const c14 = cross(tl, br);
  const k2 = dot(c14, bl) / dot(cross(tr, br), bl);
  const k3 = dot(c14, tr) / dot(cross(bl, br), tr);
  const n2 = tr.map((v, i) => k2 * v - tl[i]);
  const n3 = bl.map((v, i) => k3 * v - tl[i]);

  let f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  const minF = 0.4 * imageWidth;
  const maxF = 3 * imageWidth;
  if (!Number.isFinite(f2) || f2 < minF * minF || f2 > maxF * maxF) f2 = (0.85 * imageWidth) ** 2;
  const ratio2 =
    (n2[0] ** 2 / f2 + n2[1] ** 2 / f2 + n2[2] ** 2) / (n3[0] ** 2 / f2 + n3[1] ** 2 / f2 + n3[2] ** 2);
  const ratio = Math.sqrt(ratio2);
  if (Number.isFinite(ratio) && ratio > 0.2 && ratio < 5) return ratio;
  // Degenerate input: average opposite side lengths.
  return (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / (dist(quad[0], quad[3]) + dist(quad[1], quad[2]));
}

// Decides the output pixel size and the PDF page size (in points) for a quad.
// Ratios close to Letter, A4 or Legal snap to that exact paper size.
export function pageGeometry(quad, imageWidth, imageHeight) {
  const aspect = estimateAspect(quad, imageWidth, imageHeight); // width / height
  const landscape = aspect > 1;
  let ratio = landscape ? aspect : 1 / aspect; // long / short
  let pt = [612, 612 * ratio]; // 8.5in wide by default
  let format = null;
  let bestErr = Infinity;
  for (const f of FORMATS) {
    const err = Math.abs(Math.log(ratio / f.ratio));
    if (err < SNAP_TOLERANCE && err < bestErr) {
      bestErr = err;
      format = f.name;
      ratio = f.ratio;
      pt = f.pt;
    }
  }
  const longestSide = Math.max(...quad.map((p, i) => dist(p, quad[(i + 1) % 4])));
  const long = Math.round(Math.min(2400, Math.max(1200, longestSide * 1.25)));
  const short = Math.round(long / ratio);
  return landscape
    ? { width: long, height: short, pageWidth: pt[1], pageHeight: pt[0], format }
    : { width: short, height: long, pageWidth: pt[0], pageHeight: pt[1], format };
}

// Normalizes white balance and contrast so the paper comes out white and the
// ink dark, without clipping colour content. Operates in place on RGBA data.
export function enhance(data) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const luma = new Uint32Array(256);
  const n = data.length / 4;
  const step = n > 2e6 ? 4 : 1; // subsample very large pages for the histogram
  let counted = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    hist[0][data[i]]++;
    hist[1][data[i + 1]]++;
    hist[2][data[i + 2]]++;
    luma[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++;
    counted++;
  }
  const percentile = (h, p) => {
    const target = counted * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += h[v];
      if (acc >= target) return v;
    }
    return 255;
  };
  const black = Math.min(60, percentile(luma, 0.01));
  const luts = hist.map((h) => {
    // The paper is the bright majority of the page; map it to near-white.
    const white = Math.max(black + 60, percentile(h, 0.95));
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = ((v - black) * 250) / (white - black);
    return lut;
  });
  for (let i = 0; i < data.length; i += 4) {
    data[i] = luts[0][data[i]];
    data[i + 1] = luts[1][data[i + 1]];
    data[i + 2] = luts[2][data[i + 2]];
  }
  return data;
}

// Perspective-corrects quad from an RGBA Mat into a width x height RGBA buffer.
// A small inset keeps background slivers out of the page border.
export function warpPage(cv, rgba, quad, width, height) {
  const inset = Math.max(1, Math.round(0.004 * Math.max(width, height)));
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x, p.y]));
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [
    -inset, -inset,
    width - 1 + inset, -inset,
    width - 1 + inset, height - 1 + inset,
    -inset, height - 1 + inset,
  ]);
  const M = cv.getPerspectiveTransform(src, dst);
  const out = new cv.Mat();
  try {
    cv.warpPerspective(rgba, out, M, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    return enhance(new Uint8ClampedArray(out.data));
  } finally {
    src.delete();
    dst.delete();
    M.delete();
    out.delete();
  }
}
