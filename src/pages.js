// Image helpers for scanned pages (blobs, thumbnails, rotation).

const THUMB_SIZE = 480;
let nextId = 1;

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}

function canvasOf(width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

// Draws `source` rotated clockwise by `rotation` degrees, scaled to fit `maxSide`.
function rotatedCanvas(source, rotation, maxSide = Infinity) {
  const sw = source.width;
  const sh = source.height;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const quarter = rotation % 180 !== 0;
  const c = canvasOf(quarter ? h : w, quarter ? w : h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  return c;
}

async function thumbnailUrl(source, rotation) {
  return URL.createObjectURL(await canvasToBlob(rotatedCanvas(source, rotation, THUMB_SIZE), 'image/jpeg', 0.85));
}

// Builds page data from the worker's output.
export async function createPage({ geometry, pixels }) {
  const canvas = canvasOf(pixels.width, pixels.height);
  canvas.getContext('2d').putImageData(pixels, 0, 0);
  const image = await canvasToBlob(canvas, 'image/jpeg', 0.9);
  const thumb = await thumbnailUrl(canvas, 0);
  return { id: nextId++, rotation: 0, geometry, image, thumb };
}

export async function rotatePage(page) {
  page.rotation = (page.rotation + 90) % 360;
  const bitmap = await createImageBitmap(page.image);
  try {
    const thumb = await thumbnailUrl(bitmap, page.rotation);
    URL.revokeObjectURL(page.thumb);
    page.thumb = thumb;
  } finally {
    bitmap.close();
  }
}

export function disposePage(page) {
  URL.revokeObjectURL(page.thumb);
}

// Full-resolution JPEG of the page with its rotation applied.
export async function pageJpeg(page) {
  if (!page.rotation) return page.image;
  const bitmap = await createImageBitmap(page.image);
  try {
    return await canvasToBlob(rotatedCanvas(bitmap, page.rotation), 'image/jpeg', 0.9);
  } finally {
    bitmap.close();
  }
}
