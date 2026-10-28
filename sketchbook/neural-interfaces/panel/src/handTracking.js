// src/handTracking.js
//
// Owns the webcam stream and MediaPipe Hands. We request the camera directly
// via getUserMedia (1080p preferred, never the browser default) and drive
// MediaPipe from our own frame pump — MediaPipe's Camera helper forces a low
// fixed resolution, which is what made the feed look soft.
//
// It reports, per side, the panel's corner control points plus the raw
// landmark list (for the debug overlay). It does NOT draw or smooth — the
// renderer owns drawing (via one shared display transform) and main.js owns
// smoothing/hold/fade.
//
// Coordinates are RAW normalized MediaPipe space [0..1] (NOT mirrored); the
// renderer applies the mirror + cover-fit transform. Side assignment uses the
// on-screen x (1 - raw.x) so the hand on the left of the screen controls the
// left side. Corner mapping: index fingertip (8) = TOP, thumb tip (4) = BOTTOM.

const INDEX_TIP = 8;
const THUMB_TIP = 4;

/**
 * @param {(state) => void} onUpdate   per-frame hand state (see below)
 * @param {(w:number, h:number) => void} [onResolution]  actual capture size
 */
export function setupHandTracking(onUpdate, onResolution) {
  const videoEl = document.getElementById("webcam");

  const hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7,
  });

  hands.onResults((results) => {
    const list = results.multiHandLandmarks || [];

    // Per hand: raw corner pair + its on-screen x (mirrored) for side sorting.
    const parsed = list.map((lm) => ({
      top: { x: lm[INDEX_TIP].x, y: lm[INDEX_TIP].y },
      bottom: { x: lm[THUMB_TIP].x, y: lm[THUMB_TIP].y },
      screenX: 1 - lm[INDEX_TIP].x,
    }));

    let left = null;
    let right = null;
    if (parsed.length === 1) {
      if (parsed[0].screenX < 0.5) left = parsed[0];
      else right = parsed[0];
    } else if (parsed.length >= 2) {
      const sorted = parsed.sort((a, b) => a.screenX - b.screenX);
      left = sorted[0];
      right = sorted[sorted.length - 1];
    }

    onUpdate({
      left: left && { top: left.top, bottom: left.bottom },
      right: right && { top: right.top, bottom: right.bottom },
      landmarks: list,
      count: list.length,
    });
  });

  async function start() {
    // Prefer 1080p; the browser returns the closest supported mode. `ideal`
    // (not `exact`) so we degrade gracefully instead of failing on webcams
    // that top out lower.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        facingMode: "user",
      },
      audio: false,
    });

    videoEl.srcObject = stream;
    await videoEl.play();

    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    const w = videoEl.videoWidth || s.width;
    const h = videoEl.videoHeight || s.height;
    console.log(`Webcam capture: ${w}x${h}`, s);
    if (onResolution) onResolution(w, h);

    pump();
  }

  // Feed MediaPipe one frame at a time (never overlapping sends). Uses the
  // per-video-frame callback when available, else rAF.
  let sending = false;
  async function pump() {
    if (!sending && videoEl.readyState >= 2) {
      sending = true;
      try {
        await hands.send({ image: videoEl });
      } catch (err) {
        console.error("hands.send failed:", err);
      } finally {
        sending = false;
      }
    }
    if ("requestVideoFrameCallback" in videoEl) {
      videoEl.requestVideoFrameCallback(() => pump());
    } else {
      requestAnimationFrame(() => pump());
    }
  }

  start().catch((err) => console.error("getUserMedia failed:", err));
}
