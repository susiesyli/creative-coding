// src/faceTracking.js
//
// Lazy MediaPipe FaceMesh, used ONLY by the "head-tilt" gesture. We don't load
// it up front (a second inference graph on the same 1080p feed is expensive) —
// setupFaceTracking() injects the CDN script and starts the graph the first time
// head-tilt mode is selected. It shares the existing #webcam element (already
// streaming via handTracking.js) and runs its own frame pump, mirroring the
// pattern in handTracking.js.
//
// It reports head ROLL only: the angle of the line between the two outer eye
// corners (landmarks 33 and 263), in radians. gestures.js turns that into a
// left/right filter switch.

const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;

let started = false; // guard so repeated selection doesn't re-init

// Inject a script tag once and resolve when it has loaded.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) resolve();
      else {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", reject);
      }
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.crossOrigin = "anonymous";
    el.addEventListener("load", () => {
      el.dataset.loaded = "1";
      resolve();
    });
    el.addEventListener("error", reject);
    document.head.appendChild(el);
  });
}

/**
 * @param {(rollRadians:number) => void} onRoll  called per detected frame
 */
export async function setupFaceTracking(onRoll) {
  if (started) return;
  started = true;

  const videoEl = document.getElementById("webcam");

  await loadScript(
    "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js"
  );

  const faceMesh = new FaceMesh({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  faceMesh.onResults((results) => {
    const faces = results.multiFaceLandmarks || [];
    if (!faces.length) return;
    const lm = faces[0];
    const a = lm[LEFT_EYE_OUTER];
    const b = lm[RIGHT_EYE_OUTER];
    // Roll = tilt of the eye line. Raw (un-mirrored) space; gestures.js maps
    // the sign to next/prev.
    onRoll(Math.atan2(b.y - a.y, b.x - a.x));
  });

  // Own frame pump (never overlapping sends), independent of the hands pump.
  let sending = false;
  async function pump() {
    if (!sending && videoEl.readyState >= 2) {
      sending = true;
      try {
        await faceMesh.send({ image: videoEl });
      } catch (err) {
        console.error("faceMesh.send failed:", err);
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
  pump();
}
