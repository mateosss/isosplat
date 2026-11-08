import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer } from "@sparkjsdev/spark";
import { Editor } from "./editor";
import { AXIS_COLORS, CameraElement, SceneElement, SplatElement } from "./elements";

const UP = new THREE.Vector3(0, 0, 1);
/** Distance at which the free orthographic camera sits from its orbit target. */
const ORTHO_DISTANCE = 200;
const PICK_PIXELS = 6;

/**
 * The 3D view. World is Z-up (like Blender); the floor grid lies on the XY plane.
 */
export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly spark: SparkRenderer;
  readonly perspCam = new THREE.PerspectiveCamera(50, 1, 0.02, 2000);
  readonly orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.02, 4000);
  activeCam: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspCam;
  readonly controls: OrbitControls;
  /** Visible world height of the free orthographic camera at zoom 1. */
  private orthoHeight = 10;
  lockedCamera: CameraElement | null = null;
  private lockedProjection: ReturnType<CameraElement["projection"]> | null = null;

  readonly helpers = new THREE.Group();
  readonly constraintLine: THREE.Line;
  width = 1;
  height = 1;
  onViewChanged: () => void = () => {};

  constructor(
    readonly container: HTMLElement,
    readonly canvas: HTMLCanvasElement,
    readonly editor: Editor,
    private frameEl: HTMLElement,
    private labelEl: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x3a3a3a);

    this.spark = new SparkRenderer({ renderer: this.renderer });
    editor.scene.add(this.spark);

    for (const cam of [this.perspCam, this.orthoCam]) cam.up.copy(UP);
    this.perspCam.position.set(12, -14, 9);
    this.controls = new OrbitControls(this.perspCam, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener("start", () => this.unlock());
    this.controls.update();

    this.buildHelpers();
    editor.scene.add(this.helpers);

    this.constraintLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)]),
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    this.constraintLine.visible = false;
    this.constraintLine.renderOrder = 11;
    (this.constraintLine.material as THREE.Material).transparent = true;
    editor.scene.add(this.constraintLine);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // ---------------------------------------------------------------- helpers

  private buildHelpers() {
    const grid = new THREE.GridHelper(100, 100, 0x5a5a5a, 0x4a4a4a);
    grid.rotation.x = Math.PI / 2; // GridHelper is XZ; make it XY (Z-up floor)
    const gm = grid.material as THREE.LineBasicMaterial;
    gm.transparent = true;
    gm.opacity = 0.6;
    gm.depthWrite = false;
    this.helpers.add(grid);

    const L = 50;
    const axisLine = (axis: number, length: number, opacity: number) => {
      const a = new THREE.Vector3().setComponent(axis, -length);
      const b = new THREE.Vector3().setComponent(axis, length);
      const mat = new THREE.LineBasicMaterial({ color: AXIS_COLORS[axis], transparent: true, opacity, depthWrite: false });
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), mat);
    };
    this.helpers.add(axisLine(0, L, 0.9), axisLine(1, L, 0.9), axisLine(2, 5, 0.6));
    // Draw grid/axes before the splats so the splats cover them.
    this.helpers.traverse((o) => {
      o.raycast = () => {};
      o.renderOrder = -10;
      const m = (o as THREE.Line).material as THREE.Material;
      if (m) m.transparent = true;
    });
  }

  setOverlaysVisible(v: boolean) {
    this.helpers.visible = v;
    this.container.classList.toggle("overlays-off", !v);
    if (!v) this.constraintLine.visible = false;
  }

  // ---------------------------------------------------------------- sizing

  resize() {
    const r = this.container.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    this.renderer.setSize(this.width, this.height, false);
    this.perspCam.aspect = this.width / this.height;
    this.perspCam.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  private updateOrthoFrustum() {
    const aspect = this.width / this.height;
    const h = this.orthoHeight / 2;
    this.orthoCam.left = -h * aspect;
    this.orthoCam.right = h * aspect;
    this.orthoCam.top = h;
    this.orthoCam.bottom = -h;
    this.orthoCam.updateProjectionMatrix();
  }

  get isOrtho() {
    return this.activeCam === this.orthoCam;
  }

  private setActive(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    this.activeCam = cam;
    this.controls.object = cam;
  }

  /** Current visible world height at the orbit target (works for both projections). */
  private visibleHeightAtTarget() {
    if (this.isOrtho) return this.orthoHeight / this.orthoCam.zoom;
    const d = this.perspCam.position.distanceTo(this.controls.target);
    return 2 * d * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2);
  }

  private forward(cam: THREE.Camera = this.activeCam) {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  }

  // ---------------------------------------------------------------- projection modes

  /** Place the view looking along `-dir` toward the target, keeping framing. */
  private placeView(dir: THREE.Vector3, ortho: boolean, height = this.visibleHeightAtTarget()) {
    const target = this.controls.target;
    const d = dir.clone().normalize();
    if (Math.abs(d.z) > 0.9999) d.set(0, -1e-4, Math.sign(d.z)).normalize();
    if (ortho) {
      this.orthoHeight = height;
      this.orthoCam.zoom = 1;
      this.updateOrthoFrustum();
      this.orthoCam.position.copy(target).addScaledVector(d, ORTHO_DISTANCE);
      this.setActive(this.orthoCam);
    } else {
      const dist = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2));
      this.perspCam.position.copy(target).addScaledVector(d, dist);
      this.setActive(this.perspCam);
    }
    this.activeCam.lookAt(target);
    this.controls.update();
    this.onViewChanged();
  }

  toggleProjection() {
    this.unlock();
    const dir = this.activeCam.position.clone().sub(this.controls.target);
    this.placeView(dir, !this.isOrtho);
  }

  /** Align the view to look from `dir` (e.g. +X = look from the +X side). */
  snapView(dir: THREE.Vector3) {
    this.unlock();
    this.placeView(dir, this.isOrtho);
  }

  isoView() {
    this.unlock();
    // True isometric: equal foreshortening on all three axes (elevation ≈ 35.264°).
    this.placeView(new THREE.Vector3(1, -1, 1), true);
  }

  frame(el: SceneElement | null) {
    this.unlock();
    let center: THREE.Vector3, radius: number;
    if (el instanceof SplatElement && el.loaded) {
      const box = el.bounds.clone().applyMatrix4(el.root.matrixWorld);
      center = box.getCenter(new THREE.Vector3());
      radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
    } else if (el) {
      center = el.root.getWorldPosition(new THREE.Vector3());
      radius = el.kind === "cutplane" ? 3 : 1.5;
    } else {
      const splats = this.editor.splats().filter((s) => s.loaded);
      if (splats.length === 0) return;
      const box = new THREE.Box3();
      splats.forEach((s) => box.union(s.bounds.clone().applyMatrix4(s.root.matrixWorld)));
      center = box.getCenter(new THREE.Vector3());
      radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
    }
    const dir = this.activeCam.position.clone().sub(this.controls.target);
    this.controls.target.copy(center);
    this.placeView(dir, this.isOrtho, radius * 2.2);
  }

  // ---------------------------------------------------------------- camera lock ("look from camera")

  lookFrom(cam: CameraElement) {
    this.lockedCamera?.setViewing(false);
    this.lockedCamera = cam;
    cam.setViewing(true);
    this.setActive(cam.type === "pinhole" ? this.perspCam : this.orthoCam);
    this.applyLock();
    this.onViewChanged();
  }

  private applyLock() {
    const cam = this.lockedCamera!;
    const view = this.activeCam;
    cam.root.updateMatrixWorld();
    cam.root.matrixWorld.decompose(view.position, view.quaternion, new THREE.Vector3());
    const proj = cam.projection(this.width, this.height);
    view.projectionMatrix.copy(proj.matrix);
    view.projectionMatrixInverse.copy(proj.matrix).invert();
    view.updateMatrixWorld();
    this.lockedProjection = proj;
    // Keep the orbit target in front so orbiting after unlocking feels natural.
    const dist = Math.max(1, this.controls.target.distanceTo(view.position));
    this.controls.target.copy(view.position).addScaledVector(this.forward(view), dist);
  }

  /** Leave camera view, keeping the current pose as a free view. */
  unlock() {
    const cam = this.lockedCamera;
    if (!cam) return;
    cam.setViewing(false);
    this.lockedCamera = null;
    this.lockedProjection = null;
    const { s } = cam.fit(this.width, this.height);
    if (cam.type === "pinhole") {
      this.perspCam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(this.height / (2 * cam.fy * s)));
      this.perspCam.updateProjectionMatrix();
    } else {
      const img = cam.orthoImageSize();
      this.orthoHeight = (img.w / (cam.width * s)) * this.height;
      this.orthoCam.zoom = 1;
      this.updateOrthoFrustum();
    }
    this.onViewChanged();
  }

  // ---------------------------------------------------------------- per-frame

  update() {
    if (this.lockedCamera) {
      if (!this.editor.elements.includes(this.lockedCamera)) this.unlock();
      else this.applyLock();
    }
    const f = this.lockedProjection?.frame;
    this.frameEl.classList.toggle("hidden", !f);
    if (f) {
      Object.assign(this.frameEl.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
    }
    const label = this.lockedCamera ? `Camera view: ${this.lockedCamera.name}` : this.isOrtho ? "User orthographic" : "User perspective";
    if (this.labelEl.textContent !== label) this.labelEl.textContent = label;
    this.labelEl.classList.remove("hidden");
  }

  render() {
    this.renderer.render(this.editor.scene, this.activeCam);
  }

  // ---------------------------------------------------------------- math helpers

  worldToPixel(p: THREE.Vector3) {
    const v = p.clone().project(this.activeCam);
    return new THREE.Vector2(((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.height);
  }

  /** World units per screen pixel at world point p. */
  worldPerPixel(p: THREE.Vector3) {
    const cam = this.activeCam;
    const e = cam.projectionMatrix.elements;
    if (e[11] === -1) {
      const depth = -p.clone().applyMatrix4(cam.matrixWorldInverse).z;
      return (2 * Math.max(depth, 1e-3)) / (e[5] * this.height);
    }
    return 2 / (e[5] * this.height);
  }

  toNdc(x: number, y: number) {
    return new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
  }

  // ---------------------------------------------------------------- picking

  /** Pick the element under the given viewport pixel. Gizmo lines win over splats. */
  pick(x: number, y: number): SceneElement | null {
    const cam = this.activeCam;
    cam.updateMatrixWorld();
    const viewProj = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const mouse = new THREE.Vector2(x, y);
    let best: SceneElement | null = null;
    let bestDist = PICK_PIXELS;

    const toScreen = (v: THREE.Vector3, out: THREE.Vector2) => {
      const c = new THREE.Vector4(v.x, v.y, v.z, 1).applyMatrix4(viewProj);
      if (c.w <= 1e-6) return false;
      out.set(((c.x / c.w + 1) / 2) * this.width, ((1 - c.y / c.w) / 2) * this.height);
      return true;
    };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), sa = new THREE.Vector2(), sb = new THREE.Vector2();

    for (const el of this.editor.elements) {
      for (const line of el.pickLines()) {
        line.updateWorldMatrix(true, false);
        const pos = line.geometry.getAttribute("position");
        const step = (line as THREE.LineSegments).isLineSegments ? 2 : 1;
        for (let i = 0; i + 1 < pos.count; i += step) {
          a.fromBufferAttribute(pos, i).applyMatrix4(line.matrixWorld);
          b.fromBufferAttribute(pos, i + 1).applyMatrix4(line.matrixWorld);
          if (!toScreen(a, sa) || !toScreen(b, sb)) continue;
          const d = distToSegment(mouse, sa, sb);
          if (d < bestDist) {
            bestDist = d;
            best = el;
          }
        }
      }
    }
    if (best) return best;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.toNdc(x, y), cam);
    let bestT = Infinity;
    for (const el of this.editor.splats()) {
      if (!el.loaded || !el.visible) continue;
      const hits = raycaster.intersectObject(el.mesh, false);
      const hit = hits.find((h) => !this.editor.isCut(h.point));
      if (hit && hit.distance < bestT) {
        bestT = hit.distance;
        best = el;
      }
    }
    return best;
  }

  /** Copy the current free view into a scene camera (pose + matching projection). */
  copyViewToCamera(cam: CameraElement) {
    const view = this.activeCam;
    view.updateMatrixWorld();
    cam.root.position.copy(view.position);
    cam.root.quaternion.copy(view.quaternion);
    const { s } = cam.fit(this.width, this.height);
    if (this.isOrtho) {
      cam.type = "orthographic";
      const wpp = this.orthoHeight / this.orthoCam.zoom / this.height;
      cam.orthoScale = Math.max(cam.width, cam.height) * s * wpp;
    } else {
      cam.type = "pinhole";
      const F = this.height / 2 / Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2);
      cam.fx = cam.fy = F / s;
      cam.cx = cam.width / 2;
      cam.cy = cam.height / 2;
    }
    cam.rebuildGizmo();
  }
}

function distToSegment(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) {
  const ab = b.clone().sub(a);
  const len2 = ab.lengthSq();
  const t = len2 > 0 ? THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / len2, 0, 1) : 0;
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}
