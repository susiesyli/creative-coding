// Everything shown at /gallery/, as one scrolling page of sections.
//
// ============================================================
//   VIEW — the view the gallery opens in. Both views are always
//   built; a toggle switches between them at runtime with a
//   shared-element transition (gallery-viewswitch.js), and the
//   last choice is remembered for the session.
//     "grid"    sectioned scrolling grid
//     "canvas"  draggable pan/zoom canvas (gallery-canvas.js)
// ============================================================
const VIEW = "canvas";

// Each section renders a heading + its own grid. Add a new section (e.g.
// illustrations) by appending to `sections` — the page grows downward and
// nothing else needs to change.
//
// Section shape:
//   title     section heading
//   subtitle  muted line under the heading (optional)
//   items     the cards, in display order
//
// Item shape:
//   id       stable short key; joins to the composition in gallery-layout.js
//   title    display name
//   path     folder/url relative to /gallery/ (or an absolute path/URL)
//   desc     short line under the title (optional)
//   tags     lowercase pills
//   thumb    image path relative to /gallery/
//   window   optional named tab, so re-opening a demo reuses its tab
const sections = [
  {
    title: "Neural Interfaces",
    subtitle: "gesture-driven fluid interfaces - creative coding experiments: Three.js + MediaPipe + GLSL + WebGPU etc",
    items: [
      {
        id: "panel",
        title: "panel",
        path: "neural-interfaces/panel",
        desc: "",
        tags: ["webcam", "photo", "interaction"],
        thumb: "neural-interfaces/panel/thumbnail.png",
        window: "panel",
      },
      {
        id: "draw",
        title: "geometry + material = mesh",
        path: "neural-interfaces/draw",
        desc: "scene, camera, geometry, material & mesh explorer",
        tags: ["three.js", "graphics", "shader"],
        thumb: "neural-interfaces/draw/thumbnail.png",
        window: "draw",
      },
      {
        id: "photobooth",
        title: "photobooth",
        path: "neural-interfaces/photobooth",
        desc: "take pics photos and print them out",
        tags: ["webcam", "photo", "interaction"],
        thumb: "neural-interfaces/photobooth/thumbnail.png",
        window: "photobooth",
      },
      {
        id: "asciishader",
        title: "ascii photobooth",
        path: "neural-interfaces/asciishader",
        desc: "ascii shader effect but on webcam!",
        tags: ["shader", "photobooth"],
        thumb: "neural-interfaces/asciishader/thumbnail.png",
      },
      {
        id: "cube",
        title: "just a cube",
        path: "neural-interfaces/cube",
        desc: "rotating a 3D cube with hand gestures",
        tags: ["simple", "interaction", "3D"],
        thumb: "neural-interfaces/cube/thumbnail.png",
      },
      {
        id: "blob",
        title: "bl😮b",
        path: "neural-interfaces/blob",
        desc: "A shader-driven morphing blob with hand tracking",
        tags: ["shader", "interaction"],
        thumb: "neural-interfaces/blob/thumbnail.png",
        window: "blob",
      },
      {
        id: "blob2",
        title: "bl😮b 2",
        path: "neural-interfaces/blob2",
        desc: "A shader-driven morphing blob with hand tracking",
        tags: ["shader", "interaction"],
        thumb: "neural-interfaces/blob2/thumbnail.png",
        window: "blob",
      },
      // {
      //   id: "mediapipe",
      //   title: "MediaPipe Hands",
      //   path: "neural-interfaces/mediapipe",
      //   desc: "MediaPipe Hands landmarks integration with Three.js.",
      //   tags: ["motion tracking", "mediapipe", "interaction"],
      //   thumb: "neural-interfaces/mediapipe/thumbnail.png",
      // },
      {
        id: "puzzle-jigsaw",
        title: "Jigsaw Puzzle",
        path: "neural-interfaces/puzzle-jigsaw",
        desc: "Assemble a jigsaw puzzle using hand gestures",
        tags: ["game", "puzzle", "interactive"],
        thumb: "neural-interfaces/puzzle-jigsaw/thumbnail.png",
      },
      {
        id: "puzzle-sliding",
        title: "Sliding Puzzle",
        path: "neural-interfaces/puzzle-sliding",
        desc: "Assemble a sliding puzzle using hand gestures",
        tags: ["game", "puzzle", "interactive"],
        thumb: "neural-interfaces/puzzle-sliding/thumbnail.png",
      },
      {
        id: "customshader",
        title: "custom shader",
        path: "neural-interfaces/customshader",
        desc: "custom shader in Three.js",
        tags: ["graphics", "shader", "GLSL"],
        thumb: "neural-interfaces/customshader/thumbnail.png",
        window: "draw",
      },
    ],
  },

  // Next section goes here, e.g.:
  // {
  //   title: "Illustrations",
  //   subtitle: "ink + risograph",
  //   items: [{ title: "...", path: "illustrations/...", tags: [], thumb: "..." }],
  // },
];

// Anchor id for a section heading, so sections are linkable (#neural-interfaces).
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function buildCard(item) {
  const card = document.createElement("a");
  card.className = "nm-card";
  // A real href, so the card is keyboard-focusable and middle/cmd-click works.
  card.href = item.path;
  card.target = item.window || item.path;
  // Identity for the shared-element view transition: this is the key that ties
  // this card to the same project's card in the canvas view.
  card.dataset.projectId = item.id;
  card.dataset.thumb = item.thumb;

  // Omit empty nodes rather than rendering blank ones — an empty desc div
  // still takes vertical space and knocks the tags out of alignment.
  const desc = item.desc
    ? `<div class="nm-card-desc">${item.desc}</div>`
    : "";
  const tags = (item.tags || []).length
    ? `<div class="nm-tags">${item.tags
        .map((t) => `<span class="nm-tag">${t}</span>`)
        .join("")}</div>`
    : "";

  card.innerHTML = `
    <div class="nm-thumb" style="background-image:url('${item.thumb}')"></div>
    <div class="nm-card-body">
      <div class="nm-card-title">${item.title}</div>
      ${desc}
      ${tags}
    </div>
  `;

  return card;
}

function buildSection(section) {
  const el = document.createElement("section");
  el.className = "nm-section";
  el.id = slug(section.title);

  const header = document.createElement("div");
  header.className = "nm-section-header";
  header.innerHTML = `
    <h2 class="nm-section-title">${section.title}</h2>
    ${section.subtitle ? `<p class="nm-section-subtitle">${section.subtitle}</p>` : ""}
  `;
  el.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "nm-gallery";
  section.items.forEach((item) => grid.appendChild(buildCard(item)));
  el.appendChild(grid);

  return el;
}

const root = document.getElementById("gallery");
const flatItems = sections.flatMap((section) => section.items);

// Both views are built and stay mounted. That is what makes the shared-element
// transition possible: each end can be measured while the other is on screen,
// and neither view loses its state (canvas camera + card positions, grid scroll)
// when it isn't the one being shown. Both use the same thumbnail URLs, so the
// images are fetched once and never reload across a switch.
const gridEl = document.createElement("div");
gridEl.className = "nm-grid-view";
sections.forEach((section) => gridEl.appendChild(buildSection(section)));
root.appendChild(gridEl);

Promise.all([
  import("./gallery-canvas.js"),
  import("./gallery-viewswitch.js"),
]).then(([canvasModule, switchModule]) => {
  const canvas = canvasModule.initCanvasView(root, flatItems);
  switchModule.initViewSwitch({ gridEl, canvas, initialView: VIEW });
});
