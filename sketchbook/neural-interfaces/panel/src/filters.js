// src/filters.js
//
// Filter registry for the panel lens. Each filter reads the full-frame `base`
// canvas (mirrored, cover-fit webcam) and writes a full-frame, spatially
// aligned result into `dst` (a 2D context sized W×H). Filters use canvas→canvas
// operations ONLY — never ctx.filter/CSS filter, which silently no-op in some
// browsers. `scratch` is a shared { canvas, ctx } the filter may freely resize.
//
// To add a filter later: write an apply(base, dst, W, H, scratch) function and
// append a { name, apply } entry to FILTERS. That's the whole extension point.

// --- pixelate: downscale with smoothing, upscale with smoothing OFF -----------
const PIXEL_SIZE = 40; // block size in device px (bigger = chunkier)

function pixelate(base, dst, W, H, scratch) {
  const sw = Math.max(1, Math.ceil(W / PIXEL_SIZE));
  const sh = Math.max(1, Math.ceil(H / PIXEL_SIZE));
  scratch.canvas.width = sw;
  scratch.canvas.height = sh;
  scratch.ctx.imageSmoothingEnabled = true;
  scratch.ctx.clearRect(0, 0, sw, sh);
  scratch.ctx.drawImage(base, 0, 0, sw, sh); // downscale

  dst.imageSmoothingEnabled = false;
  dst.clearRect(0, 0, W, H);
  dst.drawImage(scratch.canvas, 0, 0, sw, sh, 0, 0, W, H); // blocky upscale
  dst.imageSmoothingEnabled = true;
}

// --- gaussian blur: real separable Gaussian kernel on pixel data ------------
// ctx.filter="blur()" no-ops in some browsers, so we convolve by hand. To stay
// cheap at 1080p we run the kernel on a downscaled buffer, then upscale — the
// downscale also multiplies the effective radius.
const GAUSS_DOWNSCALE = 5; // pre-shrink factor (bigger = faster + blurrier)
const GAUSS_RADIUS = 10;    // kernel radius on the downscaled buffer

let kernel = null; // cached 1D Gaussian weights
let tmpBuf = null; // cached intermediate (horizontal-pass) buffer

function buildKernel(radius) {
  const sigma = radius / 2 || 1;
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum; // normalize
  return k;
}

function gaussianBlur(base, dst, W, H, scratch) {
  const sw = Math.max(1, Math.ceil(W / GAUSS_DOWNSCALE));
  const sh = Math.max(1, Math.ceil(H / GAUSS_DOWNSCALE));
  scratch.canvas.width = sw;
  scratch.canvas.height = sh;
  scratch.ctx.imageSmoothingEnabled = true;
  scratch.ctx.clearRect(0, 0, sw, sh);
  scratch.ctx.drawImage(base, 0, 0, sw, sh); // downscale

  const img = scratch.ctx.getImageData(0, 0, sw, sh);
  const src = img.data;
  if (!kernel) kernel = buildKernel(GAUSS_RADIUS);
  if (!tmpBuf || tmpBuf.length !== src.length) {
    tmpBuf = new Uint8ClampedArray(src.length);
  }
  const tmp = tmpBuf;
  const r = GAUSS_RADIUS;

  // horizontal pass: src → tmp (clamp at edges)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let i = -r; i <= r; i++) {
        let sx = x + i;
        if (sx < 0) sx = 0;
        else if (sx >= sw) sx = sw - 1;
        const o = (y * sw + sx) * 4;
        const wgt = kernel[i + r];
        rr += src[o] * wgt;
        gg += src[o + 1] * wgt;
        bb += src[o + 2] * wgt;
        aa += src[o + 3] * wgt;
      }
      const d = (y * sw + x) * 4;
      tmp[d] = rr; tmp[d + 1] = gg; tmp[d + 2] = bb; tmp[d + 3] = aa;
    }
  }

  // vertical pass: tmp → src (clamp at edges)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let i = -r; i <= r; i++) {
        let sy = y + i;
        if (sy < 0) sy = 0;
        else if (sy >= sh) sy = sh - 1;
        const o = (sy * sw + x) * 4;
        const wgt = kernel[i + r];
        rr += tmp[o] * wgt;
        gg += tmp[o + 1] * wgt;
        bb += tmp[o + 2] * wgt;
        aa += tmp[o + 3] * wgt;
      }
      const d = (y * sw + x) * 4;
      src[d] = rr; src[d + 1] = gg; src[d + 2] = bb; src[d + 3] = aa;
    }
  }

  scratch.ctx.putImageData(img, 0, 0);
  dst.imageSmoothingEnabled = true;
  dst.clearRect(0, 0, W, H);
  dst.drawImage(scratch.canvas, 0, 0, sw, sh, 0, 0, W, H); // smooth upscale
}

// --- ascii: quantize luminance per cell, stamp a monospace glyph -------------
// Canvas2D port of the WebGL asciishader using its exact 11-step luminance→glyph
// mapping. Cells are sized so the real monospace characters stay legible as
// letters (denser glyphs where the frame is brighter).
//
// Because the panel only ever reveals `filtered` through the lens quad, the
// per-cell fillText loop is clipped to the lens bounding box passed in `region`.
const ASCII_CELL = 12; // cell size in device px. Big enough that real monospace
                       // glyphs stay legible as letters (at ~6px they collapse
                       // into indistinct dots). Bump higher for larger letters.
// The shader maps 11 luminance levels onto "@%#*+=-:. " via its t-thresholds.
// Worked out level-by-level, that is this dark→bright ramp (note the doubled
// '#'); indexing floor(lum*11) reproduces the shader's buckets exactly.
const ASCII_RAMP = " .:-=+*##%@";

function ascii(base, dst, W, H, scratch, region) {
  const cols = Math.max(1, Math.floor(W / ASCII_CELL));
  const rows = Math.max(1, Math.floor(H / ASCII_CELL));

  // Downscale the full frame into the cell grid; each pixel is one cell average.
  scratch.canvas.width = cols;
  scratch.canvas.height = rows;
  scratch.ctx.imageSmoothingEnabled = true;
  scratch.ctx.clearRect(0, 0, cols, rows);
  scratch.ctx.drawImage(base, 0, 0, cols, rows);
  const data = scratch.ctx.getImageData(0, 0, cols, rows).data;

  // Half-transparent black backdrop (webcam shows through), full frame.
  dst.clearRect(0, 0, W, H);
  dst.fillStyle = "rgba(0, 0, 0, 0.95)";
  dst.fillRect(0, 0, W, H);

  dst.fillStyle = "#e8e8e8";
  dst.font = `${ASCII_CELL}px monospace`;
  dst.textAlign = "center";
  dst.textBaseline = "middle";

  // Restrict the glyph loop to the lens bounding box when given (glyphs outside
  // it are never shown); fall back to the whole grid when absent.
  let cx0 = 0, cy0 = 0, cx1 = cols - 1, cy1 = rows - 1;
  if (region) {
    cx0 = Math.max(0, Math.floor(region.x0 / ASCII_CELL));
    cy0 = Math.max(0, Math.floor(region.y0 / ASCII_CELL));
    cx1 = Math.min(cols - 1, Math.floor(region.x1 / ASCII_CELL));
    cy1 = Math.min(rows - 1, Math.floor(region.y1 / ASCII_CELL));
  }

  const last = ASCII_RAMP.length - 1;
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const o = (y * cols + x) * 4;
      // Rec. 601 luminance, same weights as the shader.
      const lum =
        (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255;
      const ch = ASCII_RAMP[Math.min(last, Math.floor(lum * ASCII_RAMP.length))];
      if (ch === " ") continue;
      dst.fillText(ch, (x + 0.5) * ASCII_CELL, (y + 0.5) * ASCII_CELL);
    }
  }
}

// --- thermal: remap luminance to an ironbow-style thermal-scanner gradient ---
// A handheld thermal-camera look with NO ML/segmentation/OpenCV — purely a
// per-pixel luminance → color remap. To mimic a low-resolution sensor (and to
// stay cheap) we process a downscaled buffer, then smooth-upscale into the
// lens: the upscale doubles as a soft thermal blur and hides palette banding.
// A precomputed 256-entry lookup turns the hot inner loop into three array
// reads per pixel; a touch of grain sells the "live sensor" feel.
const THERMAL_DOWNSCALE = 4; // sensor "resolution" divisor (bigger = blockier + faster)
const THERMAL_CONTRAST = 0.85; // >1 expands mid-tones so shapes stay readable
const THERMAL_NOISE = 8;      // ± per-pixel luminance grain (0 = clean sensor)

// Palette stops: brightness position [0..1] → RGB. Requested dark→hot ramp:
// dark blue · cyan · purple · red · orange · yellow · white.
const THERMAL_STOPS = [
  { t: 0.0,  c: [4, 8, 48] },      // dark blue (cold)
  { t: 0.18, c: [0, 170, 205] },   // cyan
  { t: 0.38, c: [120, 40, 155] },  // purple
  { t: 0.58, c: [220, 30, 30] },   // red
  { t: 0.74, c: [255, 130, 0] },   // orange
  { t: 0.88, c: [255, 225, 45] },  // yellow
  { t: 1.0,  c: [255, 255, 255] }, // white (hot)
];

let thermalLUT = null; // Uint8Array(256*3), built once on first use

// Build a 256-entry brightness→RGB lookup by linearly interpolating between
// palette stops ({ t: position[0..1], c: [r,g,b] }). Linear interp keeps the
// transitions smooth (no banding); indexing by luminance is three reads/pixel.
function buildGradientLUT(stops) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // find the two stops bracketing this brightness
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s].t && t <= stops[s + 1].t) {
        a = stops[s];
        b = stops[s + 1];
        break;
      }
    }
    const span = b.t - a.t || 1;
    const f = (t - a.t) / span;
    lut[i * 3]     = a.c[0] + (b.c[0] - a.c[0]) * f;
    lut[i * 3 + 1] = a.c[1] + (b.c[1] - a.c[1]) * f;
    lut[i * 3 + 2] = a.c[2] + (b.c[2] - a.c[2]) * f;
  }
  return lut;
}

// Shared low-res luminance→palette remap used by thermal and candy: downscale
// (sensor/low-res look + speed), remap each pixel's luminance through `lut`
// with optional contrast/brightness/grain, then smooth-upscale into the lens.
function paletteRemap(base, dst, W, H, scratch, opts) {
  const { downscale, lut, contrast = 1, brightness = 0, noise = 0 } = opts;
  const sw = Math.max(1, Math.ceil(W / downscale));
  const sh = Math.max(1, Math.ceil(H / downscale));
  scratch.canvas.width = sw;
  scratch.canvas.height = sh;
  scratch.ctx.imageSmoothingEnabled = true;
  scratch.ctx.clearRect(0, 0, sw, sh);
  scratch.ctx.drawImage(base, 0, 0, sw, sh); // downscale

  const img = scratch.ctx.getImageData(0, 0, sw, sh);
  const px = img.data;

  for (let i = 0; i < px.length; i += 4) {
    // Rec. 601 luminance, same weights as the other filters.
    let lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    lum = (lum - 128) * contrast + 128 + brightness; // contrast around mid-grey
    if (noise) lum += (Math.random() - 0.5) * 2 * noise;

    let l = lum | 0;
    if (l < 0) l = 0;
    else if (l > 255) l = 255;

    const o = l * 3;
    px[i]     = lut[o];
    px[i + 1] = lut[o + 1];
    px[i + 2] = lut[o + 2];
    // alpha (px[i + 3]) left untouched
  }
  scratch.ctx.putImageData(img, 0, 0);

  dst.imageSmoothingEnabled = true; // smooth upscale → soft low-res blur
  dst.clearRect(0, 0, W, H);
  dst.drawImage(scratch.canvas, 0, 0, sw, sh, 0, 0, W, H);
}

function thermal(base, dst, W, H, scratch) {
  if (!thermalLUT) thermalLUT = buildGradientLUT(THERMAL_STOPS);
  paletteRemap(base, dst, W, H, scratch, {
    downscale: THERMAL_DOWNSCALE,
    lut: thermalLUT,
    contrast: THERMAL_CONTRAST,
    noise: THERMAL_NOISE,
  });
}

// --- candy: remap luminance to a soft pastel candy palette -------------------
// Same LUT-remap machinery as `thermal`, but a light, low-saturation rainbow —
// grape · lilac · baby blue · mint · lemon · cotton-candy pink · cream. A small
// brightness lift keeps it airy/pastel; grain is off (candy wants clean color).
const CANDY_DOWNSCALE = 4;   // low-res softening; matches thermal's blockiness
const CANDY_CONTRAST = 0.8;  // <1 flattens tones for a gentle pastel look
const CANDY_BRIGHTNESS = 18; // lift added after contrast → lighter, airier

const CANDY_STOPS = [
  { t: 0.0,  c: [96, 66, 128] },   // grape (soft dark end)
  { t: 0.18, c: [176, 138, 222] }, // lilac
  { t: 0.36, c: [140, 202, 238] }, // baby blue
  { t: 0.54, c: [158, 232, 202] }, // mint
  { t: 0.70, c: [250, 240, 168] }, // lemon
  { t: 0.86, c: [250, 184, 214] }, // cotton-candy pink
  { t: 1.0,  c: [255, 250, 246] }, // cream
];

let candyLUT = null;

function candy(base, dst, W, H, scratch) {
  if (!candyLUT) candyLUT = buildGradientLUT(CANDY_STOPS);
  paletteRemap(base, dst, W, H, scratch, {
    downscale: CANDY_DOWNSCALE,
    lut: candyLUT,
    contrast: CANDY_CONTRAST,
    brightness: CANDY_BRIGHTNESS,
  });
}

// --- candypop: soft candy-pigment overlay (blooms, speckles, confetti) -------
// NOT a false-color remap. The webcam stays fully visible; we scatter many
// small soft-edged candy blobs over it, like airbrushed pigment / confetti.
// Placement is DETERMINISTIC (hashed per grid cell) so blobs sit still frame to
// frame instead of flickering — a poster-like overlay, not TV static. Soft
// discs are pre-rendered once per palette color and just blitted (cheap). The
// blob layer is built at reduced resolution and smooth-upscaled for a powdery,
// blurred feel. Blob alpha follows the webcam's local brightness so pigment
// blooms on highlights and thins over shadows, keeping the underlying face
// readable.
// Two palettes share the machinery below: `candypop` (soft pastel) and
// `candyvivid` (punchier, less washed-out). Each is one filter in the stack.
const CANDYPOP_PALETTE = [
  [255, 150, 190], // bubblegum pink
  [140, 200, 245], // sky blue
  [165, 232, 190], // mint green
  [255, 238, 150], // lemon yellow
  [200, 172, 240], // lavender
  [255, 190, 150], // peach
  [255, 140, 70],  // bright orange accent (kept sparse — see placeBlob)
];
const CANDYVIVID_PALETTE = [
  [255, 105, 160], // bubblegum pink
  [90, 170, 240],  // sky blue
  [110, 215, 150], // mint green
  [255, 220, 90],  // lemon yellow
  [175, 130, 235], // lavender
  [255, 160, 110], // peach
  [255, 110, 40],  // bright orange accent (kept sparse — see placeBlob)
];
const CANDYPOP_DOWNSCALE = 1;  // blob-layer render scale (bigger = blurrier + faster)
const CANDYPOP_SPACING = 70;   // device px between blob slots (bigger = sparser)
const CANDYPOP_OVERLAY = 1; // strength of the candy layer over the webcam
const CANDY_SPRITE = 136;       // pre-rendered soft-disc sprite resolution

// Per-palette lazy sprite caches plus a "feel" config. `candypop` is softer and
// foggier (wider sprite feather, bigger/denser blooms, a light all-over haze
// floor); `candyvivid` is crisp graphic dots with real negative space.
const candyPop = {
  palette: CANDYPOP_PALETTE,
  sprites: null,
  soft: true,           // wide feathered sprite → hazier dots
  alphaBase: 0.32,      // faint all-over floor brings back some mist
  alphaLum: 0.6,        // + brightness
  blooms: { sizeMul: 1.15, prob: 0.55 },
  speckles: { sizeMul: 0.45, prob: 0.7 },
};
const candyVivid = {
  palette: CANDYVIVID_PALETTE,
  sprites: null,
  soft: false,          // tight feather → crisp airbrushed spots
  alphaBase: 0.7,       // no haze floor; dots stay distinct
  alphaLum: 0.3,
  blooms: { sizeMul: 0.55, prob: 0.42 },
  speckles: { sizeMul: 0.28, prob: 0.5 },
};
let blobLayer = null, blobCtx = null; // reduced-res accumulation canvas
let candyLum = null, candyLumCtx = null; // tiny luminance sampling buffer

function buildCandySprites(palette, soft) {
  return palette.map(([r, g, b]) => {
    const c = document.createElement("canvas");
    c.width = c.height = CANDY_SPRITE;
    const cx = c.getContext("2d");
    const R = CANDY_SPRITE / 2;
    const grad = cx.createRadialGradient(R, R, 0, R, R, R);
    if (soft) {
      // wide, gentle feather → hazy, powdery dots (the original candypop mist)
      grad.addColorStop(0.0, `rgba(${r},${g},${b},0.9)`);
      grad.addColorStop(0.4, `rgba(${r},${g},${b},0.4)`);
      grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
    } else {
      // solid core + tight feathered edge → a crisp airbrushed dot, not a haze
      grad.addColorStop(0.0, `rgba(${r},${g},${b},1)`);
      grad.addColorStop(0.55, `rgba(${r},${g},${b},0.96)`);
      grad.addColorStop(0.82, `rgba(${r},${g},${b},0.35)`);
      grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
    }
    cx.fillStyle = grad;
    cx.fillRect(0, 0, CANDY_SPRITE, CANDY_SPRITE);
    return c;
  });
}

// Cheap deterministic hash → [0,1) from two grid ints + a salt (per attribute).
function hash2(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Place one hashed blob for grid cell (gx,gy) onto the reduced-res blob layer.
// `salt` picks an independent blob "channel" (a bloom pass vs a speckle pass);
// `set` supplies the palette sprites and the per-palette opacity feel.
function placeBlob(gx, gy, salt, L, s, sizeMul, prob, set) {
  if (hash2(gx, gy, salt) > prob) return; // hashed density → confetti clustering
  const jx = (hash2(gx, gy, salt + 11) - 0.5) * CANDYPOP_SPACING;
  const jy = (hash2(gx, gy, salt + 12) - 0.5) * CANDYPOP_SPACING;
  const cx = (gx + 0.5) * CANDYPOP_SPACING + jx;
  const cy = (gy + 0.5) * CANDYPOP_SPACING + jy;
  // tighter size spread so dots read as distinct spots, not overlapping clouds
  const rad = CANDYPOP_SPACING * sizeMul * (0.65 + 0.6 * hash2(gx, gy, salt + 13));

  const sprites = set.sprites;
  let ci = Math.floor(hash2(gx, gy, salt + 14) * sprites.length);
  // keep the bright-orange accent rare: usually demote it to bubblegum pink
  if (ci === 6 && hash2(gx, gy, salt + 15) > 0.35) ci = 0;

  // Opacity feel is per-palette: candyvivid uses a high floor + low haze so dots
  // stay crisp; candypop uses a lower floor + more brightness haze for mist.
  blobCtx.globalAlpha = Math.min(1, set.alphaBase + L * set.alphaLum);
  const d = rad * 2 * s;
  blobCtx.drawImage(sprites[ci], cx * s - d / 2, cy * s - d / 2, d, d);
}

// Shared renderer for both candy palettes. `set` is the palette+feel config
// above; its sprites are built lazily the first time that palette is used.
function candyPigment(base, dst, W, H, region, set) {
  // 1. webcam stays visible underneath the pigment
  dst.imageSmoothingEnabled = true;
  dst.clearRect(0, 0, W, H);
  dst.drawImage(base, 0, 0);

  if (!set.sprites) set.sprites = buildCandySprites(set.palette, set.soft);

  // 2. tiny luminance buffer (one sample per blob slot) to modulate pigment
  const lw = Math.max(1, Math.round(W / CANDYPOP_SPACING));
  const lh = Math.max(1, Math.round(H / CANDYPOP_SPACING));
  if (!candyLum) {
    candyLum = document.createElement("canvas");
    candyLumCtx = candyLum.getContext("2d", { willReadFrequently: true });
  }
  candyLum.width = lw;
  candyLum.height = lh;
  candyLumCtx.imageSmoothingEnabled = true;
  candyLumCtx.drawImage(base, 0, 0, lw, lh);
  const lum = candyLumCtx.getImageData(0, 0, lw, lh).data;

  // 3. build the candy blob layer at reduced resolution
  const bw = Math.max(1, Math.ceil(W / CANDYPOP_DOWNSCALE));
  const bh = Math.max(1, Math.ceil(H / CANDYPOP_DOWNSCALE));
  if (!blobLayer) {
    blobLayer = document.createElement("canvas");
    blobCtx = blobLayer.getContext("2d");
  }
  blobLayer.width = bw;
  blobLayer.height = bh;
  blobCtx.clearRect(0, 0, bw, bh);
  const s = 1 / CANDYPOP_DOWNSCALE; // screen → blob-layer scale

  // Iterate the slot grid; restrict to the lens bbox (+1 cell margin so blobs
  // straddling the edge still render). Hashes key off absolute (gx,gy), so
  // clipping the loop never shifts where a blob sits.
  let gx0 = 0, gy0 = 0, gx1 = lw - 1, gy1 = lh - 1;
  if (region) {
    gx0 = Math.max(0, Math.floor(region.x0 / CANDYPOP_SPACING) - 1);
    gy0 = Math.max(0, Math.floor(region.y0 / CANDYPOP_SPACING) - 1);
    gx1 = Math.min(lw - 1, Math.ceil(region.x1 / CANDYPOP_SPACING) + 1);
    gy1 = Math.min(lh - 1, Math.ceil(region.y1 / CANDYPOP_SPACING) + 1);
  }

  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const li = (gy * lw + gx) * 4;
      const L = (0.299 * lum[li] + 0.587 * lum[li + 1] + 0.114 * lum[li + 2]) / 255;
      placeBlob(gx, gy, 1, L, s, set.blooms.sizeMul, set.blooms.prob, set);
      placeBlob(gx, gy, 40, L, s, set.speckles.sizeMul, set.speckles.prob, set);
    }
  }

  // 4. lay the powdery layer over the webcam, keeping it visible
  dst.globalAlpha = CANDYPOP_OVERLAY;
  dst.drawImage(blobLayer, 0, 0, bw, bh, 0, 0, W, H);
  dst.globalAlpha = 1;
}

function candypop(base, dst, W, H, scratch, region) {
  candyPigment(base, dst, W, H, region, candyPop);
}

function candyvivid(base, dst, W, H, scratch, region) {
  candyPigment(base, dst, W, H, region, candyVivid);
}

// Ordered stack the user cycles through. Append new filters here.
export const FILTERS = [
  { name: "pixelate", apply: pixelate },
  { name: "gaussian", apply: gaussianBlur },
  { name: "thermal", apply: thermal },
  { name: "candy", apply: candy },
  { name: "candypop", apply: candypop },
  { name: "candyvivid", apply: candyvivid },
  // { name: "ascii", apply: ascii },
];
