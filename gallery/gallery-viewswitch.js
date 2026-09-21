// View switcher: a shared-element (FLIP) transition between the grid and the
// spatial canvas.
//
// The two views are separate renderers with genuinely different card markup —
// the grid card has a description and tags and crops its thumbnail to a fixed
// 16/10; the canvas card is a caption under the image at the image's own
// aspect, rotated, inside a panned and zoomed sheet. They cannot share DOM
// nodes without rebuilding one of them, so this uses the overlay approach:
// measure both ends, mask the real cards, fly visual copies between the
// measured rectangles, then hand off.
//
// Card identity is the project id. A card's source rect and target rect are
// always looked up by the same id, so project X always flies to project X's
// slot — never "some card into some slot".
//
// Why FLIP rather than an automatic layout animation: the canvas cards are
// inside an ancestor carrying `translate3d(...) scale(...)`, so their layout
// boxes bear no relation to where they appear. Everything here is therefore
// measured in SCREEN space (getBoundingClientRect / layout × camera scale),
// never in world coordinates.

const DURATION = 720; // ms — editorial pace, within the 600–850 range
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"; // accelerates subtly, settles clean
// A whisper of stagger so the composition reads as one system reorganizing,
// not a cascade. Total spread stays under 30ms across all cards.
const STAGGER_PER_CARD = 3; // ms
const MAX_STAGGER = 30; // ms
const CHROME_FADE = 300; // ms — view-specific labels/controls crossfade
const VIEW_KEY = "gallery:view";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export function initViewSwitch({ gridEl, canvas, initialView }) {
  const html = document.documentElement;
  const body = document.body;

  let view = readSavedView() || initialView;
  // The view the toggle's label reflects. It leads `view`: the label flips the
  // instant the user commits, not when the flight lands, so the control never
  // feels like it lagged the click.
  let labelView = view;
  let transitioning = false;
  // The grid is a normally-scrolling document; the canvas locks scrolling. The
  // scroll offset has to be stashed by hand, or returning to the grid would
  // always land at the top.
  let gridScroll = 0;

  // ---- toggle ----
  // One verb in the site's quiet lowercase voice, fixed so it never moves while
  // the composition reorganizes behind it. The label names the ACTION, not the
  // current state, so only the button for the view you are not in is shown.
  const LABELS = { grid: "tidy up 𓀧", canvas: "unstack 𓃠" };
  const toggle = document.createElement("div");
  toggle.className = "gv-toggle";
  const buttons = new Map();
  for (const name of ["grid", "canvas"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gv-toggle-option";
    button.textContent = LABELS[name];
    button.addEventListener("click", () => switchTo(name));
    buttons.set(name, button);
    toggle.appendChild(button);
  }
  body.appendChild(toggle);

  function syncToggle() {
    for (const [name, button] of buttons) {
      // Keyed to `labelView`, not `view` — see above.
      button.hidden = name === labelView;
      // Repeated toggling mid-flight is what produces broken intermediate
      // states, so the control is genuinely disabled, not just ignored. It is
      // not dimmed while disabled: the label has already flipped, and fading it
      // for the length of the flight would put the lag straight back.
      button.disabled = transitioning;
    }
  }

  // ---- static view application (no animation) ----
  function applyCanvasView() {
    html.classList.add("gc-active");
    body.classList.add("gc-active");
    gridEl.classList.add("is-hidden");
    canvas.element.classList.remove("is-hidden");
    canvas.remeasure();
    canvas.setInteractive(true);
  }

  function applyGridView() {
    html.classList.remove("gc-active");
    body.classList.remove("gc-active");
    canvas.element.classList.add("is-hidden");
    canvas.setInteractive(false);
    gridEl.classList.remove("is-hidden");
  }

  // ---- initial state ----
  if (view === "canvas") applyCanvasView();
  else applyGridView();
  syncToggle();

  // ---- the transition ----
  function switchTo(next) {
    if (transitioning || next === view) return;
    transitioning = true;
    labelView = next;
    syncToggle();

    canvas.setInteractive(false);
    // Cards must not be clickable mid-flight in either view.
    body.classList.add("gv-transitioning");

    const toCanvas = next === "canvas";
    let source;
    let target;

    if (toCanvas) {
      gridScroll = window.scrollY;
      source = measureGrid();
      // Show the canvas so its geometry can be measured, but do NOT apply
      // gc-active yet: that locks document scrolling, which would snap the
      // still-visible grid to the top mid-transition.
      canvas.element.classList.remove("is-hidden");
      canvas.remeasure();
      // Target = the canvas's own live geometry, i.e. the preserved camera and
      // the preserved (possibly user-moved) card positions.
      target = canvas.getGeometry();
    } else {
      source = canvas.getGeometry();
      // Release scroll lock and reveal the grid so it can be laid out and
      // measured at the scroll offset it will actually appear at.
      html.classList.remove("gc-active");
      body.classList.remove("gc-active");
      gridEl.classList.remove("is-hidden");
      window.scrollTo(0, gridScroll);
      target = measureGrid();
    }

    // Mask the real cards at both ends; only the flying copies are visible.
    canvas.element.classList.add("gc-items-hidden");
    gridEl.classList.add("is-cards-hidden");
    // View-specific chrome (page heading, section labels, canvas title cluster,
    // fit-view control) crossfades. It never flies.
    canvas.element.classList.toggle("gc-chrome-out", !toCanvas);
    body.classList.toggle("gv-grid-chrome-out", toCanvas);

    if (reducedMotion.matches) {
      // Reduced motion: no flight. The views still swap, and the chrome still
      // crossfades, but nothing travels across the screen.
      finish(next, toCanvas);
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = "gv-overlay";
    const flyers = [];
    let index = 0;
    for (const [id, from] of source) {
      const to = target.get(id);
      if (!to) continue; // present in one view only — it just crossfades
      flyers.push(buildFlyer(from, to, Math.min(index * STAGGER_PER_CARD, MAX_STAGGER)));
      index += 1;
    }
    for (const flyer of flyers) overlay.appendChild(flyer.el);
    body.appendChild(overlay);

    // Force the browser to accept the FIRST state before we set the LAST one,
    // otherwise both are collapsed into one style resolution and nothing
    // animates. Reading offsetWidth is the flush.
    void overlay.offsetWidth;

    for (const flyer of flyers) flyer.play();

    // A timer rather than transitionend: with staggered starts and two
    // transitioned elements per card, "which event is last" is fragile, and a
    // dropped transitionend would leave the overlay stuck on screen forever.
    window.setTimeout(
      () => {
        overlay.remove();
        finish(next, toCanvas);
      },
      DURATION + MAX_STAGGER + 40,
    );
  }

  function finish(next, toCanvas) {
    if (toCanvas) {
      // Apply the scroll lock now: the grid is about to be hidden, so the
      // scroll reset it causes is invisible.
      html.classList.add("gc-active");
      body.classList.add("gc-active");
      gridEl.classList.add("is-hidden");
      canvas.remeasure();
    } else {
      canvas.element.classList.add("is-hidden");
    }

    canvas.element.classList.remove("gc-items-hidden", "gc-chrome-out");
    gridEl.classList.remove("is-cards-hidden");
    body.classList.remove("gv-grid-chrome-out", "gv-transitioning");

    view = next;
    labelView = next; // already flipped at click time; kept in step defensively
    saveView(view);
    canvas.setInteractive(toCanvas);
    transitioning = false;
    syncToggle();
  }

  // ---- grid geometry ----
  // Grid cards are never rotated, so their bounding rect is exact.
  function measureGrid() {
    const out = new Map();
    for (const card of gridEl.querySelectorAll("[data-project-id]")) {
      const thumb = card.querySelector(".nm-thumb");
      if (!thumb) continue;
      const rect = thumb.getBoundingClientRect();
      out.set(card.dataset.projectId, {
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        rotation: 0, // entering the grid, cards settle square
        aspect: Number(card.dataset.aspect) || rect.width / rect.height,
        image: card.dataset.thumb || "",
        radius: 12,
      });
    }
    return out;
  }

  // Keep the canvas honest about viewport size even while it is hidden.
  window.addEventListener("resize", () => {
    if (transitioning) return;
    if (view === "grid") gridScroll = window.scrollY;
  });
}

// ---- flyer ----
// Two nested elements, and the reason for both is the aspect-ratio mismatch:
// the grid crops every thumbnail to 16/10 while the canvas shows it at its
// natural ratio. Interpolating the box therefore needs a NON-uniform scale —
// which would visibly squash the image, worst of all exactly at the handoff.
//
//   outer  the crop window. Sized to the source box, scaled non-uniformly to
//          the target box. Clips.
//   inner  the image. Sized to its `cover` box over the source rect, and
//          counter-scaled by (k/sx, k/sy) so that after the outer's scale its
//          rendered scale is uniform (k) — no distortion at any point, and at
//          both ends it is exactly the `cover` crop each view would paint.
function buildFlyer(from, to, delay) {
  const el = document.createElement("div");
  el.className = "gv-fly";
  el.style.width = `${from.width}px`;
  el.style.height = `${from.height}px`;

  const inner = document.createElement("div");
  inner.className = "gv-fly-image";
  // Same URL both views already used, so this is a memory-cache hit and the
  // thumbnail never reloads or flashes across the handoff.
  inner.style.backgroundImage = `url('${from.image || to.image}')`;

  // `cover` geometry of the natural-aspect image over each end's box.
  const aspect = from.aspect || to.aspect || from.width / from.height;
  const coverFrom = coverBox(from.width, from.height, aspect);
  const coverTo = coverBox(to.width, to.height, aspect);
  // The inner is laid out at the source cover size and stretched to fill it
  // exactly (it already matches the image's aspect, so nothing is distorted).
  inner.style.width = `${coverFrom.width}px`;
  inner.style.height = `${coverFrom.height}px`;
  inner.style.marginLeft = `${-coverFrom.width / 2}px`;
  inner.style.marginTop = `${-coverFrom.height / 2}px`;

  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  // One uniform factor takes the image from its source cover size to its
  // target cover size; both boxes share the image's aspect, so this is exact.
  const k = coverTo.width / coverFrom.width;

  el.appendChild(inner);

  // FIRST — positioned by centre, because a rotated element's centre is the
  // only point that is unambiguous (see getGeometry).
  const place = (g) => `translate3d(${g.centerX - from.width / 2}px, ${g.centerY - from.height / 2}px, 0)`;
  const first = `${place(from)} rotate(${from.rotation}deg) scale(1, 1)`;
  el.style.transform = first;
  el.style.borderRadius = `${from.radius}px`;
  inner.style.transform = "scale(1, 1)";
  // Kept because style.transform is about to be overwritten with the LAST
  // state: without this the origin of a flight is unrecoverable when debugging
  // (or asserting) a mid-air frame.
  el.dataset.flipFrom = first;

  return {
    el,
    // LAST — same transform function list in the same order, so the browser
    // interpolates component-wise instead of decomposing matrices.
    play() {
      el.style.transition = `transform ${DURATION}ms ${EASE} ${delay}ms, border-radius ${DURATION}ms ${EASE} ${delay}ms`;
      inner.style.transition = `transform ${DURATION}ms ${EASE} ${delay}ms`;
      el.style.transform = `${place(to)} rotate(${to.rotation}deg) scale(${scaleX}, ${scaleY})`;
      el.style.borderRadius = `${to.radius}px`;
      inner.style.transform = `scale(${k / scaleX}, ${k / scaleY})`;
    },
  };
}

// The size an image of the given aspect must be to cover a box, centred —
// i.e. what `background-size: cover` resolves to.
function coverBox(boxWidth, boxHeight, aspect) {
  return boxWidth / boxHeight >= aspect
    ? { width: boxWidth, height: boxWidth / aspect }
    : { width: boxHeight * aspect, height: boxHeight };
}

function readSavedView() {
  try {
    const saved = sessionStorage.getItem(VIEW_KEY);
    return saved === "grid" || saved === "canvas" ? saved : null;
  } catch {
    return null;
  }
}

function saveView(view) {
  try {
    sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    /* private mode — the choice just won't survive navigation */
  }
}
