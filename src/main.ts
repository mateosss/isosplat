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
  importFiles(Array.from(e.dataTransfer?.files ?? []));
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
  if (e.metaKey || e.altKey) return;

  const numpadView = (dir: THREE.Vector3) => vp.snapView(e.ctrlKey ? dir.negate() : dir);
  switch (e.code) {
    case "Numpad5": return vp.toggleProjection();
    case "Numpad1": return numpadView(new THREE.Vector3(0, -1, 0));
    case "Numpad3": return numpadView(new THREE.Vector3(1, 0, 0));
    case "Numpad7": return numpadView(new THREE.Vector3(0, 0, 1));
    case "Numpad0": {
      const cam = editor.selected instanceof CameraElement ? editor.selected : editor.cameras()[0];
      if (cam) vp.lookFrom(cam);
      return;
    }
  }
  if (e.ctrlKey) return;

  const key = e.key.toLowerCase();
  if (key === "g" || key === "r" || key === "s") {
    if (!editor.selected) return toast("Select something first");
    if (!mouseInViewport) return;
    e.preventDefault();
    transform.begin(key.toUpperCase() as TransformMode, mouse);
  } else if (e.key === "Delete") {
    deleteSelected();
  } else if (key === "f") {
    vp.frame(editor.selected);
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
