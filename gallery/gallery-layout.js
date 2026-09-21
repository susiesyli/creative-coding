// Authored composition for the canvas ("scatter") gallery view.
//
// This file is DATA ONLY — no rendering, no DOM. Tune the composition by
// editing numbers here; nothing else needs to change.
//
// Coordinates are top-left positions in world space (px), NOT screen space.
// The world is a fixed-size plane larger than the viewport that the camera
// pans across. Origin (0,0) is the world's top-left corner.
//
// Entry shape:
//   id        matches an item `id` in gallery.js (that's the join key)
//   x, y      top-left position in world space
//   width     rendered width in px; height follows from `ratio`
//   ratio     aspect ratio as width/height
//   rotation  degrees, kept within ±4° so it reads as art direction, not noise
//   zIndex    stacking order; also the hover baseline (hover adds +10)
//
// `ratio` matches each source PNG's own aspect ratio, so nothing is cropped —
// compositional variety comes from scale and position instead. If you swap a
// thumbnail for one with a different shape, update its ratio to match or the
// image will be cover-cropped.
//
// The layout is deliberate and stable: it is never randomized at load, so the
// composition you tune is the composition every visitor sees.

// The world is deliberately sized close to the viewport's own proportions, so
// fit-to-view is limited about equally by width and height and the cards land
// as large as possible when zoomed out. Growing the world costs zoom: every
// extra 10% of sheet shrinks the thumbnails by 10% at fit.
export const WORLD = { width: 2400, height: 1440 };

// The title/intro cluster is just another object in the world, positioned
// like any thumbnail. It sits in the middle of the composition with the cards
// scattered around it, and the camera centres on it on first visit.
export const TITLE = {
  x: 1010,
  y: 600,
  width: 480,
  rotation: 0,
  zIndex: 6,
};

// An organic scatter rather than a ring: transcribed from a hand-arranged
// composition, so the spacing is intentionally uneven — a tight cluster of
// three across the top, a loose diagonal falling to the lower right, and the
// two darkest pieces (blob, cube) holding the left edge. Nothing is aligned to
// anything, and no pair sits within the 28px collision pad, so the layout does
// not shuffle the first time a card is dragged.
export const LAYOUT = [
  // ---- top row ----
  { id: "cube", x: 70, y: 80, width: 460, ratio: 640 / 342, rotation: 1.2, zIndex: 2 },
  { id: "draw", x: 700, y: 60, width: 420, ratio: 640 / 488, rotation: 1.6, zIndex: 2 },
  { id: "photobooth", x: 1280, y: 70, width: 580, ratio: 640 / 468, rotation: 2.4, zIndex: 3 },
  { id: "blob2", x: 1950, y: 60, width: 360, ratio: 640 / 448, rotation: -1.4, zIndex: 1 },

  // ---- middle, flanking the title ----
  { id: "panel", x: 340, y: 490, width: 540, ratio: 640 / 365, rotation: -2.2, zIndex: 3 },
  { id: "asciishader", x: 1530, y: 625, width: 460, ratio: 640 / 359, rotation: -1.8, zIndex: 2 },

  // ---- lower diagonal ----
  { id: "blob", x: 70, y: 920, width: 380, ratio: 640 / 361, rotation: -3.4, zIndex: 3 },
  { id: "puzzle-jigsaw", x: 620, y: 940, width: 500, ratio: 640 / 343, rotation: -0.9, zIndex: 2 },
  { id: "puzzle-sliding", x: 1225, y: 1085, width: 400, ratio: 640 / 359, rotation: 3.2, zIndex: 1 },
  { id: "customshader", x: 1930, y: 1040, width: 400, ratio: 640 / 413, rotation: 2.8, zIndex: 3 },
];

// ---------------------------------------------------------------------------
// PORTRAIT COMPOSITION
//
// The sheet above is 1.67 wide-to-tall. On a phone (440×956 ≈ 0.46) it fits at
// only ~0.17×, which is why it reads as a tiny horizontal band with dead space
// above and below. Fit-to-view is min(vw/W, vh/H), so a landscape sheet on a
// portrait screen is limited by width and wastes all the height.
//
// This is the same ten cards at the same widths, restacked into a tall sheet
// whose proportions roughly match a phone — so fit lands near 0.35× and the
// thumbnails are legible. It is chosen at load by pickComposition() below.
//
// The title cluster's CENTRE is deliberately the world's exact centre. That
// matters: when the sheet fits the viewport, camera bounds hold it centred, so
// "centre the sheet" and "centre the title" have to be the same point or the
// two fight and the title lands off-centre. The card mass above and below the
// title is balanced to make that true (≈1010px above, ≈980px below).
//
// Same rules as the landscape sheet: uneven spacing, nothing aligned, no pair
// inside the 28px collision pad, ratios matching each image.
const PORTRAIT_WORLD = { width: 1160, height: 2496 };

const PORTRAIT_TITLE = {
  // centre = (340 + 480/2, 1148 + 200/2) = (580, 1248) = world centre
  x: 340,
  y: 1148,
  width: 480,
  rotation: 0,
  zIndex: 6,
};

// A loose two-column zigzag down the sheet: cards alternate weight left and
// right rather than forming a single column, so scrolling down still feels like
// traversing a composition rather than a list.
const PORTRAIT_LAYOUT = [
  // ---- above the title: left column, then right ----
  { id: "cube", x: 60, y: 60, width: 460, ratio: 640 / 342, rotation: 1.2, zIndex: 2 },
  { id: "panel", x: 60, y: 406, width: 540, ratio: 640 / 365, rotation: -2.2, zIndex: 3 },
  { id: "blob", x: 60, y: 814, width: 380, ratio: 640 / 361, rotation: -3.4, zIndex: 3 },
  { id: "blob2", x: 680, y: 100, width: 360, ratio: 640 / 448, rotation: -1.4, zIndex: 1 },
  { id: "draw", x: 700, y: 452, width: 420, ratio: 640 / 488, rotation: 1.6, zIndex: 2 },

  // ---- below the title ----
  { id: "photobooth", x: 60, y: 1428, width: 580, ratio: 640 / 468, rotation: 2.4, zIndex: 3 },
  { id: "puzzle-jigsaw", x: 60, y: 1952, width: 500, ratio: 640 / 343, rotation: -0.9, zIndex: 2 },
  { id: "asciishader", x: 680, y: 1440, width: 460, ratio: 640 / 359, rotation: -1.8, zIndex: 2 },
  { id: "customshader", x: 700, y: 1798, width: 400, ratio: 640 / 413, rotation: 2.8, zIndex: 3 },
  { id: "puzzle-sliding", x: 700, y: 2156, width: 400, ratio: 640 / 359, rotation: 3.2, zIndex: 1 },
];

export const LANDSCAPE = { world: WORLD, title: TITLE, layout: LAYOUT };
export const PORTRAIT = {
  world: PORTRAIT_WORLD,
  title: PORTRAIT_TITLE,
  layout: PORTRAIT_LAYOUT,
};

// Chosen once, at load, from the viewport's shape. Not re-evaluated on resize:
// swapping compositions mid-session would teleport every card, and would fight
// any positions the visitor had already rearranged. Rotating a phone therefore
// keeps the composition it opened with, which still pans and zooms normally.
export function pickComposition(viewportWidth, viewportHeight) {
  const width = Number(viewportWidth);
  const height = Number(viewportHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return LANDSCAPE;
  if (width <= 0 || height <= 0) return LANDSCAPE;
  return height > width ? PORTRAIT : LANDSCAPE;
}