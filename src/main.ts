import "./style.css";
import * as THREE from "three";
import { Editor } from "./editor";
import { View, Viewport } from "./viewport";
import { TransformTool, type TransformMode } from "./transform";
import { FlyMode } from "./fly";
import { AxisGizmo } from "./axisGizmo";
import { HierarchyPanel } from "./ui/hierarchy";
import { PropertiesPanel } from "./ui/properties";
import { toast } from "./ui/toast";
import { CameraElement } from "./elements";
import { renderPng } from "./render";
import { JET_CSS } from "./depth";
import { PROJECT_EXTENSION, applyProject, buildProject, rebindSources } from "./project";
import { isAbort, openFile, saveBlob } from "./ui/files";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const container = $("viewport");
const canvas = $<HTMLCanvasElement>("canvas");
const hud = $("hud");
const editor = new Editor();
const vp = new Viewport(container, canvas, editor);
/** The main view fills the viewport; the minimap is a second, independent view on top of it. */
const main = new View(vp, "main", container, canvas, { frame: $("camera-frame"), label: $("view-label") });
const minimapEl = $("minimap");
const mini = new View(vp, "minimap", minimapEl, $("mm-surface"), { frame: $("mm-frame"), label: $("mm-label") }, vp.makeSpark());
mini.setVisible(false);
mini.setOverlaysVisible(false); // a clean preview by default (☰ → Overlays to show them)

const transform = new TransformTool(vp, editor, hud);
const fly = new FlyMode(vp, hud);
const gizmos = new Map<View, AxisGizmo>([
  [main, new AxisGizmo($<HTMLCanvasElement>("axis-gizmo"), (dir) => main.snapView(dir))],
  [mini, new AxisGizmo($<HTMLCanvasElement>("mm-gizmo"), (dir) => mini.snapView(dir))],
]);
const legends = new Map<View, HTMLElement>([
  [main, $("depth-legend")],
  [mini, $("mm-legend")],
]);
legends.forEach((l) => ((l.querySelector(".bar") as HTMLElement).style.background = JET_CSS));
new HierarchyPanel($("hierarchy-list"), editor);
const props = new PropertiesPanel($("properties-body"), editor, vp, main);
vp.setBackground(editor.world.background);

// ------------------------------------------------------------------ initial scene

function aimAt(cam: CameraElement, target: THREE.Vector3) {
  // Cameras look down -Z: use a three.js camera to compute the orientation.
  const tmp = new THREE.PerspectiveCamera();
  tmp.up.set(0, 0, 1);
  tmp.position.copy(cam.root.position);
  tmp.lookAt(target);
  cam.root.quaternion.copy(tmp.quaternion);
}

{
  const cam = editor.addCamera();
  cam.name = "Iso camera";
  cam.type = "orthographic";
  cam.orthoScale = 18;
  cam.root.position.set(20, -20, 20);
  aimAt(cam, new THREE.Vector3(0, 0, 0));
  cam.rebuildGizmo();
  editor.addDefaultCutPlanes(10);
}

// ------------------------------------------------------------------ view actions (shared by toolbar and minimap menu)

const btnFullscreen = $("btn-fullscreen");
const btnFly = $("btn-fly");
const btnOverlays = $("btn-overlays");
const btnProjection = $("btn-projection");
const btnMinimap = $("btn-minimap");

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else container.requestFullscreen().catch((e) => toast(`Fullscreen failed: ${e.message}`));
}
document.addEventListener("fullscreenchange", () => {
  btnFullscreen.classList.toggle("active", document.fullscreenElement === container);
});

function toggleFly(view: View) {
  if (fly.active) fly.exit();
  else fly.enter(view);
}
fly.onChange = () => btnFly.classList.toggle("active", fly.active && fly.view === main);

function setOverlays(view: View, v: boolean) {
  view.setOverlaysVisible(v);
  if (view === main) {
    btnOverlays.classList.toggle("active", !v);
    btnOverlays.textContent = v ? "◧ Overlays" : "◧ Overlays off";
  }
}

function orbitCenter(view: View) {
  if (!view.centerOrbitAtViewCenter()) toast("Nothing under the view center");
}

btnFullscreen.addEventListener("click", toggleFullscreen);
btnFly.addEventListener("click", () => toggleFly(main));
btnOverlays.addEventListener("click", () => setOverlays(main, !main.overlays));
btnProjection.addEventListener("click", () => main.toggleProjection());
$("btn-iso").addEventListener("click", () => main.isoView());
$("btn-frame").addEventListener("click", () => main.frame(editor.selected));
$("btn-orbit-center").addEventListener("click", () => orbitCenter(main));

// ------------------------------------------------------------------ minimap

let minimapInitialized = false;
function setMinimap(visible: boolean) {
  if (visible && !minimapInitialized) {
    minimapInitialized = true;
    // Start as a preview of the first camera (its main use), or as a copy of the main view.
    const cam = editor.cameras()[0];
    mini.setVisible(true);
    if (cam) mini.lookFrom(cam);
    else mini.setViewState(main.getViewState());
  }
  mini.setVisible(visible);
  if (!visible) mmMenu.classList.add("hidden");
  btnMinimap.classList.toggle("active", visible);
}
btnMinimap.addEventListener("click", () => setMinimap(!mini.visible));
$("mm-close").addEventListener("click", () => setMinimap(false));
props.onPreview = (cam) => {
  setMinimap(true);
  mini.lookFrom(cam);
};

const mmMenu = $("mm-menu");
const mmMenuBtn = $("mm-menu-btn");
function openMinimapMenu(open: boolean) {
  mmMenu.classList.toggle("hidden", !open);
  mmMenuBtn.classList.toggle("active", open);
  if (!open) return;
  // Reflect current state and list the cameras.
  const act = (a: string) => mmMenu.querySelector(`[data-act="${a}"]`) as HTMLElement;
  act("overlays").classList.toggle("active", mini.overlays);
  act("depth").classList.toggle("active", editor.world.depthView);
  act("fly").classList.toggle("active", fly.active && fly.view === mini);
  act("projection").textContent = mini.isOrtho ? "Ortho → Persp" : "Persp → Ortho";
  const list = $("mm-cameras");
  list.replaceChildren();
  for (const cam of editor.cameras()) {
    const b = document.createElement("button");
    b.textContent = `👁 ${cam.name}`;
    b.classList.toggle("active", mini.lockedCamera === cam);
    b.addEventListener("click", () => {
      mini.lookFrom(cam);
      openMinimapMenu(false);
    });
    list.append(b);
  }
  if (!editor.cameras().length) list.textContent = "(no cameras)";
}
mmMenuBtn.addEventListener("click", () => openMinimapMenu(mmMenu.classList.contains("hidden")));
mmMenu.addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
  if (!act) return;
  openMinimapMenu(false);
  switch (act) {
    case "fullscreen": return toggleFullscreen();
    case "fly": return toggleFly(mini);
    case "overlays": return setOverlays(mini, !mini.overlays);
    case "projection": return mini.toggleProjection();
    case "iso": return mini.isoView();
    case "frame": return mini.frame(editor.selected);
    case "orbit-center": return orbitCenter(mini);
    case "depth": return setDepthView(!editor.world.depthView);
    case "render": return renderAndSave(null, mini);
  }
});
// Keep clicks on the minimap chrome (bar, menu, resize handle) away from the main view.
for (const el of [minimapEl.querySelector(".mm-bar")!, mmMenu, $("mm-resize")]) {
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
}

// Resize from the top-left corner (the minimap is anchored bottom-right).
{
  const handle = $("mm-resize");
  let start: { x: number; y: number; w: number; h: number } | null = null;
  handle.addEventListener("pointerdown", (e) => {
    handle.setPointerCapture(e.pointerId);
    const r = minimapEl.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    const w = THREE.MathUtils.clamp(start.w - (e.clientX - start.x), 160, vp.width - 24);
    const h = THREE.MathUtils.clamp(start.h - (e.clientY - start.y), 110, vp.height - 70);
    setMinimapSize(w, h);
  });
  handle.addEventListener("pointerup", () => (start = null));
}
function setMinimapSize(w: number, h: number) {
  minimapEl.style.width = `${w}px`;
  minimapEl.style.height = `${h}px`;
  mini.resize();
}

// ------------------------------------------------------------------ hierarchy actions

const fileInput = $<HTMLInputElement>("file-input");
$("btn-import").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  importFiles(Array.from(fileInput.files ?? []));
  fileInput.value = "";
});

$("btn-add-camera").addEventListener("click", () => {
  const cam = editor.addCamera();
  main.copyViewToCamera(cam);
  editor.select(cam);
  toast("Camera added at the current view");
});

$("btn-add-cut").addEventListener("click", () => {
  editor.select(editor.addCutPlane("+Z", main.controls.target.clone()));
});

$("btn-add-box").addEventListener("click", () => {
  editor.select(editor.addCutBox(main.controls.target.clone()));
});

$("btn-delete").addEventListener("click", deleteSelected);

function deleteSelected() {
  if (editor.selected) editor.remove(editor.selected);
}

async function importFiles(files: File[]) {
  for (const file of files) {
    if (!/\.(ply|spz|splat|ksplat|sog)$/i.test(file.name)) {
      toast(`Unsupported file: ${file.name}`);
      continue;
    }
    const isFirst = editor.splats().length === 0;
    toast(`Loading ${file.name}…`, 4000);
    try {
      const el = await editor.importSplat(file);
      editor.select(el);
      if (isFirst) main.frame(el);
      toast(`Loaded ${file.name} (${el.numSplats.toLocaleString()} gaussians)`);
    } catch (err) {
      console.error(err);
      toast(`Failed to load ${file.name}: ${(err as Error).message ?? err}`, 5000);
    }
  }
}

// ------------------------------------------------------------------ project files & rendering

const PROJECT_TYPE = { description: "IsoSplat project", accept: { "application/octet-stream": [PROJECT_EXTENSION] } };
const PNG_TYPE = { description: "PNG image", accept: { "image/png": [".png"] } };
let projectHandle: FileSystemFileHandle | null = null;
let projectName = "untitled";

function setProjectName(name: string) {
  projectName = name.replace(/\.isosplat$/i, "");
  $("project-name").textContent = projectName;
  document.title = `${projectName} — IsoSplat`;
}
setProjectName("untitled");

async function saveProject(saveAs: boolean) {
  const loading = editor.splats().filter((s) => !s.loaded);
  if (loading.length) return toast("Wait for splats to finish loading before saving");
  try {
    const r = minimapEl.getBoundingClientRect();
    const { blob } = buildProject(editor, {
      view: main.getViewState(),
      overlays: main.overlays,
      minimap: minimapInitialized
        ? { visible: mini.visible, width: r.width || mini.width, height: r.height || mini.height, overlays: mini.overlays, view: mini.getViewState() }
        : undefined,
    });
    toast("Saving…", 10000);
    const handle = await saveBlob(blob, `${projectName}${PROJECT_EXTENSION}`, PROJECT_TYPE, saveAs ? null : projectHandle);
    if (handle) {
      projectHandle = handle;
      setProjectName(handle.name);
      // Splat sources may be slices of the file we just overwrote: point them at the new one.
      await rebindSources(editor, await handle.getFile());
    }
    toast(`Saved ${projectName}${PROJECT_EXTENSION} (${formatBytes(blob.size)})`);
  } catch (err) {
    if (isAbort(err)) return toast("Save cancelled");
    console.error(err);
    toast(`Save failed: ${(err as Error).message}`, 5000);
  }
}

async function openProject(file: File, handle: FileSystemFileHandle | null) {
  try {
    toast(`Opening ${file.name}…`, 10000);
    const { json, loaded } = await applyProject(editor, file);
    vp.setBackground(editor.world.background);
    setOverlays(main, json.overlays);
    main.setViewState(json.view);
    if (json.minimap) {
      minimapInitialized = true;
      setMinimapSize(json.minimap.width, json.minimap.height);
      setOverlays(mini, json.minimap.overlays);
      mini.setVisible(true);
      mini.setViewState(json.minimap.view);
      setMinimap(json.minimap.visible);
    } else {
      setMinimap(false);
    }
    projectHandle = handle;
    setProjectName(file.name);
    await loaded;
    toast(`Opened ${file.name}`);
  } catch (err) {
    console.error(err);
    toast(`Could not open ${file.name}: ${(err as Error).message}`, 5000);
  }
}

async function promptOpenProject() {
  try {
    const picked = await openFile(PROJECT_TYPE, $<HTMLInputElement>("project-input"));
    if (picked) await openProject(picked.file, picked.handle);
  } catch (err) {
    toast(`Open failed: ${(err as Error).message}`, 5000);
  }
}

let rendering = false;
/** Render from `cam`, or from `view` (through its locked camera if it has one). */
async function renderAndSave(cam: CameraElement | null, view: View = main) {
  if (rendering) return;
  rendering = true;
  try {
    const source = cam ?? view.lockedCamera;
    toast("Rendering…", 30000);
    const { blob, width, height } = await renderPng(view, editor, source);
    const base = `${projectName}-${source ? source.name : "view"}`.replace(/[^\w.-]+/g, "_");
    await saveBlob(blob, `${base}.png`, PNG_TYPE);
    toast(`Rendered ${width}×${height} PNG`);
  } catch (err) {
    if (isAbort(err)) return toast("Render not saved");
    console.error(err);
    toast(`Render failed: ${(err as Error).message}`, 5000);
  } finally {
    rendering = false;
  }
}
props.onRender = (cam) => renderAndSave(cam);

function formatBytes(n: number) {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} kB`;
}

$("btn-open").addEventListener("click", promptOpenProject);
$("btn-save").addEventListener("click", () => saveProject(false));
$("btn-save-as").addEventListener("click", () => saveProject(true));
$("btn-render").addEventListener("click", () => renderAndSave(null));

// ------------------------------------------------------------------ depth view

const btnDepth = $("btn-depth");
function setDepthView(on: boolean) {
  editor.world.depthView = on;
  editor.emit("props");
}
btnDepth.addEventListener("click", () => setDepthView(!editor.world.depthView));
function updateDepthLegends() {
  const on = editor.world.depthView;
  btnDepth.classList.toggle("active", on);
  const fmt = (v: number) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)} m`;
  for (const [view, legend] of legends) {
    legend.classList.toggle("hidden", !on);
    if (!on) continue;
    const lo = legend.querySelector(".lo")!, hi = legend.querySelector(".hi")!;
    const l = fmt(view.depth.min), h = fmt(view.depth.max);
    if (lo.textContent !== l) lo.textContent = l;
    if (hi.textContent !== h) hi.textContent = h;
  }
}

// Drag & drop
const dropHint = $("drop-hint");
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropHint.classList.remove("hidden");
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) dropHint.classList.add("hidden");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropHint.classList.add("hidden");
  const files = Array.from(e.dataTransfer?.files ?? []);
  const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_EXTENSION));
  if (project) openProject(project, null);
  else importFiles(files);
});

// ------------------------------------------------------------------ pointer

/** Last pointer position (client coords) and the view under it (null outside the views). */
const client = new THREE.Vector2();
let hovered: View | null = null;
/** View that keyboard navigation acts on: the hovered one, else the last hovered. */
let lastView: View = main;
let down: { view: View; at: THREE.Vector2 } | null = null;

/** The view whose input surface is `target` (canvas -> main, minimap surface -> minimap). */
function viewOfSurface(target: EventTarget | null) {
  return vp.views.find((v) => v.visible && v.surface === target) ?? null;
}

window.addEventListener("pointermove", (e) => {
  client.set(e.clientX, e.clientY);
  hovered = vp.viewAt(e.clientX, e.clientY);
  if (hovered) lastView = hovered;
  if (transform.active) transform.onPointerMove(transform.view.toLocal(e.clientX, e.clientY), e);
});

// Capture phase so we can swallow clicks that confirm / cancel a transform before OrbitControls sees them.
container.addEventListener(
  "pointerdown",
  (e) => {
    if (transform.active) {
      e.stopPropagation();
      e.preventDefault();
      if (e.button === 0) transform.confirm();
      else if (e.button === 2) transform.cancel();
      down = null;
      return;
    }
    // Left click in a 3D view leaves WASD fly mode (buttons keep working normally).
    if (fly.active && e.button === 0 && (e.target === canvas || viewOfSurface(e.target))) {
      e.stopPropagation();
      e.preventDefault();
      fly.exit();
      down = null;
      return;
    }
    if (!mmMenu.classList.contains("hidden") && !mmMenu.contains(e.target as Node)) openMinimapMenu(false);
    const view = viewOfSurface(e.target);
    down = e.button === 0 && !fly.active && view ? { view, at: new THREE.Vector2(e.clientX, e.clientY) } : null;
  },
  { capture: true },
);

container.addEventListener("pointerup", (e) => {
  if (!down || e.button !== 0) return;
  const { view, at } = down;
  down = null;
  if (at.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) >= 5 || viewOfSurface(e.target) !== view) return;
  const p = view.toLocal(e.clientX, e.clientY);
  editor.select(view.pick(p.x, p.y));
});

container.addEventListener("contextmenu", (e) => e.preventDefault());

// ------------------------------------------------------------------ keyboard

function isTyping(target: EventTarget | null) {
  const t = target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

window.addEventListener("keydown", (e) => {
  if (fly.onKey(e, true)) return e.preventDefault();
  if (isTyping(e.target)) return;
  if (transform.onKey(e)) return e.preventDefault();
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "s") {
      e.preventDefault();
      return void saveProject(e.shiftKey);
    }
    if (k === "o") {
      e.preventDefault();
      return void promptOpenProject();
    }
  }
  if (e.metaKey || e.altKey) return;
  const view = hovered ?? lastView;
  const mouse = view.toLocal(client.x, client.y);

  // Blender numpad navigation. The top-row digits do the same for keyboards without a numpad.
  // "Opposite" views use Ctrl (Blender) or Shift (browsers often reserve Ctrl+1..8 for tab switching).
  const digit = /^(?:Numpad|Digit)([0-9])$/.exec(e.code)?.[1];
  if (digit !== undefined) {
    e.preventDefault();
    const opposite = e.ctrlKey || e.shiftKey;
    const snap = (dir: THREE.Vector3) => view.snapView(opposite ? dir.negate() : dir);
    switch (digit) {
      case "1": return snap(new THREE.Vector3(0, -1, 0)); // front (Ctrl: back)
      case "3": return snap(new THREE.Vector3(1, 0, 0)); // right (Ctrl: left)
      case "7": return snap(new THREE.Vector3(0, 0, 1)); // top (Ctrl: bottom)
      case "5": return view.toggleProjection();
      case "9": return view.orbitBy(180, 0); // opposite side
      case "0": {
        const cam = editor.selected instanceof CameraElement ? editor.selected : editor.cameras()[0];
        if (cam) view.lookFrom(cam);
        return;
      }
      // 4/6/8/2: orbit 15°; with Ctrl: pan.
      case "4": return e.ctrlKey ? view.panBy(-0.1, 0) : view.orbitBy(-15, 0);
      case "6": return e.ctrlKey ? view.panBy(0.1, 0) : view.orbitBy(15, 0);
      case "8": return e.ctrlKey ? view.panBy(0, 0.1) : view.orbitBy(0, 15);
      case "2": return e.ctrlKey ? view.panBy(0, -0.1) : view.orbitBy(0, -15);
    }
    return;
  }
  switch (e.code) {
    case "NumpadAdd": return view.zoomBy(0.8);
    case "NumpadSubtract": return view.zoomBy(1.25);
    case "NumpadDecimal":
    case "Period": return view.frame(editor.selected); // view selected
    case "Home": return view.frame(null); // view all
  }
  if (e.ctrlKey) return;

  const key = e.key.toLowerCase();
  if (key === "g" || key === "r" || key === "s") {
    if (!editor.selected) return toast("Select something first");
    if (!hovered) return;
    e.preventDefault();
    transform.begin(key.toUpperCase() as TransformMode, mouse, hovered);
  } else if (key === "w") {
    if (!hovered) return;
    e.preventDefault();
    fly.enter(hovered);
  } else if (key === "z") {
    setDepthView(!editor.world.depthView);
  } else if (e.key === "Delete") {
    deleteSelected();
  } else if (key === "f") {
    if (!hovered) return;
    if (!hovered.centerOrbitAtCursor(mouse.x, mouse.y)) toast("No surface under the cursor: centered on the current focus depth");
  } else if (e.key === "Escape") {
    openMinimapMenu(false);
  }
});

window.addEventListener("keyup", (e) => {
  fly.onKey(e, false);
  transform.onKeyUp(e);
});

// ------------------------------------------------------------------ main loop

const timer = new THREE.Timer();
function tick(time: number) {
  timer.update(time);
  const dt = Math.min(0.1, timer.getDelta());
  if (fly.active) fly.update(dt);
  for (const v of vp.views) {
    if (!v.visible) continue;
    const flying = fly.active && fly.view === v;
    if (!flying && !v.lockedCamera && v.controls.enabled) v.controls.update();
    v.update();
  }
  editor.updateCuts();
  updateDepthLegends();
  for (const [v, g] of gizmos) if (v.visible && v.overlays) g.draw(v.activeCam);
  props.sync();
  const projLabel = main.isOrtho ? "Ortho" : "Persp";
  if (btnProjection.textContent !== projLabel) btnProjection.textContent = projLabel;
  vp.render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Handy for debugging from the console (`vp` is the main view).
Object.assign(window, { editor, vp: main, mini, viewport: vp });
