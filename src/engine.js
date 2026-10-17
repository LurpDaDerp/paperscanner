// Promise-based wrapper around the OpenCV worker.

export class Engine {
  constructor() {
    this.worker = new Worker(new URL('./scan/worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.ok) p.resolve(data.result);
      else p.reject(new Error(data.error));
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Scanner engine crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    const url = new URL('vendor/opencv.js', document.baseURI).href;
    this.ready = this.#call('init', { url });
    this.ready.catch(() => {});
  }

  #call(type, args = {}, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...args }, transfer);
    });
  }

  // `image` is an ImageData; its buffer is transferred (unusable afterwards).
  #imageCall(type, image, args) {
    const { width, height, data } = image;
    const buffer = data.buffer;
    return this.#call(type, { image: { width, height, buffer }, ...args }, [buffer]);
  }

  detect(image) {
    return this.#imageCall('detect', image);
  }

  locate(image, hint = null) {
    return this.#imageCall('locate', image, { hint });
  }

  // Returns { quad, geometry, pixels: ImageData } or { quad: null }.
  async process(image, { quad = null, detect = false } = {}) {
    const res = await this.#imageCall('process', image, { quad, detect });
    if (!res.quad) return res;
    const { width, height } = res.geometry;
    return { ...res, pixels: new ImageData(new Uint8ClampedArray(res.buffer), width, height) };
  }
}
