// Canvas ("scatter") gallery view — a large 2D sheet viewed through a pan/zoom
// camera, with individual thumbnails that can be picked up and moved.
// Activated by setting VIEW = "canvas" in gallery.js.
//
// Feel target: a camera over a tabletop composition. Direct, tactile, no
// springs or bounce. Panning the sheet is 1:1 with the pointer at any zoom;
// zooming is continuous and anchored under the cursor; dragging a print is 1:1
// in world space and has no momentum — it goes exactly where it is put.
//
// Three gestures, disambiguated by input and by where the press lands:
//   wheel / trackpad      → zoom, anchored on the pointer
//   press on empty sheet  → pan the whole sheet (glides on release)
//   press on a thumbnail  → move that thumbnail only (never pans the sheet)
//   press without moving  → a click, opens the project
// A press on a thumbnail is not classified until the pointer moves past the
// threshold, so nothing commits to a gesture prematurely.
//
// Coordinate spaces
//   world   the authored sheet, WORLD.width × WORLD.height. Item positions
//           live here and never change when the camera moves.
//   screen  viewport pixels. The camera maps world → screen:
//               screen = world * scale + camera
//               world  = (screen - camera) / scale
//           Those two lines are the only conversion in the file; panning,
//           zooming and card dragging all reduce to them.
//
// Performance shape
//   - Camera and per-item positions live in plain mutable objects (motion
//     values, not state). They are written on pointermove but never read back
//     from the DOM, and nothing re-renders.
//   - Pointer handlers do zero layout work: they mutate a value and mark the
//     frame dirty. One rAF flushes the world transform plus any moved item, so
//     bursty 120Hz pointer/wheel streams collapse to one write per frame.
//   - The camera is ONE transform on the world container. Cards are never
//     individually scaled or repositioned in response to camera movement.
//   - Item position lives in the same `transform` as its rotation (via custom
//     properties), so moving a print is a compositor-friendly transform change
//     rather than a `left`/`top` layout change.
//   - Geometry is read only in measureViewport(), on init and on resize.
//
// Deliberately NOT here: minimap, zoom slider, +/− controls, snapping,
// card-to-card collision, auto-rearrangement, drag momentum, camera tours.

import { pickComposition } from "./gallery-layout.js";

// Resolved once in initCanvasView from the viewport's shape: a tall screen gets
// the portrait sheet, a wide one the landscape sheet. Module-level rather than
// imported constants because the choice is made at runtime — everything below
// (bounds, clamping, the title cluster) reads through these.
let WORLD;
let TITLE;
let LAYOUT;

// ---- tuning -------------------------------------------------------------
// Click vs. drag. Sheet panning tracks from the very first pixel; for a
// thumbnail this threshold is what separates "opening it" from "moving it",
// so nothing happens at all until the pointer clears it.
const DRAG_THRESHOLD = 6; // px

// Zoom. Scale changes multiplicatively (exp of the wheel delta) so a given
// gesture feels the same at every zoom level, and there are no discrete steps.
const MAX_SCALE = 2.25;
// 8% breathing room around the sheet at fit-to-view.
const FIT_PADDING = 0.92;
// Sensitivity is per pixel of normalized wheel delta. A mouse notch (~100px)
// lands near 16%; a trackpad's small deltas land under 1% each, which is what
// makes continuous two-finger scrolling feel smooth rather than steppy.
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
// macOS reports trackpad pinch as ctrl+wheel with much smaller deltas, so it
// needs its own factor to feel like a direct pinch.
const PINCH_ZOOM_SENSITIVITY = 0.006;
// Per-event clamp, so one oversized delta (page-mode wheel, coarse driver)
// can't jump the zoom.
const MIN_ZOOM_STEP = 0.8;
const MAX_ZOOM_STEP = 1.25;
// If fit-to-view would make the thumbnails unreadably small (narrow phones),
// open at this scale instead. True fit is still reachable by zooming out.
const INITIAL_MIN_SCALE = 0.3;
// The opening view sits slightly tighter than true fit, so the composition
// reads at a comfortable size and the edges hint that there is more to pan to.
// Deliberately separate from FIT_PADDING: the fit-view action still goes to
// genuine fit, and minScale is still genuine fit, so nothing is unreachable.
const INITIAL_ZOOM = 1.08;

// Momentum, for the sheet only. Expressed in time, not frames, so a 120Hz
// display decelerates over the same duration as a 60Hz one. Half-life 90ms ≈
// 96% shed in 400ms: enough to feel like mass, too short to feel floaty.
const MOMENTUM_HALF_LIFE = 90; // ms
const MOMENTUM_TAU = MOMENTUM_HALF_LIFE / Math.LN2; // ms; total glide = v * tau
const MIN_SPEED = 45; // px/s — below this, stop rather than crawl
const MAX_SPEED = 3200; // px/s — a hard flick can't launch the sheet away
const MAX_FRAME_MS = 48; // clamp dt so a stalled tab can't teleport the camera

// Velocity is measured over a short trailing window of pointer samples, and
// only from samples that are still fresh at release — otherwise holding still
// for a moment before letting go would fling the sheet on stale motion.
const VELOCITY_WINDOW = 70; // ms
const HISTORY_WINDOW = 140; // ms of samples retained to measure from

// Wheel normalization. deltaMode 0 is already pixels (trackpads, most mice);
// 1 is lines and 2 is pages, which some browsers/mice still report.
const WHEEL_LINE = 16; // px per line
const WHEEL_PAGE_FACTOR = 0.9; // fraction of the viewport per page-delta

// How far past the sheet's edge the camera may travel, in screen px. A little
// slack reads as breathing room; it is a hard bound, not a snap-back.
const EDGE_SLACK = 64;

// A moved print is kept inside the world rect, since the camera is bounded to
// the sheet and a print dropped outside it could never be reached again.
// Approximates the caption block under each image (.gc-caption: font size ×
// line height + its top margin). Keep it in step with .gc-caption's font-size,
// or collision boxes and drag bounds will be shorter than the visible card.
const CAPTION_ALLOWANCE = 40; // px of caption below the image, kept in bounds

// ---- soft collision -----------------------------------------------------
// While a print is being dragged, neighbours yield to make room, and that
// yielding can propagate down a chain. This is spatial assistance, not a rule:
// cards may still overlap, nothing snaps, and nothing is blocked.
//
// All of it is WORLD space, so the result is identical at any pan or zoom — the
// padding is world px and never scales with the camera.
const COLLISION_PADDING = 28; // world px of invisible margin around each card
const COLLISION_STRENGTH = 0.25; // fraction of the separation applied per pass
const SOLVER_ITERATIONS = 4; // relaxation passes per frame
const POSITION_SMOOTHING = 0.2; // how fast a displaced card eases to its target
const SETTLE_THRESHOLD = 0.35; // world px; under this a card counts as still
const SETTLE_TIMEOUT = 1500; // ms cap on settling after release
// Below this the push is imperceptible; treating it as zero is what lets the
// solver converge and the simulation stop instead of creeping forever.
const MIN_PUSH = 0.01;

const CAMERA_KEY = "gallery:canvas-camera";
const POSITIONS_KEY = "gallery:canvas-positions";
const SAVE_IDLE = 200; // ms of quiet before persisting

// Queried live rather than cached at load, so toggling the OS setting takes
// effect without a reload.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export function initCanvasView(root, items) {
  // Pick the composition before anything reads WORLD/LAYOUT/TITLE. window
  // dimensions rather than the viewport element's, since it isn't in the DOM
  // yet — and they are the same thing here, the viewport being fixed/inset-0.
  const composition = pickComposition(
    typeof window !== "undefined" ? window.innerWidth : undefined,
    typeof window !== "undefined" ? window.innerHeight : undefined,
  );
  WORLD = composition.world;
  TITLE = composition.title;
  LAYOUT = composition.layout;

  // Join the flat item list against the authored layout. Anything without a
  // layout entry is reported rather than silently dropped — otherwise adding
  // a project to gallery.js would make it quietly invisible in this view.
  const byId = new Map(items.map((item) => [item.id, item]));
  const placed = [];
  for (const spot of LAYOUT) {
    const item = byId.get(spot.id);
    if (!item) {
      console.warn(`[gallery] layout entry has no matching item: ${spot.id}`);
      continue;
    }
    placed.push({ item, spot });
    byId.delete(spot.id);
  }
  for (const id of byId.keys()) {
    console.warn(`[gallery] item has no canvas layout entry, not shown: ${id}`);
  }

  // ---- runtime positions ----
  // The authored layout in gallery-layout.js stays the immutable default. This
  // map is the mutable runtime copy: x/y change as prints are moved, width /
  // rotation / zIndex are carried along but never modified by a drag.
  // `moved` tracks whether the user has touched a print, so untouched ones
  // keep following the authored composition when you retune it.
  const positions = new Map();
  for (const { spot } of placed) {
    positions.set(spot.id, {
      x: spot.x,
      y: spot.y,
      // Collision target. `x/y` is what is rendered; `tx/ty` is where the
      // solver wants the card. They differ only while cards are settling.
      tx: spot.x,
      ty: spot.y,
      width: spot.width,
      ratio: spot.ratio,
      height: spot.width / spot.ratio + CAPTION_ALLOWANCE,
      rotation: spot.rotation,
      zIndex: spot.zIndex,
      moved: false,
      el: null,
    });
  }
  restorePositions();

  // ---- build ----
  document.documentElement.classList.add("gc-active");
  document.body.classList.add("gc-active");

  const viewport = document.createElement("div");
  viewport.className = "gc-viewport";

  const world = document.createElement("div");
  world.className = "gc-world";
  world.style.width = `${WORLD.width}px`;
  world.style.height = `${WORLD.height}px`;

  const titleEl = buildTitle();
  world.appendChild(titleEl);
  for (const { item, spot } of placed) {
    const record = positions.get(spot.id);
    const el = buildItem(item, record);
    record.el = el;
    writeItem(record);
    el.addEventListener("pointerdown", (event) => onItemDown(event, record));
    world.appendChild(el);
  }

  viewport.appendChild(world);

  // Fit-to-view action. Quiet text in the site's existing voice (small,
  // lowercase, muted) rather than a toolbar, and it hides itself whenever the
  // camera is already at fit so there's nothing to look at most of the time.
  // Its listeners are wired further down, next to the click gate they interact
  // with.
  const fitButton = document.createElement("button");
  fitButton.type = "button";
  fitButton.className = "gc-fit";
  fitButton.textContent = "fit view";
  viewport.appendChild(fitButton);

  root.appendChild(viewport);

  // ---- camera ----
  // A mutable ref, not reactive state: mutating it never triggers a re-render,
  // only marks the next frame dirty. Entirely separate from item positions.
  const camera = { x: 0, y: 0, scale: 1 };

  // Cached viewport geometry — read on init and resize only, never in a
  // gesture. `origin` is the viewport's offset in client coordinates (0,0 for
  // the current fixed/inset-0 layout, but read rather than assumed).
  const view = { width: 0, height: 0, originX: 0, originY: 0 };
  let fitScale = 1;
  let minScale = 1;
  const bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

  // Gates every gesture. The view switcher turns this off for the duration of
  // a view transition, so panning, zooming, card dragging and navigation can't
  // fight the animation or leave it in a half-finished state.
  let interactive = true;

  function measureViewport() {
    const rect = viewport.getBoundingClientRect();
    // While the canvas is hidden (grid view) the rect is empty. Measuring then
    // would compute a zero fit scale and destroy the saved camera, so keep the
    // last good geometry and re-measure when the view is shown again.
    if (rect.width === 0 || rect.height === 0) return;
    view.width = rect.width;
    view.height = rect.height;
    view.originX = rect.left;
    view.originY = rect.top;

    // Fit-to-view: the smaller of the two ratios, so the whole sheet fits on
    // both axes, with padding for breathing room.
    fitScale =
      Math.min(view.width / WORLD.width, view.height / WORLD.height) *
      FIT_PADDING;
    // Guard the degenerate case of a viewport larger than the sheet.
    if (fitScale > MAX_SCALE) fitScale = MAX_SCALE;
    minScale = fitScale;
    updateBounds();
  }

  // Bounds depend on scale: the sheet's on-screen size is WORLD * scale, so
  // they must be recomputed on every zoom, not just on resize.
  function updateBounds() {
    const sheetW = WORLD.width * camera.scale;
    const sheetH = WORLD.height * camera.scale;

    if (sheetW >= view.width) {
      // Sheet overflows: pan freely across it, with a little slack at the edges.
      bounds.minX = view.width - sheetW - EDGE_SLACK;
      bounds.maxX = EDGE_SLACK;
    } else {
      // Sheet fits: hold it near centred, with the same slack of play, so it
      // can never be pushed off screen.
      const centred = (view.width - sheetW) / 2;
      bounds.minX = centred - EDGE_SLACK;
      bounds.maxX = centred + EDGE_SLACK;
    }

    if (sheetH >= view.height) {
      bounds.minY = view.height - sheetH - EDGE_SLACK;
      bounds.maxY = EDGE_SLACK;
    } else {
      const centred = (view.height - sheetH) / 2;
      bounds.minY = centred - EDGE_SLACK;
      bounds.maxY = centred + EDGE_SLACK;
    }
  }

  function clampCamera() {
    if (camera.x < bounds.minX) camera.x = bounds.minX;
    else if (camera.x > bounds.maxX) camera.x = bounds.maxX;
    if (camera.y < bounds.minY) camera.y = bounds.minY;
    else if (camera.y > bounds.maxY) camera.y = bounds.maxY;
  }

  function clampScale(scale) {
    return scale < minScale ? minScale : scale > MAX_SCALE ? MAX_SCALE : scale;
  }

  // ---- screen ⇄ world ----
  // The whole camera model, in two functions.
  function toWorldX(screenX) {
    return (screenX - camera.x) / camera.scale;
  }

  function toWorldY(screenY) {
    return (screenY - camera.y) / camera.scale;
  }

  // ---- rendering ----
  // Translation is rounded to whole pixels so the composited layer isn't
  // resampled onto a fractional offset (which softens text and fine detail).
  // The camera values themselves stay fractional so velocity and zoom math
  // stay smooth.
  let frame = null;
  const lastCamera = { x: NaN, y: NaN, scale: NaN };
  const dirtyItems = new Set();

  function writeCamera() {
    const x = Math.round(camera.x);
    const y = Math.round(camera.y);
    const scale = camera.scale;
    if (x === lastCamera.x && y === lastCamera.y && scale === lastCamera.scale) {
      return;
    }
    lastCamera.x = x;
    lastCamera.y = y;
    lastCamera.scale = scale;
    // One transform for the entire sheet. transform-origin is 0 0 in CSS, so
    // translate then scale composes as screen = world * scale + camera.
    world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale.toFixed(5)})`;
  }

  // Position and rotation share one transform, composed in CSS from these
  // custom properties, so a move is a transform change and never a reflow.
  function writeItem(record) {
    record.el.style.setProperty("--gc-x", `${Math.round(record.x)}px`);
    record.el.style.setProperty("--gc-y", `${Math.round(record.y)}px`);
  }

  // Pointer handlers call this; several calls in one frame cost one flush.
  function invalidate() {
    if (frame === null) frame = requestAnimationFrame(onFrame);
  }

  function onFrame() {
    frame = null;
    writeCamera();
    if (dirtyItems.size > 0) {
      for (const record of dirtyItems) writeItem(record);
      dirtyItems.clear();
    }
    syncFitButton();
  }

  // ---- zoom ----
  // Anchored on a screen point: whatever world coordinate is under that point
  // stays under it. This is what makes "point at an area and wheel in" work.
  function zoomAt(screenX, screenY, factor) {
    const next = clampScale(camera.scale * factor);
    if (next === camera.scale) return; // already at a limit; don't drift

    // 1. the world coordinate currently beneath the pointer
    const worldX = toWorldX(screenX);
    const worldY = toWorldY(screenY);

    // 2. adopt the new scale, then 3. solve for the camera that puts that same
    //    world coordinate back under the same screen point
    camera.scale = next;
    camera.x = screenX - worldX * next;
    camera.y = screenY - worldY * next;

    updateBounds(); // the sheet's on-screen size just changed
    clampCamera();
    invalidate();
  }

  function fitToView() {
    camera.scale = fitScale;
    camera.x = (view.width - WORLD.width * fitScale) / 2;
    camera.y = (view.height - WORLD.height * fitScale) / 2;
    updateBounds();
    clampCamera();
    invalidate();
    saveNow();
  }

  function isAtFit() {
    return (
      Math.abs(camera.scale - fitScale) < 0.0005 &&
      Math.abs(camera.x - (view.width - WORLD.width * fitScale) / 2) < 1 &&
      Math.abs(camera.y - (view.height - WORLD.height * fitScale) / 2) < 1
    );
  }

  // Toggled from the render frame, but only when the answer actually changes,
  // so this is not a per-frame class write.
  let fitVisible = null;
  function syncFitButton() {
    const shouldShow = !isAtFit();
    if (shouldShow === fitVisible) return;
    fitVisible = shouldShow;
    fitButton.classList.toggle("is-visible", shouldShow);
  }

  // ---- persistence ----
  // Session-scoped only: opening a project and coming back keeps the camera and
  // the composition, but the authored layout is never overwritten.
  let saveTimer = null;

  function saveNow() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      sessionStorage.setItem(
        CAMERA_KEY,
        JSON.stringify({
          x: Math.round(camera.x),
          y: Math.round(camera.y),
          scale: Number(camera.scale.toFixed(5)),
        }),
      );
      // Only moved prints are stored. Untouched ones keep tracking the
      // authored layout, so editing gallery-layout.js still takes effect.
      const moved = {};
      for (const [id, record] of positions) {
        if (record.moved) {
          moved[id] = { x: Math.round(record.x), y: Math.round(record.y) };
        }
      }
      sessionStorage.setItem(POSITIONS_KEY, JSON.stringify(moved));
    } catch {
      /* private mode / quota — position just won't persist */
    }
  }

  // Debounced: a burst of wheel events writes storage once, when it settles,
  // instead of serializing JSON on every tick of the gesture.
  function saveSoon() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, SAVE_IDLE);
  }

  function restoreCamera() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(CAMERA_KEY) || "null");
      if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
        return false;
      }
      // Scale is restored first: bounds depend on it.
      camera.scale = Number.isFinite(saved.scale)
        ? clampScale(saved.scale)
        : camera.scale;
      camera.x = saved.x;
      camera.y = saved.y;
      return true;
    } catch {
      /* corrupt or unavailable storage — fall through to the default view */
      return false;
    }
  }

  function restorePositions() {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(POSITIONS_KEY) || "null");
    } catch {
      return;
    }
    if (!saved || typeof saved !== "object") return;
    for (const [id, value] of Object.entries(saved)) {
      const record = positions.get(id);
      if (!record || !value) continue;
      if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) continue;
      record.x = clampItemX(record, value.x);
      record.y = clampItemY(record, value.y);
      record.tx = record.x;
      record.ty = record.y;
      record.moved = true;
    }
  }

  // ---- first paint ----
  measureViewport();
  if (!restoreCamera()) {
    // Open framed on the title cluster rather than on the sheet's geometric
    // centre: the intro copy is the thing to land on, and on the portrait sheet
    // (where the title sits mid-scroll) centring the sheet would open on empty
    // space instead. Camera bounds still apply, so at fit — where the whole
    // sheet is visible anyway — this settles to essentially the same framing.
    camera.scale =
      fitScale >= INITIAL_MIN_SCALE
        ? clampScale(fitScale * INITIAL_ZOOM)
        : INITIAL_MIN_SCALE;
    // Measured, not assumed, so the cluster is optically centred whatever the
    // copy wraps to. One layout read, at init, before any interaction exists.
    const titleHeight = titleEl.offsetHeight || 200;
    camera.x = view.width / 2 - (TITLE.x + TITLE.width / 2) * camera.scale;
    camera.y = view.height / 2 - (TITLE.y + titleHeight / 2) * camera.scale;
  }
  updateBounds();
  clampCamera();
  writeCamera(); // synchronous, so the sheet is never seen unpositioned
  syncFitButton();

  // ---- momentum (sheet only) ----
  const velocity = { x: 0, y: 0 };
  let glideFrame = null;
  let glideLast = 0;

  function stopGlide() {
    if (glideFrame !== null) cancelAnimationFrame(glideFrame);
    glideFrame = null;
    velocity.x = 0;
    velocity.y = 0;
  }

  function glide(now) {
    const dt = Math.min(now - glideLast, MAX_FRAME_MS);
    glideLast = now;

    // Analytic exponential decay: distance and speed both fall off on the
    // same clock regardless of frame rate or a dropped frame.
    const decay = Math.pow(0.5, dt / MOMENTUM_HALF_LIFE);
    const travel = (MOMENTUM_TAU / 1000) * (1 - decay);

    // Screen space: the camera is what's moving, so this is NOT divided by
    // scale. A flick throws the view the same screen distance at any zoom.
    camera.x += velocity.x * travel;
    camera.y += velocity.y * travel;
    velocity.x *= decay;
    velocity.y *= decay;

    // At an edge the sheet just stops — no bounce, no rubber band.
    if (camera.x <= bounds.minX || camera.x >= bounds.maxX) velocity.x = 0;
    if (camera.y <= bounds.minY || camera.y >= bounds.maxY) velocity.y = 0;
    clampCamera();
    writeCamera();
    syncFitButton();

    if (Math.abs(velocity.x) < MIN_SPEED && Math.abs(velocity.y) < MIN_SPEED) {
      stopGlide();
      setInert(false);
      saveNow();
      return;
    }
    glideFrame = requestAnimationFrame(glide);
  }

  // ---- hover suppression ----
  // While anything is moving, the pointer sweeps across thumbnails and would
  // fire a trail of hover states — visually noisy and pointless, since the
  // cursor isn't deliberately on anything. Dropping pointer-events on the
  // world kills all of it for one class toggle. The print being dragged opts
  // back in via CSS so its own lifted state survives.
  let inert = false;
  function setInert(next) {
    if (inert === next) return;
    inert = next;
    viewport.classList.toggle("gc-inert", next);
  }

  // ---- shared click suppression ----
  // Set by whichever gesture actually moved something. Consumed once, by the
  // capture-phase click listener below, before a link can act on it.
  let suppressClick = false;

  // ---- sheet drag (pan) ----
  const history = []; // trailing pointer samples, for release velocity
  let dragging = false;
  let dragPointer = null;
  let panned = false;
  let startX = 0;
  let startY = 0;
  let startCamX = 0;
  let startCamY = 0;

  viewport.addEventListener("pointerdown", (event) => {
    if (!interactive) return;
    // Reset on every press, not just left-button ones: a stale flag from a
    // previous gesture would otherwise swallow the next middle- or cmd-click.
    suppressClick = false;
    if (event.button !== 0) return;

    stopGlide(); // a new grab interrupts the glide on the same frame
    dragging = true;
    panned = false;
    dragPointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startCamX = camera.x;
    startCamY = camera.y;
    history.length = 0;
    history.push({ x: event.clientX, y: event.clientY, t: event.timeStamp });

    // Capture keeps tracking alive when the pointer leaves the viewport or
    // passes over the nav bar mid-drag.
    viewport.setPointerCapture(event.pointerId);
    // Cursor changes on press, not after the threshold — the sheet should
    // read as grabbed the instant it's touched.
    viewport.classList.add("gc-grabbing");
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== dragPointer) return;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!panned && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      panned = true;
      setInert(true); // stop hover chatter once this is definitely a pan
    }

    // Screen space, deliberately NOT divided by scale: the camera is moving,
    // not the sheet, so 100px of hand always moves the view 100px on screen.
    // 1:1 against the original grab point, so it never drifts over a long drag.
    camera.x = startCamX + dx;
    camera.y = startCamY + dy;
    clampCamera();
    invalidate();

    history.push({ x: event.clientX, y: event.clientY, t: event.timeStamp });
    while (
      history.length > 2 &&
      event.timeStamp - history[0].t > HISTORY_WINDOW
    ) {
      history.shift();
    }
  });

  function endSheetDrag(event) {
    if (!dragging || (dragPointer !== null && event.pointerId !== dragPointer)) {
      return;
    }
    dragging = false;
    dragPointer = null;
    viewport.classList.remove("gc-grabbing");
    if (panned) suppressClick = true;

    if (!panned || reducedMotion.matches) {
      setInert(false);
      saveNow();
      return;
    }

    // Only samples still fresh at release count. Drag, hold still, release →
    // the window is empty and the sheet stays exactly where it was put.
    let first = null;
    let last = null;
    for (const sample of history) {
      if (event.timeStamp - sample.t <= VELOCITY_WINDOW) {
        if (first === null) first = sample;
        last = sample;
      }
    }

    const dt = first && last ? last.t - first.t : 0;
    if (dt >= 8) {
      velocity.x = clamp(((last.x - first.x) / dt) * 1000, MAX_SPEED);
      velocity.y = clamp(((last.y - first.y) / dt) * 1000, MAX_SPEED);
      if (
        Math.abs(velocity.x) >= MIN_SPEED ||
        Math.abs(velocity.y) >= MIN_SPEED
      ) {
        glideLast = performance.now();
        glideFrame = requestAnimationFrame(glide);
        return; // stays inert until the glide settles
      }
    }

    velocity.x = 0;
    velocity.y = 0;
    setInert(false);
    saveNow();
  }

  viewport.addEventListener("pointerup", endSheetDrag);
  viewport.addEventListener("pointercancel", endSheetDrag);
  // Safety net: if capture is lost (OS gesture, context menu), don't get stuck
  // in a dragging state with a grabbing cursor.
  viewport.addEventListener("lostpointercapture", endSheetDrag);

  // ---- item drag ----
  // One print at a time. `grabX/grabY` is where inside the print the pointer
  // landed, in WORLD units, so the print stays under the pointer instead of
  // snapping its corner to it — and stays correct across zoom levels.
  let itemDrag = null;

  function onItemDown(event, record) {
    if (!interactive) return;
    if (event.button !== 0) return;
    // Stop here: a press on a print must never also start a sheet pan. This is
    // what keeps the two pointer gestures from ever both being live.
    event.stopPropagation();

    suppressClick = false;
    stopGlide();

    itemDrag = {
      record,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // Screen → world, through the camera: divides by scale, so the offset is
      // in sheet units and survives any zoom change.
      grabX: toWorldX(event.clientX) - record.x,
      grabY: toWorldY(event.clientY) - record.y,
      moved: false,
    };

    // Capture on the print itself, so the events keep coming even once the
    // pointer runs off its edge (which it will, immediately, on a fast drag).
    record.el.setPointerCapture(event.pointerId);
    viewport.classList.add("gc-grabbing");
  }

  function onItemMove(event) {
    if (!itemDrag || event.pointerId !== itemDrag.pointerId) return;
    event.stopPropagation();

    const dx = event.clientX - itemDrag.startX;
    const dy = event.clientY - itemDrag.startY;

    // Not a drag until the threshold is cleared — below it, this is still a
    // click in progress and nothing moves at all. The threshold is in screen
    // px on purpose: it's about the hand, not about the sheet.
    if (!itemDrag.moved) {
      if (Math.abs(dx) + Math.abs(dy) <= DRAG_THRESHOLD) return;
      itemDrag.moved = true;
      itemDrag.record.moved = true;
      itemDrag.record.el.classList.add("is-dragging");
      setInert(true);
    }

    // Convert the live pointer position into world space every move rather
    // than accumulating a delta. This is where zoom is handled: at 0.5× a
    // 50px hand movement becomes 100 world px, because toWorld divides by
    // scale. The print therefore stays exactly under the pointer at any zoom.
    //
    // The dragged print is pinned: it takes the pointer's position outright,
    // with no smoothing and no collision displacement of its own.
    const record = itemDrag.record;
    record.tx = clampItemX(record, toWorldX(event.clientX) - itemDrag.grabX);
    record.ty = clampItemY(record, toWorldY(event.clientY) - itemDrag.grabY);
    record.x = record.tx;
    record.y = record.ty;
    dirtyItems.add(record);
    invalidate();
    // Neighbours start yielding only now — after the gesture has been
    // classified as a drag, so a plain click never disturbs the composition.
    startSim();
  }

  function endItemDrag(event) {
    if (!itemDrag || event.pointerId !== itemDrag.pointerId) return;
    event.stopPropagation();

    const { record, moved } = itemDrag;
    itemDrag = null;
    viewport.classList.remove("gc-grabbing");

    if (moved) {
      // No momentum and no snapping: the print stays exactly where it was let
      // go. Suppress the click so releasing over the print doesn't open it.
      record.el.classList.remove("is-dragging");
      suppressClick = true;
      // Neighbours keep relaxing for a moment. Positions are committed and
      // persisted when the relaxation stops — displaced cards keep their new
      // places rather than springing back.
      startSim();
    }
    // Below the threshold nothing moved, so the click runs untouched and the
    // link opens as it always did.
    setInert(false);
  }

  // ---- soft collision ----
  // Runs ONLY while a print is being dragged and briefly after release, then
  // stops dead. There is no ambient physics: at rest the composition is
  // completely stationary.
  let simFrame = null;
  let simDeadline = 0;

  function startSim() {
    simDeadline = 0;
    if (simFrame === null) simFrame = requestAnimationFrame(simStep);
  }

  function stopSim() {
    if (simFrame !== null) cancelAnimationFrame(simFrame);
    simFrame = null;
  }

  // Iterative relaxation over every pair. Axis-aligned boxes only — a card's
  // small authored rotation is deliberately ignored, as is any notion of
  // solving the layout analytically.
  function relax() {
    const cards = [];
    for (const record of positions.values()) {
      if (record.el) cards.push(record);
    }

    let resolving = false;
    for (let pass = 0; pass < SOLVER_ITERATIONS; pass += 1) {
      for (let i = 0; i < cards.length; i += 1) {
        for (let j = i + 1; j < cards.length; j += 1) {
          const a = cards[i];
          const b = cards[j];

          // Padded overlap, so cards begin making room just BEFORE their
          // visible edges meet — a soft field rather than a contact test.
          const overlapX =
            Math.min(a.tx + a.width, b.tx + b.width) -
            Math.max(a.tx, b.tx) +
            COLLISION_PADDING;
          if (overlapX <= 0) continue;
          const overlapY =
            Math.min(a.ty + a.height, b.ty + b.height) -
            Math.max(a.ty, b.ty) +
            COLLISION_PADDING;
          if (overlapY <= 0) continue;

          // Separate along the cheaper axis (the minimum translation), in the
          // direction set by the two centres. The push is proportional to
          // depth — a graze nudges, a deep overlap moves decisively — and only
          // a fraction lands per pass, which is what makes neighbours glide
          // instead of jump.
          const horizontal = overlapX < overlapY;
          const push = (horizontal ? overlapX : overlapY) * COLLISION_STRENGTH;
          if (push < MIN_PUSH) continue;

          const aCentre = horizontal ? a.tx + a.width / 2 : a.ty + a.height / 2;
          const bCentre = horizontal ? b.tx + b.width / 2 : b.ty + b.height / 2;
          const direction = aCentre <= bCentre ? -1 : 1;

          // The dragged print never yields: the whole correction goes to the
          // other card. Between two free cards it is split, which is what lets
          // displacement propagate along a chain instead of piling up.
          const aPinned = itemDrag !== null && itemDrag.record === a;
          const bPinned = itemDrag !== null && itemDrag.record === b;
          const aShare = aPinned ? 0 : bPinned ? 1 : 0.5;
          const bShare = bPinned ? 0 : aPinned ? 1 : 0.5;

          if (aShare > 0) {
            nudge(a, horizontal, direction * push * aShare);
            resolving = true;
          }
          if (bShare > 0) {
            nudge(b, horizontal, -direction * push * bShare);
            resolving = true;
          }
        }
      }
    }
    return resolving;
  }

  function nudge(record, horizontal, amount) {
    if (horizontal) record.tx = clampItemX(record, record.tx + amount);
    else record.ty = clampItemY(record, record.ty + amount);
    // A card that yielded keeps its new place: this is a genuine rearrangement,
    // so it persists exactly like a hand-dragged one.
    record.moved = true;
  }

  // Ease rendered positions toward their targets, so nothing teleports. The
  // dragged card is exempt — it is already exactly where the pointer put it.
  function integrate() {
    let moving = false;
    for (const record of positions.values()) {
      if (!record.el) continue;
      if (itemDrag !== null && itemDrag.record === record) continue;

      const dx = record.tx - record.x;
      const dy = record.ty - record.y;
      if (Math.abs(dx) < SETTLE_THRESHOLD && Math.abs(dy) < SETTLE_THRESHOLD) {
        if (dx !== 0 || dy !== 0) {
          record.x = record.tx;
          record.y = record.ty;
          writeItem(record);
        }
        continue;
      }
      // Asymptotic ease: approaches the target without ever overshooting it,
      // so there is no bounce and no spring.
      record.x += dx * POSITION_SMOOTHING;
      record.y += dy * POSITION_SMOOTHING;
      writeItem(record);
      moving = true;
    }
    return moving;
  }

  function simStep(now) {
    simFrame = null;
    const resolving = relax();
    const moving = integrate();

    if (itemDrag !== null) {
      simFrame = requestAnimationFrame(simStep);
      return;
    }
    // Released: keep relaxing briefly so neighbours settle, with a hard cap so
    // a genuinely unresolvable cluster — everything jammed against a world
    // edge — cannot run forever.
    if (simDeadline === 0) simDeadline = now + SETTLE_TIMEOUT;
    if ((resolving || moving) && now < simDeadline) {
      simFrame = requestAnimationFrame(simStep);
      return;
    }
    commitPositions();
    stopSim();
    saveNow();
  }

  // Clear any sub-threshold remainder so nothing is left mid-ease. After this
  // the arrangement is final, stationary, and saved.
  function commitPositions() {
    for (const record of positions.values()) {
      if (!record.el) continue;
      if (record.x === record.tx && record.y === record.ty) continue;
      record.x = record.tx;
      record.y = record.ty;
      writeItem(record);
    }
  }

  for (const record of positions.values()) {
    if (!record.el) continue;
    record.el.addEventListener("pointermove", onItemMove);
    record.el.addEventListener("pointerup", endItemDrag);
    record.el.addEventListener("pointercancel", endItemDrag);
    record.el.addEventListener("lostpointercapture", endItemDrag);
  }

  // ---- click gating ----
  // Capture phase on the viewport: runs before the link's default action, for
  // both gestures, and is consumed once.
  viewport.addEventListener(
    "click",
    (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  // Native link/image dragging would fight both gestures.
  world.addEventListener("dragstart", (event) => event.preventDefault());

  // ---- fit-to-view action ----
  // Wired here because it has to cooperate with the click gate above. The
  // pointerdown does two jobs, and both are load-bearing:
  //   - stopPropagation, so pressing the control never starts a sheet pan
  //   - clearing suppressClick, exactly as the viewport's own pointerdown does
  // Without the second, a pan whose click never landed (drag released off the
  // window, or a pointercancel) leaves the flag set, and the gate then eats
  // this button's click instead.
  fitButton.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    suppressClick = false;
  });
  fitButton.addEventListener("click", (event) => {
    event.stopPropagation();
    fitToView();
  });

  // ---- wheel / trackpad → zoom ----
  // Non-passive, because preventDefault is required: the wheel now drives the
  // camera, and the page must not scroll underneath it.
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (!interactive) return;
      // The camera holds still while a print is in hand, so the print can't
      // slide out from under the pointer mid-drag.
      if (itemDrag) return;

      stopGlide();

      const unit =
        event.deltaMode === 1
          ? WHEEL_LINE
          : event.deltaMode === 2
            ? view.height * WHEEL_PAGE_FACTOR
            : 1;
      const delta = event.deltaY * unit;

      // Exponential, so zoom is uniform: the same gesture changes the view by
      // the same proportion whether you're at 0.4× or 2×. Negative delta
      // (scroll up) magnifies.
      const sensitivity = event.ctrlKey
        ? PINCH_ZOOM_SENSITIVITY
        : WHEEL_ZOOM_SENSITIVITY;
      let factor = Math.exp(-delta * sensitivity);
      if (factor < MIN_ZOOM_STEP) factor = MIN_ZOOM_STEP;
      else if (factor > MAX_ZOOM_STEP) factor = MAX_ZOOM_STEP;

      // Pointer position inside the viewport, from cached geometry — no layout
      // read per wheel event.
      zoomAt(
        event.clientX - view.originX,
        event.clientY - view.originY,
        factor,
      );
      saveSoon();
    },
    { passive: false },
  );

  // ---- viewport changes ----
  // Re-measure only here. A smaller window can raise the fit floor, so the
  // scale may need pulling up before the camera is re-clamped.
  window.addEventListener("resize", () => {
    measureViewport();
    const clamped = clampScale(camera.scale);
    if (clamped !== camera.scale) {
      // Keep the viewport centre fixed while the floor pushes the zoom in.
      zoomAt(view.width / 2, view.height / 2, clamped / camera.scale);
    }
    updateBounds();
    clampCamera();
    invalidate();
  });

  // Persist on the way out. pagehide covers back/forward cache; the
  // visibilitychange fallback covers mobile Safari, where pagehide is
  // unreliable when the app is backgrounded.
  window.addEventListener("pagehide", saveNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveNow();
  });

  // ---- controller ----
  // What the view switcher needs, and nothing more. The camera and the
  // position map stay private: they are only ever exposed as resolved
  // screen-space geometry, which is the only thing a transition can use.
  return {
    element: viewport,

    // Screen-space geometry of every thumbnail as it is rendered right now,
    // through the live camera. Works as the SOURCE when leaving the canvas and
    // as the TARGET when returning to it — returning simply reads the same
    // preserved camera and positions, which is why the round trip lands
    // exactly where the user left off.
    //
    // Requires the viewport to be displayed (not display:none); visibility:
    // hidden is fine, so cards can already be masked for the handoff.
    getGeometry() {
      const out = new Map();
      for (const [id, record] of positions) {
        if (!record.el) continue;
        const thumb = record.el.querySelector(".gc-thumb");
        const img = record.el.querySelector(".gc-img");
        if (!thumb) continue;

        // getBoundingClientRect returns the axis-aligned box of the ROTATED
        // element, so its width/height are inflated — but its centre is exactly
        // the rotated element's centre, whatever the rotation or its pivot.
        // So take the centre from the rect and the true size from layout.
        const rect = thumb.getBoundingClientRect();
        out.set(id, {
          centerX: rect.left + rect.width / 2,
          centerY: rect.top + rect.height / 2,
          // offsetWidth/Height are layout values, unaffected by the camera
          // transform, so the on-screen size is simply layout × scale.
          width: thumb.offsetWidth * camera.scale,
          height: thumb.offsetHeight * camera.scale,
          rotation: record.rotation,
          // The image's natural aspect, which the canvas thumb also uses. The
          // flyer needs it to reproduce `cover` cropping at both ends.
          aspect: record.ratio,
          image: img ? img.currentSrc || img.src : "",
          // Must match .gc-thumb's border-radius, which matches the grid's.
          radius: 12,
        });
      }
      return out;
    },

    // Re-measure after being shown again, or after a resize that happened
    // while hidden (when the rect was empty and measuring was skipped).
    remeasure() {
      measureViewport();
      updateBounds();
      clampCamera();
      writeCamera();
      syncFitButton();
    },

    setInteractive(next) {
      interactive = next;
      if (!next) {
        stopGlide();
        // Land any in-flight settling before handing off, so the view
        // transition measures final positions rather than mid-ease ones.
        commitPositions();
        stopSim();
      }
    },

    save: saveNow,
  };
}

// A moved print stays wholly inside the world, because the camera is bounded
// to the sheet — a print dropped beyond the edge could never be reached again.
// This is a bound, not snapping: within the world nothing is quantized.
function clampItemX(record, x) {
  const max = WORLD.width - record.width;
  return x < 0 ? 0 : x > max ? max : x;
}

function clampItemY(record, y) {
  const max = WORLD.height - record.height;
  return y < 0 ? 0 : y > max ? max : y;
}

function clamp(value, limit) {
  return value > limit ? limit : value < -limit ? -limit : value;
}

function buildTitle() {
  const el = document.createElement("div");
  el.className = "gc-object gc-title";
  el.style.setProperty("--gc-x", `${TITLE.x}px`);
  el.style.setProperty("--gc-y", `${TITLE.y}px`);
  el.style.setProperty("--gc-rotation", `${TITLE.rotation}deg`);
  el.style.width = `${TITLE.width}px`;
  el.style.zIndex = String(TITLE.zIndex);
  el.innerHTML = `
    <h1 class="gc-title-heading">Gallery</h1>
    <p class="gc-title-text">
      Interactive sketches, generative work &amp; visual experiments.
      Scroll to zoom, drag to look around, drag a print to move it.
    </p>
  `;
  return el;
}

function buildItem(item, record) {
  const el = document.createElement("a");
  el.className = "gc-object gc-item";
  el.href = item.path;
  el.target = item.window || item.path;
  el.draggable = false;

  el.style.width = `${record.width}px`;
  el.style.zIndex = String(record.zIndex);
  // Rotation is authored and never touched by a drag. Position is written into
  // the same transform (see writeItem), so moving a print never reflows.
  el.style.setProperty("--gc-rotation", `${record.rotation}deg`);

  // The frame is sized from the ratio in CSS, so the box is final before the
  // image arrives: nothing reflows or shifts on load, and the composition is
  // correct on the first frame.
  const frame = document.createElement("div");
  frame.className = "gc-thumb";
  frame.style.aspectRatio = String(record.ratio);

  const img = document.createElement("img");
  img.className = "gc-img";
  img.src = item.thumb;
  img.alt = ""; // decorative: the caption already names the project
  img.draggable = false;
  img.decoding = "async";
  // Eager, not lazy: items start outside the viewport in world space, so lazy
  // loading would leave them blank until panned to and pop in mid-gesture.
  img.loading = "eager";

  // Fade from the placeholder tone only if the image wasn't already cached —
  // a cached thumbnail appears immediately with no animation at all.
  if (img.complete) {
    img.classList.add("is-loaded");
  } else {
    img.addEventListener("load", () => img.classList.add("is-loaded"), {
      once: true,
    });
    img.addEventListener("error", () => img.classList.add("is-loaded"), {
      once: true,
    });
  }

  frame.appendChild(img);

  const caption = document.createElement("div");
  caption.className = "gc-caption";
  caption.textContent = item.title;

  el.appendChild(frame);
  el.appendChild(caption);

  // The description, revealed by hovering the caption. Omitted entirely when
  // the project has no desc (panel), rather than rendering an empty node.
  // Must directly follow the caption: the CSS reveals it with an adjacent
  // sibling selector.
  if (item.desc) {
    const desc = document.createElement("div");
    desc.className = "gc-desc";
    desc.textContent = item.desc;
    el.appendChild(desc);
  }
  return el;
}
