// src/panel.js
//
// Canvas2D renderer. The panel is a MOVABLE FILTER LENS, not a textured plane:
//
//   1. The webcam is drawn full-viewport with object-fit: cover (aspect
//      preserved), mirrored like a selfie — into a `base` canvas, then blitted
//      to the visible canvas.
//   2. A full-frame `filtered` canvas is built every frame by the active filter
//      (see filters.js) from `base`. Filters use canvas→canvas ops only, so the
//      effect is always visibly applied.
//   3. The panel quad clips the visible canvas; `filtered` is revealed through
//      it at 1:1 (NOT scaled into the quad), so the lens shows the same region
//      of the camera underneath it, but filtered.
//
// The active filter is cycled via nextFilter() (wired to a key in main.js).
// All screen mapping goes through one display transform (`toScreen`) so the
// webcam, panel corners, and debug landmarks stay spatially registered.

import { FILTERS } from "./filters.js";

// Temporary: draw the filtered canvas as a small top-left preview so we can
// confirm it actually differs from the raw webcam. Set false to hide.
const debugFilterTest = false;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLVideoElement} video
 * @returns {{ render, resize }}
 *   render(corners, opacity, timeMs, debug, landmarks):
 *     corners  { tl, tr, br, bl } in RAW normalized MediaPipe space [0..1]
 *     opacity  panel global alpha [0..1]
 *     debug    level 0 clean / 1 outline only / 2 outline + landmarks
 *     landmarks array of MediaPipe hands (raw normalized) or []
 */
export function createPanel(canvas, video) {
  const ctx = canvas.getContext("2d");

  // Offscreen layers.
  const base = document.createElement("canvas"); // mirrored sharp webcam
  const baseCtx = base.getContext("2d");
  const small = document.createElement("canvas"); // scratch for filters
  const smallCtx = small.getContext("2d");
  const filtered = document.createElement("canvas"); // active-filter full frame
  const filteredCtx = filtered.getContext("2d");
  const scratch = { canvas: small, ctx: smallCtx };

  let activeFilter = 0; // index into FILTERS

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round((canvas.clientWidth || window.innerWidth) * dpr);
    const h = Math.round((canvas.clientHeight || window.innerHeight) * dpr);
    for (const cv of [canvas, base, filtered]) {
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
      }
    }
  }
  resize();

  // Draw the (full) video into `c` at the cover rect, mirrored horizontally.
  function drawMirroredVideo(c, rect) {
    c.save();
    c.translate(c.canvas.width, 0);
    c.scale(-1, 1); // horizontal flip → selfie view
    c.drawImage(video, rect.dx, rect.dy, rect.dw, rect.dh);
    c.restore();
  }

  function render(corners, opacity, timeMs, debug, landmarks, feedback) {
    resize();
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return; // no frame yet

    // object-fit: cover — source is the full video; the destination rect
    // overflows the canvas on one axis so the frame fills it without stretch.
    const scale = Math.max(W / vw, H / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const rect = { dx: (W - dw) / 2, dy: (H - dh) / 2, dw, dh };

    // Map a RAW normalized point through the same displayed rect, mirrored.
    const toScreen = (p) => ({
      x: rect.dx + (1 - p.x) * rect.dw,
      y: rect.dy + p.y * rect.dh,
    });

    // 1. mirrored webcam → base, then blit base to the visible canvas.
    baseCtx.clearRect(0, 0, W, H);
    drawMirroredVideo(baseCtx, rect);
    ctx.drawImage(base, 0, 0);

    // 2. build the `filtered` frame from `base` with the active filter, and
    //    reveal it through the quad. We only build it when the lens is actually
    //    visible (or the debug preview is on): the ascii filter runs fine cells
    //    and is costly, and `filtered` is never seen outside the lens. The lens
    //    bounding box is passed as `region` so per-cell filters can skip work
    //    outside it (other filters ignore the arg and fill the whole frame).
    const showLens = opacity > 0.001 && corners;
    let c = null;
    if (showLens || debugFilterTest) {
      let region = null;
      if (showLens) {
        c = {
          tl: toScreen(corners.tl),
          tr: toScreen(corners.tr),
          br: toScreen(corners.br),
          bl: toScreen(corners.bl),
        };
        region = quadBBox(c, W, H);
      }
      FILTERS[activeFilter].apply(base, filteredCtx, W, H, scratch, region);
    }

    // 3. panel lens: clip to the quad, reveal the filtered layer at 1:1.
    if (showLens) {
      ctx.save();
      quadPath(ctx, c);
      ctx.clip();
      ctx.globalAlpha = opacity;
      ctx.drawImage(filtered, 0, 0); // 1:1, spatially registered — NOT scaled
      ctx.restore();

      // lens edge — shown at debug level ≥ 1 (outline only) and above
      if (debug >= 1) {
        ctx.save();
        ctx.globalAlpha = opacity * 0.8;
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = Math.max(1, W * 0.0015);
        quadPath(ctx, c);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 4. debug: preview the filtered canvas top-left to prove it differs.
    if (debugFilterTest) {
      const pw = Math.round(W * 0.22);
      const ph = Math.round((pw * H) / W);
      ctx.save();
      ctx.drawImage(filtered, 0, 0, W, H, 8, 8, pw, ph);
      ctx.strokeStyle = "#00ff88";
      ctx.lineWidth = 2;
      ctx.strokeRect(8, 8, pw, ph);
      ctx.restore();
    }

    // 5. active filter label
    ctx.save();
    const fs = Math.max(12, Math.round(H * 0.02));
    ctx.font = `${fs}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillText(`filter: ${FILTERS[activeFilter].name}  ·  press f / click / pinch`, 15, 13);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillText(`filter: ${FILTERS[activeFilter].name}  ·  press f / click / pinch`, 14, 12);
    ctx.restore();

    // 6. hand-tracker landmarks — debug level ≥ 2 only
    if (debug >= 2 && landmarks && landmarks.length) {
      drawDebug(ctx, landmarks, toScreen);
    }
  }

  function nextFilter() {
    activeFilter = (activeFilter + 1) % FILTERS.length;
    return FILTERS[activeFilter].name;
  }

  function prevFilter() {
    activeFilter = (activeFilter - 1 + FILTERS.length) % FILTERS.length;
    return FILTERS[activeFilter].name;
  }

  function getFilterName() {
    return FILTERS[activeFilter].name;
  }

  return { render, resize, nextFilter, prevFilter, getFilterName };
}

function quadPath(ctx, c) {
  ctx.beginPath();
  ctx.moveTo(c.tl.x, c.tl.y);
  ctx.lineTo(c.tr.x, c.tr.y);
  ctx.lineTo(c.br.x, c.br.y);
  ctx.lineTo(c.bl.x, c.bl.y);
  ctx.closePath();
}

// Axis-aligned bounding box of a screen-space quad, clamped to the canvas.
// Used to restrict per-cell filters to the region the lens actually reveals.
function quadBBox(c, W, H) {
  const xs = [c.tl.x, c.tr.x, c.br.x, c.bl.x];
  const ys = [c.tl.y, c.tr.y, c.br.y, c.bl.y];
  return {
    x0: Math.max(0, Math.min(...xs)),
    y0: Math.max(0, Math.min(...ys)),
    x1: Math.min(W, Math.max(...xs)),
    y1: Math.min(H, Math.max(...ys)),
  };
}

// Draws the active gesture mode label, anchored under the filter label.
// Canvas-only so it stays registered with the rest of the overlay.
function drawGestureFeedback(ctx, W, H, fs, fb) {
  const x = 14;
  const y = 12 + fs + 8;
  ctx.save();
  ctx.font = `${fs}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  const label = `gesture: ${fb.mode}`;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillText(label, x + 1, y + 1);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillText(label, x, y);

  // open-palm dwell ring, to the right of the label
  if (fb.dwell > 0) {
    const r = fs * 0.6;
    const cx = x + ctx.measureText(label).width + r + 12;
    const cy = y + fs * 0.5;
    ctx.lineWidth = Math.max(2, fs * 0.15);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,255,136,0.95)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + fb.dwell * Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// Compact subset of HAND_CONNECTIONS for the debug skeleton.
const SKELETON = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const INDEX_TIP = 8;
const THUMB_TIP = 4;

// Landmarks drawn through the SAME display transform, so they line up with the
// mirrored webcam and the panel corners.
function drawDebug(ctx, landmarks, toScreen) {
  for (const lm of landmarks) {
    const pts = lm.map(toScreen);

    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    for (const [a, b] of SKELETON) {
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
      ctx.stroke();
    }

    ctx.fillStyle = "white";
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#ff3b3b";
    for (const idx of [INDEX_TIP, THUMB_TIP]) {
      ctx.beginPath();
      ctx.arc(pts[idx].x, pts[idx].y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
