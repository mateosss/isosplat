import "./style.css";
import * as THREE from "three";
import { Editor } from "./editor";
import { Viewport } from "./viewport";
import { TransformTool, type TransformMode } from "./transform";
import { FlyMode } from "./fly";
import { AxisGizmo } from "./axisGizmo";
import { HierarchyPanel } from "./ui/hierarchy";
import { PropertiesPanel } from "./ui/properties";
import { toast } from "./ui/toast";
import { CameraElement } from "./elements";
import { renderCamera, renderPng } from "./render";
import { JET_CSS, depthRange, updateDepthView } from "./depth";
import { PROJECT_EXTENSION, applyProject, buildProject, rebindSources } from "./project";
import { isAbort, openFile, saveBlob } from "./ui/files";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const container = $("viewport");
const hud = $("hud");
const editor = new Editor();
const vp = new Viewport(container, $<HTMLCanvasElement>("canvas"), editor, $("camera-frame"), $("view-label"));
const transform = new TransformTool(vp, editor, hud);
const fly = new FlyMode(vp, hud);
const gizmo = new AxisGizmo($<HTMLCanvasElement>("axis-gizmo"), (dir) => vp.snapView(dir));
new HierarchyPanel($("hierarchy-list"), editor);
const props = new PropertiesPanel($("properties-body"), editor, vp);
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

// ------------------------------------------------------------------ toolbar

const btnFullscreen = $("btn-fullscreen");
const btnFly = $("btn-fly");
const btnOverlays = $("btn-overlays");
const btnProjection = $("btn-projection");

btnFullscreen.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else container.requestFullscreen().catch((e) => toast(`Fullscreen failed: ${e.message}`));
});
document.addEventListener("fullscreenchange", () => {
  btnFullscreen.classList.toggle("active", document.fullscreenElement === container);
});

btnFly.addEventListener("click", () => (fly.active ? fly.exit() : fly.enter()));
fly.onChange = () => btnFly.classList.toggle("active", fly.active);

function setOverlays(v: boolean) {
  editor.setOverlaysVisible(v);
  vp.setOverlaysVisible(v);
  btnOverlays.classList.toggle("active", !v);
  btnOverlays.textContent = v ? "◧ Overlays" : "◧ Overlays off";
}
btnOverlays.addEventListener("click", () => setOverlays(!editor.overlaysVisible));

btnProjection.addEventListener("click", () => vp.toggleProjection());
$("btn-iso").addEventListener("click", () => vp.isoView());
$("btn-frame").addEventListener("click", () => vp.frame(editor.selected));
$("btn-orbit-center").addEventListener("click", () => {
  if (!vp.centerOrbitAtViewCenter()) toast("Nothing under the viewport center");
});

// ------------------------------------------------------------------ hierarchy actions

const fileInput = $<HTMLInputElement>("file-input");
$("btn-import").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  importFiles(Array.from(fileInput.files ?? []));
  fileInput.value = "";
});

$("btn-add-camera").addEventListener("click", () => {
  const cam = editor.addCamera();
  vp.copyViewToCamera(cam);
  editor.select(cam);
  toast("Camera added at the current view");
});

$("btn-add-cut").addEventListener("click", () => {
  editor.select(editor.addCutPlane("+Z", vp.controls.target.clone()));
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
      if (isFirst) vp.frame(el);
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
    const { blob } = buildProject(editor, vp.getViewState());
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
    setOverlays(json.overlays);
    vp.setViewState(json.view);
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
async function renderAndSave(cam: CameraElement | null) {
  if (rendering) return;
  rendering = true;
  try {
    const source = cam ?? vp.lockedCamera;
    toast("Rendering…", 30000);
    const { blob, width, height } = await renderPng(vp, editor, source);
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
const legend = $("depth-legend");
$("depth-legend-bar").style.background = JET_CSS;
function setDepthView(on: boolean) {
  editor.world.depthView = on;
  editor.emit("props");
}
btnDepth.addEventListener("click", () => setDepthView(!editor.world.depthView));
function updateDepthLegend() {
  const on = editor.world.depthView;
  btnDepth.classList.toggle("active", on);
  legend.classList.toggle("hidden", !on);
  if (!on) return;
  const fmt = (v: number) => `${v < 10 ? v.toFixed(2) : v.toFixed(1)} m`;
  const lo = fmt(depthRange.min), hi = fmt(depthRange.max);
  const minEl = $("depth-legend-min"), maxEl = $("depth-legend-max");
  if (minEl.textContent !== lo) minEl.textContent = lo;
  if (maxEl.textContent !== hi) maxEl.textContent = hi;
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

const mouse = new THREE.Vector2();
let mouseInViewport = false;
let downPos: THREE.Vector2 | null = null;

function localMouse(e: PointerEvent | MouseEvent) {
  const r = container.getBoundingClientRect();
  return new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
}

window.addEventListener("pointermove", (e) => {
  const m = localMouse(e);
  mouse.copy(m);
  mouseInViewport = m.x >= 0 && m.y >= 0 && m.x < vp.width && m.y < vp.height;
  transform.onPointerMove(m, e);
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
      downPos = null;
      return;
    }
    // Left click in the 3D view leaves WASD fly mode (toolbar buttons keep working normally).
    if (fly.active && e.button === 0 && e.target === vp.canvas) {
      e.stopPropagation();
      e.preventDefault();
      fly.exit();
      downPos = null;
      return;
    }
    downPos = e.button === 0 && !fly.active ? localMouse(e) : null;
  },
  { capture: true },
);

container.addEventListener("pointerup", (e) => {
  if (!downPos || e.button !== 0) return;
  const up = localMouse(e);
  const wasClick = up.distanceTo(downPos) < 5;
  downPos = null;
  if (wasClick && e.target === vp.canvas) editor.select(vp.pick(up.x, up.y));
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

  // Blender numpad navigation. The top-row digits do the same for keyboards without a numpad.
  // "Opposite" views use Ctrl (Blender) or Shift (browsers often reserve Ctrl+1..8 for tab switching).
  const digit = /^(?:Numpad|Digit)([0-9])$/.exec(e.code)?.[1];
  if (digit !== undefined) {
    e.preventDefault();
    const opposite = e.ctrlKey || e.shiftKey;
    const view = (dir: THREE.Vector3) => vp.snapView(opposite ? dir.negate() : dir);
    switch (digit) {
      case "1": return view(new THREE.Vector3(0, -1, 0)); // front (Ctrl: back)
      case "3": return view(new THREE.Vector3(1, 0, 0)); // right (Ctrl: left)
      case "7": return view(new THREE.Vector3(0, 0, 1)); // top (Ctrl: bottom)
      case "5": return vp.toggleProjection();
      case "9": return vp.orbitBy(180, 0); // opposite side
      case "0": {
        const cam = editor.selected instanceof CameraElement ? editor.selected : editor.cameras()[0];
        if (cam) vp.lookFrom(cam);
        return;
      }
      // 4/6/8/2: orbit 15°; with Ctrl: pan.
      case "4": return e.ctrlKey ? vp.panBy(-0.1, 0) : vp.orbitBy(-15, 0);
      case "6": return e.ctrlKey ? vp.panBy(0.1, 0) : vp.orbitBy(15, 0);
      case "8": return e.ctrlKey ? vp.panBy(0, 0.1) : vp.orbitBy(0, 15);
      case "2": return e.ctrlKey ? vp.panBy(0, -0.1) : vp.orbitBy(0, -15);
    }
    return;
  }
  switch (e.code) {
    case "NumpadAdd": return vp.zoomBy(0.8);
    case "NumpadSubtract": return vp.zoomBy(1.25);
    case "NumpadDecimal":
    case "Period": return vp.frame(editor.selected); // view selected
    case "Home": return vp.frame(null); // view all
  }
  if (e.ctrlKey) return;

  const key = e.key.toLowerCase();
  if (key === "g" || key === "r" || key === "s") {
    if (!editor.selected) return toast("Select something first");
    if (!mouseInViewport) return;
    e.preventDefault();
    transform.begin(key.toUpperCase() as TransformMode, mouse);
  } else if (key === "w") {
    if (!mouseInViewport) return;
    e.preventDefault();
    fly.enter();
  } else if (key === "z") {
    setDepthView(!editor.world.depthView);
  } else if (e.key === "Delete") {
    deleteSelected();
  } else if (key === "f") {
    if (!mouseInViewport) return;
    if (!vp.centerOrbitAtCursor(mouse.x, mouse.y)) toast("No surface under the cursor: centered on the current focus depth");
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
  else if (!vp.lockedCamera && vp.controls.enabled) vp.controls.update();
  vp.update();
  editor.updateCuts();
  updateDepthView(editor, renderCamera ?? vp.activeCam);
  updateDepthLegend();
  if (editor.overlaysVisible) gizmo.draw(vp.activeCam);
  props.sync();
  const projLabel = vp.isOrtho ? "Ortho" : "Persp";
  if (btnProjection.textContent !== projLabel) btnProjection.textContent = projLabel;
  vp.render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Handy for debugging from the console.
Object.assign(window, { editor, vp });
