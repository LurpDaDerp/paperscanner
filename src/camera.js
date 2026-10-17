// Webcam access with readable errors.

const STORAGE_KEY = 'paperscanner.camera';

export class CameraError extends Error {
  constructor(message, { retry = true } = {}) {
    super(message);
    this.retry = retry;
  }
}

function explain(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError(
        'Camera access is blocked. Allow camera access for this site in your browser settings, then try again.',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('No camera was found. Connect a webcam and try again.');
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError('The camera is in use by another app. Close it and try again.');
    default:
      return new CameraError(`Couldn't start the camera${err?.message ? `: ${err.message}` : '.'}`);
  }
}

const savedDevice = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.onEnded = null;
  }

  get active() {
    return !!this.stream;
  }

  async start(deviceId = savedDevice()) {
    this.stop();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('Camera access needs a secure (https) connection and a modern browser.', {
        retry: false,
      });
    }
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const attempts = [
      deviceId ? { ...size, deviceId: { exact: deviceId } } : null,
      { ...size, facingMode: { ideal: 'environment' } },
      true,
    ].filter(Boolean);
    let lastError;
    for (const video of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        break;
      } catch (err) {
        lastError = err;
        // Permission problems will not be fixed by other constraints.
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') break;
      }
    }
    if (!this.stream) throw explain(lastError);

    const track = this.stream.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      if (this.stream?.getVideoTracks()[0] === track) {
        this.stop();
        this.onEnded?.();
      }
    });
    try {
      localStorage.setItem(STORAGE_KEY, track.getSettings().deviceId || '');
    } catch {
      // Storage unavailable; the camera choice just won't be remembered.
    }
    this.video.srcObject = this.stream;
    await this.#playing();
  }

  async #playing() {
    const v = this.video;
    if (v.readyState < 2) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new CameraError('The camera did not send any video.')), 10000);
        v.addEventListener(
          'loadeddata',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    await v.play().catch(() => {});
  }

  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  get deviceId() {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId || null;
  }

  async devices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  // Switches to the next camera, if there is more than one.
  async next() {
    const list = await this.devices();
    if (list.length < 2) return;
    const i = list.findIndex((d) => d.deviceId === this.deviceId);
    await this.start(list[(i + 1) % list.length].deviceId);
  }
}
