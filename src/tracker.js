// Temporal tracking of the detected page and the auto-capture decision.
// Coordinates are in detection-frame pixels; times in milliseconds.
import { PAGE_CHANGE_DISTANCE, signatureDistance } from './scan/detect.js';
import { alignQuad, maxCornerDistance, polygonArea, quadDistance } from './scan/geometry.js';

export const STABLE_MS = 900; // how long the page must be held still
const LOST_MS = 450; // detection gaps shorter than this are bridged
const MATCH = 0.06; // quads closer than this (x diagonal) are the same page
const STILL = 0.015; // allowed hand jitter (x diagonal) while holding still
const MOVED = 0.2; // a move this large (x diagonal) counts as a new page
export const AUTO_MIN_AREA = 0.06; // pages smaller than this (x frame) aren't auto-captured
const COOLDOWN_MS = 1200;

export class Tracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.quad = null; // smoothed quad shown to the user
    this.signature = null;
    this.pending = null; // unconfirmed new quad
    this.lastSeen = 0;
    this.anchor = null;
    this.stableSince = 0;
    this.size = null;
  }

  get diag() {
    return this.size ? Math.hypot(this.size.width, this.size.height) : 1;
  }

  get area() {
    return this.quad ? polygonArea(this.quad) / (this.size.width * this.size.height) : 0;
  }

  stableFor(now) {
    return this.quad ? now - this.stableSince : 0;
  }

  update({ quad, signature }, size, now) {
    if (this.size && (this.size.width !== size.width || this.size.height !== size.height)) this.reset();
    this.size = size;
    const diag = this.diag;

    if (quad && this.quad && quadDistance(this.quad, quad) < MATCH * diag) {
      const q = alignQuad(this.quad, quad);
      this.quad = this.quad.map((p, i) => ({ x: p.x + (q[i].x - p.x) * 0.6, y: p.y + (q[i].y - p.y) * 0.6 }));
      this.#steady(q, now);
      this.signature = signature;
      this.lastSeen = now;
      this.pending = null;
      return;
    }
    if (quad) {
      // A different quad must show up twice in a row before replacing the
      // current one; this filters one-frame false detections.
      if (this.pending && quadDistance(this.pending, quad) < MATCH * diag) {
        this.quad = quad;
        this.signature = signature;
        this.anchor = null;
        this.#steady(quad, now);
        this.lastSeen = now;
        this.pending = null;
        return;
      }
      this.pending = quad;
    } else {
      this.pending = null;
    }
    if (this.quad && now - this.lastSeen > LOST_MS) {
      this.quad = null;
      this.signature = null;
      this.anchor = null;
    }
  }

  #steady(q, now) {
    if (!this.anchor || maxCornerDistance(this.anchor, alignQuad(this.anchor, q)) > STILL * this.diag) {
      this.anchor = q;
      this.stableSince = now;
    }
  }
}

export class AutoCapture {
  constructor() {
    this.armed = true;
    this.armedAt = -Infinity;
    this.last = null;
    this.lastAt = -Infinity;
  }

  #arm(now) {
    this.armed = true;
    this.armedAt = now;
  }

  // Time the page has been held still since the capture was (re-)armed.
  #steadyFor(tracker, now) {
    return Math.min(tracker.stableFor(now), now - this.armedAt);
  }

  // Re-arms once the captured page is gone, moved a lot, or replaced.
  update(tracker, now) {
    if (this.armed || !this.last) return;
    if (!tracker.quad || quadDistance(this.last.quad, tracker.quad) > MOVED * tracker.diag) {
      this.#arm(now);
      return;
    }
    if (
      tracker.stableFor(now) > 300 &&
      this.last.signature &&
      tracker.signature &&
      signatureDistance(this.last.signature, tracker.signature) > PAGE_CHANGE_DISTANCE
    ) {
      this.#arm(now);
    }
  }

  ready(tracker, now) {
    return this.armed && tracker.quad && tracker.area >= AUTO_MIN_AREA && now - this.lastAt >= COOLDOWN_MS;
  }

  // 0..1 progress towards an automatic capture.
  progress(tracker, now) {
    if (!this.ready(tracker, now)) return 0;
    return Math.min(1, this.#steadyFor(tracker, now) / STABLE_MS);
  }

  shouldCapture(tracker, now) {
    return this.ready(tracker, now) && this.#steadyFor(tracker, now) >= STABLE_MS;
  }

  captured(tracker, now) {
    this.armed = false;
    this.last = tracker.quad ? { quad: tracker.quad, signature: tracker.signature } : null;
    if (!this.last) this.#arm(now);
    this.lastAt = now;
  }
}
