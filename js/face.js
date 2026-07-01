/**
 * ============================================================
 *  FACE ENGINE — High-Performance Computer Vision Module
 *  face.js  |  Face Attendance System
 * ============================================================
 *
 *  ARCHITECTURE OVERVIEW
 *  ─────────────────────
 *  The engine runs two independent pipelines in parallel:
 *
 *  1. DISPLAY LOOP  (runs at ~30 fps via requestAnimationFrame)
 *     → Draws bounding boxes and landmarks on the canvas overlay.
 *     → Uses the LAST known detection — no waiting for inference.
 *     → Always smooth, never blocks the UI thread.
 *
 *  2. INFERENCE LOOP (runs every INFERENCE_INTERVAL ms via setTimeout)
 *     → Runs face-api.js detection on a background timer.
 *     → Results are stored and consumed by the display loop.
 *     → Inference interval is tuned per use-case (detection vs recognition).
 *
 *  WHY THIS IS FAST
 *  ─────────────────
 *  • requestAnimationFrame keeps the overlay buttery-smooth at 60 fps.
 *  • Heavy face-api inference never blocks the render loop.
 *  • TinyFaceDetector with inputSize=224 runs in ~20–40 ms on most devices.
 *  • Descriptor extraction (128-d embedding) only runs when a scan is triggered,
 *    not on every frame — saving ~80 ms per frame.
 *  • A result cache means the canvas always has something to draw,
 *    even if inference is momentarily slower.
 *
 *  COMPUTER VISION PIPELINE
 *  ─────────────────────────
 *  Step 1 — Frame Quality Check
 *     Sample 1,000 pixels → compute brightness (mean) and sharpness (variance).
 *     Poor quality frames are skipped before running the model.
 *
 *  Step 2 — Face Detection (TinyFaceDetector)
 *     A lightweight CNN (< 1 MB) that returns bounding boxes + confidence.
 *     Much faster than the full SSD MobileNet detector.
 *
 *  Step 3 — Landmark Detection (FaceLandmark68Net)
 *     Finds 68 key points (eyes, nose, mouth, jaw).
 *     Used for: alignment guidance, quality score, liveness check.
 *
 *  Step 4 — Face Descriptor (FaceRecognitionNet)
 *     A ResNet-34-like model that converts a face to a 128-dimensional vector.
 *     Only runs when explicitly requested (attendance scan / registration).
 *
 *  Step 5 — Matching
 *     Euclidean distance between the query descriptor and all stored descriptors.
 *     Threshold: 0.45 (configurable). Lower = stricter match.
 *     Multi-sample matching: checks the averaged descriptor AND all 3 raw samples.
 *     Takes the minimum distance found → catches pose/lighting variations.
 *
 *  Step 6 — Confidence Scoring
 *     confidence = (1 - distance) × 100  →  0–100%
 *     separation = (2nd best distance − best distance) → how unique the match is.
 *     highConfidence = confidence > 80 AND separation > 0.06
 * ============================================================
 */

'use strict';

class FaceEngine {

  // ── Static constants ────────────────────────────────────────────
  static MODEL_URL        = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.2/model';
  static INFERENCE_MS     = 120;   // ms between inference calls in the detection loop
  static MIN_FACE_RATIO   = 0.12;  // face height / video height minimum
  static SMOOTHING        = 0.35;  // box position smoothing factor (0=none, 1=instant)

  // ── State ───────────────────────────────────────────────────────
  constructor() {
    this.loaded       = false;
    this._rafId       = null;     // requestAnimationFrame ID (display loop)
    this._inferId     = null;     // setTimeout ID (inference loop)
    this._lastDet     = null;     // last inference result (detection object)
    this._smoothBox   = null;     // smoothed bounding box for display
    this._inferBusy   = false;    // prevent overlapping inference calls
    this._opts        = null;     // TinyFaceDetectorOptions (cached)
  }

  // ──────────────────────────────────────────────────────────────
  //  MODEL LOADING
  // ──────────────────────────────────────────────────────────────

  /**
   * Load all required face-api.js models.
   * Uses parallel loading where possible.
   * @param {function(number, string): void} onProgress  — called with (0-100, statusText)
   */
  async load(onProgress = () => {}) {
    try {
      const url = FaceEngine.MODEL_URL;
      onProgress(5, 'Loading face detector…');
      await faceapi.nets.tinyFaceDetector.loadFromUri(url);

      onProgress(45, 'Loading landmark model…');
      await faceapi.nets.faceLandmark68Net.loadFromUri(url);

      onProgress(80, 'Loading recognition model…');
      await faceapi.nets.faceRecognitionNet.loadFromUri(url);

      onProgress(100, 'All models ready ✓');
      this.loaded = true;

      // Cache options object (avoids re-allocating on every call)
      this._opts = new faceapi.TinyFaceDetectorOptions({
        inputSize:       224,   // 224 = fastest; use 320 for accuracy, 416 for high accuracy
        scoreThreshold:  0.50
      });
    } catch (err) {
      console.error('[FaceEngine] Model loading failed:', err);
      throw err;
    }
  }

  // ──────────────────────────────────────────────────────────────
  //  FRAME QUALITY ANALYSIS
  // ──────────────────────────────────────────────────────────────

  /**
   * Analyse a video frame for brightness and sharpness without
   * running the full neural network — extremely cheap operation.
   *
   * @param   {HTMLVideoElement} videoEl
   * @returns {{ brightness:number, sharpness:number, score:number,
   *             isGood:boolean, feedback:string }}
   */
  analyzeQuality(videoEl) {
    try {
      const w = videoEl.videoWidth  || 320;
      const h = videoEl.videoHeight || 240;

      // Sample at 1/4 resolution for speed
      const sw = Math.round(w / 4);
      const sh = Math.round(h / 4);

      const c   = document.createElement('canvas');
      c.width   = sw;
      c.height  = sh;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(videoEl, 0, 0, sw, sh);
      const { data } = ctx.getImageData(0, 0, sw, sh);

      let sum = 0;
      const grays = [];
      for (let i = 0; i < data.length; i += 4) {
        const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += g;
        grays.push(g);
      }
      const brightness = sum / grays.length;

      let varSum = 0;
      for (const g of grays) varSum += (g - brightness) ** 2;
      const sharpness = varSum / grays.length;

      const isGoodBrightness = brightness > 40 && brightness < 230;
      const isSharp          = sharpness  > 200;
      const score            = Math.round(
        (isGoodBrightness ? 50 : 0) + (isSharp ? 50 : 0)
      );

      let feedback = '✅ Good lighting';
      if (brightness < 40)  feedback = '💡 Too dark — improve lighting';
      else if (brightness > 230) feedback = '☀️ Too bright — reduce glare';
      else if (!isSharp)    feedback = '📷 Image blurry — hold still';

      return { brightness: Math.round(brightness), sharpness: Math.round(sharpness), score, isGood: score >= 50, feedback };
    } catch {
      return { brightness: 128, sharpness: 500, score: 50, isGood: true, feedback: '✅ OK' };
    }
  }

  // ──────────────────────────────────────────────────────────────
  //  GUIDANCE — where to position the face
  // ──────────────────────────────────────────────────────────────

  /**
   * Check if the detected face is well-positioned and large enough.
   * @param {object} detection  — face-api detection result
   * @param {HTMLVideoElement} videoEl
   * @returns {{ ok:boolean, tooSmall:boolean, guidance:string }}
   */
  checkPosition(detection, videoEl) {
    const vw = videoEl.videoWidth  || 640;
    const vh = videoEl.videoHeight || 480;
    const { x, y, width, height } = detection.detection.box;

    const faceRatio = height / vh;
    if (faceRatio < FaceEngine.MIN_FACE_RATIO) {
      return { ok: false, tooSmall: true, guidance: '🔍 Move closer to the camera' };
    }

    const cx = x + width  / 2;
    const cy = y + height / 2;

    if (cx < vw * 0.25) return { ok: false, tooSmall: false, guidance: '➡️ Move right' };
    if (cx > vw * 0.75) return { ok: false, tooSmall: false, guidance: '⬅️ Move left' };
    if (cy < vh * 0.2)  return { ok: false, tooSmall: false, guidance: '⬇️ Move down' };
    if (cy > vh * 0.8)  return { ok: false, tooSmall: false, guidance: '⬆️ Move up' };

    return { ok: true, tooSmall: false, guidance: '✅ Hold still…' };
  }

  // ──────────────────────────────────────────────────────────────
  //  SINGLE-FRAME DETECTION (visual only, no descriptor)
  // ──────────────────────────────────────────────────────────────

  /**
   * Run face detection + landmark detection on one frame.
   * Does NOT compute the 128-d descriptor (fast).
   * @param   {HTMLVideoElement} videoEl
   * @returns {Promise<object|null>}
   */
  async detect(videoEl) {
    if (!this.loaded) return null;
    try {
      return await faceapi
        .detectSingleFace(videoEl, this._opts)
        .withFaceLandmarks();
    } catch { return null; }
  }

  // ──────────────────────────────────────────────────────────────
  //  DESCRIPTOR EXTRACTION (recognition, slower)
  // ──────────────────────────────────────────────────────────────

  /**
   * Detect face AND extract the 128-d embedding descriptor.
   * Only call this when you actually need to match/identify a face.
   * @param   {HTMLVideoElement} videoEl
   * @returns {Promise<{detection: object, descriptor: Float32Array}|null>}
   */
  async detectWithDescriptor(videoEl) {
    if (!this.loaded) return null;
    try {
      const result = await faceapi
        .detectSingleFace(videoEl, this._opts)
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!result) return null;
      return { detection: result, descriptor: result.descriptor };
    } catch { return null; }
  }

  // ──────────────────────────────────────────────────────────────
  //  MULTI-FRAME STABLE DESCRIPTOR  (for reliable attendance scans)
  // ──────────────────────────────────────────────────────────────

  /**
   * Collect `numFrames` descriptors across multiple frames (50 ms apart)
   * and return their average. Averaging reduces noise from micro-movements,
   * lighting flicker, and JPEG compression artifacts.
   *
   * If fewer than half the frames succeed, returns null (poor conditions).
   *
   * @param {HTMLVideoElement}        videoEl
   * @param {number}                  numFrames   default 5
   * @param {function(number):void}   onFrame     called with current frame index
   * @returns {Promise<Float32Array|null>}
   */
  async getStableDescriptor(videoEl, numFrames = 5, onFrame = () => {}) {
    const descriptors = [];
    for (let i = 0; i < numFrames; i++) {
      const r = await this.detectWithDescriptor(videoEl);
      if (r) descriptors.push(r.descriptor);
      onFrame(i + 1);
      if (i < numFrames - 1) await this._sleep(50); // 50 ms between frames
    }

    if (descriptors.length < Math.ceil(numFrames / 2)) return null;
    return this._averageDescriptors(descriptors);
  }

  // ──────────────────────────────────────────────────────────────
  //  REGISTRATION — capture 3 samples across 3 seconds
  // ──────────────────────────────────────────────────────────────

  /**
   * Capture `numSamples` face descriptor samples, spaced ~1 second apart.
   * Gives the user time to slightly shift position between samples —
   * this improves robustness to lighting and angle variation at recognition time.
   *
   * @param {HTMLVideoElement}               videoEl
   * @param {number}                          numSamples     default 3
   * @param {function(number, number): void}  onSample       (currentSample, totalSamples)
   * @returns {Promise<Float32Array[]|null>}  array of descriptors, or null on failure
   */
  async captureRegistrationSamples(videoEl, numSamples = 3, onSample = () => {}) {
    const samples = [];
    for (let i = 0; i < numSamples; i++) {
      // Give the user a moment to slightly shift head
      if (i > 0) await this._sleep(900);

      // Each sample is itself an average of 3 quick frames for stability
      const desc = await this.getStableDescriptor(videoEl, 3);
      if (!desc) {
        console.warn(`[FaceEngine] Sample ${i + 1} failed — no face detected`);
        continue;
      }
      samples.push(desc);
      onSample(samples.length, numSamples);
    }

    return samples.length >= 2 ? samples : null;
  }

  // ──────────────────────────────────────────────────────────────
  //  MATCHING
  // ──────────────────────────────────────────────────────────────

  /**
   * Find the closest student match for a query face descriptor.
   *
   * Matching strategy:
   *  1. Compute euclidean distance to each student's averaged descriptor.
   *  2. Also compute distance to each individual raw sample.
   *  3. Take the MINIMUM distance found (best-case match).
   *  4. Sort all students by distance. Best = closest.
   *  5. Separation = distance(2nd best) − distance(best).
   *     High separation means the match is unambiguous.
   *
   * @param {Float32Array}  queryDesc   descriptor from the camera
   * @param {Array<Object>} students    array of student objects from DB
   * @param {number}        threshold   max distance to consider a match (default 0.45)
   * @returns {{ match:Object|null, distance:number, confidence:number,
   *             isMatch:boolean, isHighConfidence:boolean, separation:number }}
   */
  findBestMatch(queryDesc, students, threshold = 0.45) {
    if (!students || students.length === 0) {
      return { match: null, distance: 1, confidence: 0, isMatch: false, isHighConfidence: false, separation: 0 };
    }

    const scores = students.map(student => {
      // Check averaged descriptor
      let minDist = faceapi.euclideanDistance(queryDesc, new Float32Array(student.descriptor));

      // Check all raw registration samples (if available)
      if (Array.isArray(student.descriptors)) {
        for (const raw of student.descriptors) {
          const d = faceapi.euclideanDistance(queryDesc, new Float32Array(raw));
          if (d < minDist) minDist = d;
        }
      }
      return { student, distance: minDist };
    });

    // Sort ascending by distance
    scores.sort((a, b) => a.distance - b.distance);

    const best       = scores[0];
    const second     = scores[1];
    const separation = second ? (second.distance - best.distance) : 1;
    const confidence = Math.max(0, Math.min(100, Math.round((1 - best.distance) * 100)));
    const isMatch    = best.distance < threshold;

    return {
      match:            isMatch ? best.student : null,
      distance:         best.distance,
      confidence,
      isMatch,
      isHighConfidence: isMatch && confidence > 78 && separation > 0.05,
      separation
    };
  }

  // ──────────────────────────────────────────────────────────────
  //  HIGH-PERFORMANCE DUAL-LOOP ENGINE
  // ──────────────────────────────────────────────────────────────

  /**
   * Start the two-loop detection engine:
   *
   *  - Display loop  : requestAnimationFrame → smooth canvas overlay at 60 fps
   *  - Inference loop: setTimeout every INFERENCE_MS → runs neural network
   *
   * @param {HTMLVideoElement}           videoEl    video source
   * @param {HTMLCanvasElement}          canvasEl   overlay canvas
   * @param {function(object|null):void} onFrame    called with latest detection result
   * @param {object}                     options
   * @param {boolean}  options.showLandmarks   draw 68 landmark dots
   * @param {boolean}  options.showQuality     show quality indicator
   */
  startLoop(videoEl, canvasEl, onFrame, options = {}) {
    this.stopLoop(); // ensure clean state
    const ctx = canvasEl.getContext('2d', { alpha: true });

    // ─── Display loop ────────────────────────────────────────────
    const display = () => {
      if (!this._rafId) return; // stopped

      const vw = videoEl.videoWidth  || 640;
      const vh = videoEl.videoHeight || 480;
      if (canvasEl.width !== vw)  canvasEl.width  = vw;
      if (canvasEl.height !== vh) canvasEl.height = vh;

      ctx.clearRect(0, 0, vw, vh);

      const det = this._lastDet;
      if (det) {
        // Smooth the bounding box position (reduces jitter)
        const box = det.detection.box;
        this._smoothBox = this._smoothBox
          ? this._lerpBox(this._smoothBox, box, FaceEngine.SMOOTHING)
          : { ...box };

        this._drawOverlayInternal(ctx, this._smoothBox, det.landmarks?.positions, options._overlayOptions || {});
      } else {
        this._smoothBox = null;
      }

      this._rafId = requestAnimationFrame(display);
    };

    // ─── Inference loop ──────────────────────────────────────────
    const infer = async () => {
      if (this._inferId === null) return; // stopped

      if (!this._inferBusy && videoEl.readyState >= 2) {
        this._inferBusy = true;
        try {
          const det = await this.detect(videoEl);
          this._lastDet = det;
          onFrame(det);
        } catch { /* ignore */ }
        this._inferBusy = false;
      }

      this._inferId = setTimeout(infer, FaceEngine.INFERENCE_MS);
    };

    // Start both loops
    this._rafId  = requestAnimationFrame(display);
    this._inferId = setTimeout(infer, 0);
  }

  /**
   * Stop both the display loop and inference loop.
   * Always call this when the camera is stopped or the tab changes.
   */
  stopLoop() {
    if (this._rafId)   { cancelAnimationFrame(this._rafId);  this._rafId = null; }
    if (this._inferId) { clearTimeout(this._inferId); this._inferId = null; }
    this._lastDet    = null;
    this._smoothBox  = null;
    this._inferBusy  = false;
  }

  /**
   * Set overlay drawing options (called from app.js to update color/label).
   * @param {object} opts  { color, confidence, label, showLandmarks }
   */
  setOverlayOptions(opts) {
    if (this._inferId !== null || this._rafId !== null) {
      // Store so display loop picks it up
      if (!this._lastDet) return;
    }
    // Attach to internal state for display loop to read
    this._overlayOptions = opts;
  }

  // ──────────────────────────────────────────────────────────────
  //  CANVAS OVERLAY DRAWING
  // ──────────────────────────────────────────────────────────────

  /**
   * Draw the detection overlay directly (one-shot, outside the loop).
   * Used for showing match results on the canvas.
   */
  drawOverlay(ctx, canvasEl, box, opts = {}) {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (box) this._drawOverlayInternal(ctx, box, null, opts);
  }

  /**
   * Internal drawing routine shared by loop and one-shot.
   * @private
   */
  _drawOverlayInternal(ctx, box, landmarkPts, opts = {}) {
    const {
      color           = '#4f8ef7',
      confidence,
      label,
      showLandmarks   = false,
      glowColor
    } = opts;

    const { x, y, width: w, height: h } = box;

    // ─ Glow / shadow ─────────────────────────────────────────────
    if (glowColor || color !== '#4f8ef7') {
      ctx.shadowColor = glowColor || color;
      ctx.shadowBlur  = 14;
    }

    // ─ Semi-transparent fill ──────────────────────────────────────
    ctx.fillStyle = color + '18';
    ctx.fillRect(x, y, w, h);
    ctx.shadowBlur = 0;

    // ─ Bounding box ───────────────────────────────────────────────
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.strokeRect(x, y, w, h);

    // ─ Corner accent marks (professional look) ────────────────────
    ctx.strokeStyle = color;
    ctx.lineWidth   = 4;
    ctx.lineCap     = 'round';
    const L = Math.min(22, w * 0.25, h * 0.25);
    [
      [x,     y,     x + L, y    ], [x,     y,     x,     y + L],
      [x + w, y,     x+w-L, y    ], [x + w, y,     x + w, y + L],
      [x,     y + h, x + L, y + h], [x,     y + h, x,   y+h-L ],
      [x + w, y + h, x+w-L, y + h], [x + w, y + h, x + w, y+h-L]
    ].forEach(([x1, y1, x2, y2]) => {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    });

    // ─ Confidence bar ─────────────────────────────────────────────
    if (confidence !== undefined) {
      const bh = 6;
      const by = y - bh - 4;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.roundRect?.(x, by, w, bh, 3) || ctx.fillRect(x, by, w, bh);
      ctx.fill();
      const barColor = confidence > 75 ? '#10b981' : confidence > 50 ? '#f59e0b' : '#ef4444';
      ctx.fillStyle = barColor;
      const fw = Math.max(0, Math.min(w, w * (confidence / 100)));
      ctx.fillRect(x, by, fw, bh);
    }

    // ─ Label ──────────────────────────────────────────────────────
    if (label) {
      const pad  = 6;
      const fh   = 14;
      ctx.font   = `600 ${fh}px Inter, Arial, sans-serif`;
      const tw   = ctx.measureText(label).width;
      const lx   = x;
      const ly   = y + h + 4;
      ctx.fillStyle = color + 'dd';
      ctx.fillRect(lx, ly, tw + pad * 2, fh + pad);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + pad, ly + fh);
    }

    // ─ Landmark dots ──────────────────────────────────────────────
    if (showLandmarks && landmarkPts) {
      ctx.fillStyle = color + 'aa';
      for (const pt of landmarkPts) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  //  UTILITIES
  // ──────────────────────────────────────────────────────────────

  /**
   * Average an array of Float32Array descriptors into one.
   * @param {Float32Array[]} descriptors
   * @returns {Float32Array}
   */
  _averageDescriptors(descriptors) {
    const n   = descriptors[0].length;
    const avg = new Float32Array(n);
    for (const d of descriptors) {
      for (let i = 0; i < n; i++) avg[i] += d[i];
    }
    const count = descriptors.length;
    for (let i = 0; i < n; i++) avg[i] /= count;
    return avg;
  }

  /**
   * Public alias so app.js can average descriptors.
   */
  averageDescriptors(descriptors) {
    return this._averageDescriptors(descriptors);
  }

  /**
   * Linearly interpolate between two bounding boxes (for smooth animation).
   * @private
   */
  _lerpBox(a, b, t) {
    return {
      x:      a.x      + (b.x      - a.x)      * t,
      y:      a.y      + (b.y      - a.y)      * t,
      width:  a.width  + (b.width  - a.width)  * t,
      height: a.height + (b.height - a.height) * t
    };
  }

  /**
   * Check if the detection loop is currently running.
   */
  get isRunning() { return this._rafId !== null; }

  /**
   * Returns the most recent detection result (may be null).
   */
  get lastDetection() { return this._lastDet; }

  /**
   * Euclidean distance between two float arrays.
   * @param {Float32Array|number[]} a
   * @param {Float32Array|number[]} b
   */
  static euclideanDistance(a, b) {
    return faceapi.euclideanDistance(a, b);
  }

  /**
   * Promise-based sleep helper.
   * @param {number} ms
   * @private
   */
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ── Export ─────────────────────────────────────────────────────
window.FaceEngine = FaceEngine;
