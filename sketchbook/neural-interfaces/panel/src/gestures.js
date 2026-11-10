// src/gestures.js
//
// Touchless filter-switching gestures for the panel lens. The panel is already
// corner-pinned by both hands (index tip = top, thumb tip = bottom), so these
// detectors are designed to layer on top without fighting that pose — the user
// picks one live via the toggle UI (see main.js) and we later keep the winner.
//
// createGestureController() owns the active mode + per-detector state. Feed it
// per-frame input via update({ landmarks, faceRoll, now }); it returns a switch
// direction (+1 next / -1 prev / 0 none) with debounce and hysteresis baked in
// so a single gesture fires exactly once. getFeedback() exposes light state for
// the on-canvas indicator (mode name + fire flash).

// --- tuning -----------------------------------------------------------------
const COOLDOWN_MS = 700;   // min gap between two fires (any mode)
const FLASH_MS = 350;      // how long the "switched!" flash stays lit

const PINCH_ON = 0.35;     // index↔thumb / handSize below this → pinched
const PINCH_OFF = 0.5;     // must rise above this before it can re-fire

const TILT_ON = 0.26;      // |roll| in radians (~15°) → tilt fires
const TILT_OFF = 0.12;     // must return inside this (~7°) before re-firing

// --- landmark helpers (raw normalized MediaPipe space) ----------------------
const WRIST = 0;
const MIDDLE_MCP = 9;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Scale reference so thresholds are hand-distance-invariant.
function handSize(lm) {
  return dist(lm[WRIST], lm[MIDDLE_MCP]) || 1e-6;
}

// --- controller -------------------------------------------------------------
export function createGestureController() {
  let mode = "off";

  // Per-detector "armed" latches (edge/hysteresis).
  let pinchArmed = true;      // false while still pinched, until released
  let tiltArmed = true;       // false while still tilted, until near-neutral

  let lastFire = -1e9;        // last successful switch time
  let flashUntil = -1e9;      // flash lit until this time

  function reset() {
    pinchArmed = true;
    tiltArmed = true;
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    reset(); // never carry a half-finished dwell/latch across modes
  }

  // Returns +1 / -1 / 0. `dir` lets a detector choose direction (default +1).
  function fire(now, dir = 1) {
    if (now - lastFire < COOLDOWN_MS) return 0;
    lastFire = now;
    flashUntil = now + FLASH_MS;
    return dir;
  }

  // --- individual detectors; each returns +1/-1/0 ---------------------------
  function detectPinch(hands, now) {
    // Fire if ANY hand is pinched; require every hand released to re-arm.
    let anyPinched = false;
    for (const lm of hands) {
      if (dist(lm[4], lm[8]) / handSize(lm) < PINCH_ON) anyPinched = true;
    }
    const allReleased = hands.every(
      (lm) => dist(lm[4], lm[8]) / handSize(lm) > PINCH_OFF
    );
    if (allReleased) pinchArmed = true;
    if (anyPinched && pinchArmed) {
      pinchArmed = false;
      return fire(now, 1);
    }
    return 0;
  }

  function detectHeadTilt(faceRoll, now) {
    if (faceRoll == null) return 0;
    const mag = Math.abs(faceRoll);
    if (mag < TILT_OFF) tiltArmed = true;
    if (mag > TILT_ON && tiltArmed) {
      tiltArmed = false;
      // Mirrored selfie view: tilting head to the user's right yields one sign;
      // map that to "next", the other to "prev".
      return fire(now, faceRoll > 0 ? 1 : -1);
    }
    return 0;
  }

  function update({ landmarks, faceRoll, now }) {
    const hands = landmarks || [];
    switch (mode) {
      case "pinch":
        return hands.length ? detectPinch(hands, now) : 0;
      case "head-tilt":
        return detectHeadTilt(faceRoll, now);
      default:
        return 0; // "off"
    }
  }

  function getFeedback(now) {
    return {
      mode,
      dwell: 0,
      flash: now < flashUntil ? (flashUntil - now) / FLASH_MS : 0,
    };
  }

  return { setMode, update, getFeedback, getMode: () => mode };
}

// Modes exposed by the toggle UI, in display order. "head-tilt" is implemented
// (detectHeadTilt + faceTracking.js) but parked out of the UI for now — add it
// back here to re-enable it.
export const GESTURE_MODES = ["off", "pinch"];
