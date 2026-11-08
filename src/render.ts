import * as THREE from "three";
import { SparkRenderer } from "@sparkjsdev/spark";
import { Editor } from "./editor";
import { CameraElement } from "./elements";
import { updateDepthView } from "./depth";
import { Viewport } from "./viewport";

const MAX_TARGET = 8192; // Spark's limit for offline targets (including supersampling)

/** A three.js camera that reproduces a scene camera's full image at w x h. */
function cameraFromElement(cam: CameraElement, w: number, h: number) {
  const proj = cam.projection(w, h);
  const c = proj.isPerspective ? new THREE.PerspectiveCamera() : new THREE.OrthographicCamera();
  c.near = cam.near;
  c.far = cam.far;
  cam.root.updateMatrixWorld();
  cam.root.matrixWorld.decompose(c.position, c.quaternion, new THREE.Vector3());
  c.projectionMatrix.copy(proj.matrix);
  c.projectionMatrixInverse.copy(proj.matrix).invert();
  c.updateMatrixWorld(true);
  return c;
}

/**
 * Render a clean image (no overlays) to PNG.
 * - With a camera: from that camera, at its resolution.
 * - Without: the current viewport (or the camera it is looking through) at screen resolution.
 * Uses a dedicated offline Spark renderer: it sorts the splats for the render camera
 * and supersamples 2x when the size allows it.
 */
/** While a PNG render is running, depth ranges are computed for its camera instead of the viewport's. */
export let renderCamera: THREE.Camera | null = null;

export async function renderPng(vp: Viewport, editor: Editor, cam: CameraElement | null) {
  let w: number, h: number, camera: THREE.Camera;
  if (cam) {
    w = cam.width;
    h = cam.height;
    camera = cameraFromElement(cam, w, h);
  } else {
    const pr = vp.renderer.getPixelRatio();
    w = Math.round(vp.width * pr);
    h = Math.round(vp.height * pr);
    camera = vp.activeCam.clone();
    camera.updateMatrixWorld(true);
  }
  if (w > MAX_TARGET || h > MAX_TARGET) throw new Error(`Render size ${w}×${h} exceeds ${MAX_TARGET}px`);
  const superXY = Math.max(w, h) * 2 <= MAX_TARGET ? 2 : 1;

  const renderer = vp.renderer;
  const scene = editor.scene;
  const overlays = editor.overlaysVisible;
  const helpersVisible = vp.helpers.visible;
  const lineVisible = vp.constraintLine.visible;
  const clearAlpha = renderer.getClearAlpha();
  const transparent = editor.world.transparentRender;
  const offline = new SparkRenderer({ renderer, autoUpdate: false, target: { width: w, height: h, superXY } });
  try {
    editor.setOverlaysVisible(false);
    vp.helpers.visible = false;
    vp.constraintLine.visible = false;
    renderer.setClearAlpha(transparent ? 0 : 1);
    renderCamera = camera;
    updateDepthView(editor, camera);
    await offline.update({ scene, camera }); // sort splats for this viewpoint
    renderer.setClearAlpha(transparent ? 0 : 1); // the live loop may render in between
    const pixels = await offline.renderReadTarget({ scene, camera });
    return { blob: await toPng(pixels, w, h, transparent), width: w, height: h };
  } finally {
    renderCamera = null;
    offline.dispose();
    renderer.setClearAlpha(clearAlpha);
    editor.setOverlaysVisible(overlays);
    vp.helpers.visible = helpersVisible;
    vp.constraintLine.visible = lineVisible;
  }
}

async function toPng(pixels: Uint8Array, w: number, h: number, transparent: boolean): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  // GL rows are bottom-up.
  for (let y = 0; y < h; y++) img.data.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  if (transparent) {
    // Splats are blended with premultiplied alpha; PNG wants straight alpha.
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a > 0 && a < 255) {
        d[i] = Math.min(255, (d[i] * 255) / a);
        d[i + 1] = Math.min(255, (d[i + 1] * 255) / a);
        d[i + 2] = Math.min(255, (d[i + 2] * 255) / a);
      }
    }
  } else {
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"),
  );
}
