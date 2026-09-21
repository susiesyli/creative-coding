// src/main.js
//
// Orchestrator: wires hand tracking to the renderer and owns all temporal
// behavior — smoothing, the one-hand hold, and the hands-lost fade. The render
// loop runs at 60fps and eases toward the latest MediaPipe targets (~30fps),
// which both decouples the rates and removes landmark jitter.
//
// Debug mode (landmark + corner overlay) is toggled with the `d` key or the
// `?debug=true` URL parameter.

import { setupHandTracking } from "./handTracking.js";
import { setupFaceTracking } from "./faceTracking.js";
import { createPanel } from "./panel.js";
import { createGestureController, GESTURE_MODES } from "./gestures.js";

// Resting quad the panel eases toward before the first hands appear (RAW
// normalized space; symmetric, so mirroring leaves it centered).
const DEFAULT_CORNERS = {
  tl: { x: 0.32, y: 0.3 },
  tr: { x: 0.68, y: 0.3 },
  br: { x: 0.68, y: 0.7 },
  bl: { x: 0.32, y: 0.7 },
};

// Tuning. Smoothing is time-based (see tick) so it feels identical regardless
// of frame rate; these lambdas are the per-second rates.
const CORNER_LAMBDA = 17;   // corner smoothing (higher = snappier)
const HOLD_MS = 600;        // keep a side's last corners this long after it drops
const FADE_IN_LAMBDA = 48;  // panel opacity rise rate when hands present
const FADE_OUT_LAMBDA = 45; // fade rate when hands are lost

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

// Last-known corners + timestamp per side. Updated by the tracker callback;
// availability (within HOLD_MS) is judged in the render loop.
const side = {
  left: { top: null, bottom: null, lastSeen: -1e9 },
  right: { top: null, bottom: null, lastSeen: -1e9 },
};

let current = clone(DEFAULT_CORNERS); // smoothed corners actually rendered
let opacity = 0;                      // panel global alpha (fade)
let landmarks = [];                   // latest raw hands, for debug overlay
let faceRoll = null;                  // latest head roll (radians), head-tilt mode

const video = document.getElementById("webcam");
const panel = createPanel(document.getElementById("panel"), video);
const gestures = createGestureController();
window.addEventListener("resize", panel.resize);

setupHandTracking((state) => {
  const now = performance.now();
  landmarks = state.landmarks || [];
  if (state.left) {
    side.left.top = state.left.top;
    side.left.bottom = state.left.bottom;
    side.left.lastSeen = now;
  }
  if (state.right) {
    side.right.top = state.right.top;
    side.right.bottom = state.right.bottom;
    side.right.lastSeen = now;
  }
}, (w, h) => {
  // Show the actual capture resolution in the debug overlay.
  const el = document.getElementById("camres");
  if (el) el.textContent = `${w}×${h}`;
});

// --- controls ---
// Cycle the lens filter with the `f` key OR by clicking the canvas (clicks
// reach the page even in embedded/preview browsers that swallow key events).
// `d` cycles the debug overlay through 3 levels:
//   0 = clean (no outline, no hand tracker)
//   1 = white panel outline only
//   2 = outline + hand-tracker landmarks
let debug = new URLSearchParams(location.search).get("debug") === "true" ? 2 : 0;
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "d") debug = (debug + 1) % 3;
  if (k === "f") switchFilter(panel.nextFilter());
});
document.getElementById("panel").addEventListener("pointerdown", () => {
  switchFilter(panel.nextFilter());
});

// On-screen confirmation of the filter the user just switched to — the change
// happens on the actual causal event, and is visible, not console-only (§13).
const toastEl = document.getElementById("filter-toast");
let toastTimer = null;
function switchFilter(name) {
  if (!name) return;
  console.log("filter →", name);
  if (navigator.vibrate) navigator.vibrate(10); // haptic on the switch (§13)
  if (!toastEl) return;
  toastEl.textContent = name;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 900);
}

// Fade the how-to hint out the first time both hands place the panel.
const hintEl = document.getElementById("hint");
let hintDismissed = false;
function dismissHint() {
  if (hintDismissed || !hintEl) return;
  hintDismissed = true;
  hintEl.classList.add("dismissed");
}

// --- gesture switching ---
// Locked to pinch for now. The full A/B toggle (pinch + head-tilt buttons) is
// kept behind SHOW_GESTURE_UI — flip it to true to bring the picker back.
const SHOW_GESTURE_UI = false;

let faceStarted = false;
function selectGestureMode(mode) {
  gestures.setMode(mode);
  if (mode === "head-tilt" && !faceStarted) {
    faceStarted = true;
    setupFaceTracking((roll) => (faceRoll = roll)).catch((err) =>
      console.error("FaceMesh init failed:", err)
    );
  }
  if (ui) {
    for (const btn of ui.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
  }
}

const ui = document.getElementById("gesture-ui");
if (ui && SHOW_GESTURE_UI) {
  for (const mode of GESTURE_MODES) {
    const btn = document.createElement("button");
    btn.textContent = mode;
    btn.dataset.mode = mode;
    // pointerdown, not click — the canvas also listens on pointerdown to cycle
    // filters; stop it so tapping a mode button doesn't also advance the filter.
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      selectGestureMode(mode);
    });
    ui.appendChild(btn);
  }
} else if (ui) {
  ui.style.display = "none";
}
selectGestureMode("pinch"); // active gesture

let lastTick = null;
function tick(timeMs) {
  const now = performance.now();
  // Frame-rate-independent smoothing: convert per-second lambdas to this
  // frame's blend factor. Clamp dt so a background-tab stall doesn't jump.
  const dt = lastTick === null ? 1 / 60 : Math.min((timeMs - lastTick) / 1000, 0.1);
  lastTick = timeMs;
  const cornerK = prefersReducedMotion ? 1 : 1 - Math.exp(-CORNER_LAMBDA * dt);
  const fadeInK = prefersReducedMotion ? 1 : 1 - Math.exp(-FADE_IN_LAMBDA * dt);
  const fadeOutK = prefersReducedMotion ? 1 : 1 - Math.exp(-FADE_OUT_LAMBDA * dt);

  const leftOK = now - side.left.lastSeen < HOLD_MS && side.left.top;
  const rightOK = now - side.right.lastSeen < HOLD_MS && side.right.top;

  // Both sides available (live or briefly held) → track them, fade in.
  // Otherwise freeze the last quad and fade out.
  if (leftOK && rightOK) {
    lerpTo("tl", side.left.top, cornerK);
    lerpTo("bl", side.left.bottom, cornerK);
    lerpTo("tr", side.right.top, cornerK);
    lerpTo("br", side.right.bottom, cornerK);
    opacity += (1 - opacity) * fadeInK;
    dismissHint(); // user has clearly engaged
  } else {
    opacity += (0 - opacity) * fadeOutK;
  }

  // Touchless filter switching: the active gesture detector may fire this frame.
  const dir = gestures.update({ landmarks, faceRoll, now });
  if (dir > 0) switchFilter(panel.nextFilter());
  else if (dir < 0) switchFilter(panel.prevFilter());

  panel.render(current, opacity, timeMs, debug, landmarks, gestures.getFeedback(now));
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function lerpTo(key, target, k) {
  current[key].x += (target.x - current[key].x) * k;
  current[key].y += (target.y - current[key].y) * k;
}

function clone(c) {
  return {
    tl: { ...c.tl },
    tr: { ...c.tr },
    br: { ...c.br },
    bl: { ...c.bl },
  };
}
