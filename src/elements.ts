import * as THREE from "three";
import { SplatEditSdf, SplatEditSdfType, SplatMesh } from "@sparkjsdev/spark";
import { makeDepthUniforms, type MeshDepthUniforms, patchPointDepthShader, setMeshDepthRange, setSplatDepthView } from "./depth";
import { patchPointCutShader } from "./cuts";

export const SELECT_COLOR = new THREE.Color(0xff8c1a);
export const AXIS_COLORS = [new THREE.Color(0xff3352), new THREE.Color(0x8bdc00), new THREE.Color(0x2890ff)];

/**
 * three.js layer of every overlay object (gizmos, wireframes, outlines, grid). Each view
 * enables it on its camera when its overlays are on; PNG renders never do.
 */
export const OVERLAY_LAYER = 1;
/**
 * Layer of the SplatMesh each view renders (index = view index). Views get their own
 * SplatMesh per splat (sharing the GPU data) because Spark keeps per-mesh view state
 * (e.g. the eye position for spherical harmonics): two views sharing a mesh would
 * invalidate each other every frame.
 */
export const SPLAT_LAYERS = [2, 3];

export type ElementKind = "camera" | "splat" | "cutplane" | "cutbox";

let nextId = 1;

/**
 * Base class for everything that lives in the hierarchy. `root` holds the pose
 * (position / quaternion / scale) and is a direct child of the scene, so local == world.
 */
export abstract class SceneElement {
  readonly id = nextId++;
  abstract readonly kind: ElementKind;
  readonly root = new THREE.Object3D();
  name: string;
  selected = false;
  canRotate = true;
  canScale = true;

  constructor(name: string) {
    this.name = name;
    this.root.userData.element = this;
  }

  /**
   * Splats are drawn in the transparent pass without writing depth, so overlay
   * gizmos must be transparent too and come later to stay visible on top.
   */
  protected markOverlay(obj: THREE.Object3D, alwaysOnTop = false) {
    obj.traverse((o) => {
      o.renderOrder = 10;
      o.layers.set(OVERLAY_LAYER);
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mat) {
        mat.transparent = true;
        if (alwaysOnTop) mat.depthTest = false;
      }
    });
  }

  /** Line objects that can be picked by clicking near them in screen space. */
  abstract pickLines(): THREE.Line[];

  setSelected(selected: boolean) {
    this.selected = selected;
    this.updateAppearance();
  }

  protected abstract updateAppearance(): void;

  /** Scale as edited by the S tool and the properties panel (elements may map it to their own size). */
  getScale(out = new THREE.Vector3()) {
    return out.copy(this.root.scale);
  }

  setScale(s: THREE.Vector3) {
    this.root.scale.copy(s);
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const any = o as THREE.Mesh;
      any.geometry?.dispose?.();
      const mat = any.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose?.();
    });
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export type CameraType = "pinhole" | "orthographic";

export interface CameraProjection {
  matrix: THREE.Matrix4;
  /** The image rectangle inside the viewport, in CSS pixels. */
  frame: { x: number; y: number; w: number; h: number };
  isPerspective: boolean;
}

/**
 * A scene camera. Uses the three.js convention: looks down local -Z with +Y up.
 * Pinhole intrinsics follow the OpenCV convention (pixels, origin top-left).
 */
export class CameraElement extends SceneElement {
  readonly kind = "camera" as const;
  type: CameraType = "pinhole";
  width = 1920;
  height = 1080;
  fx = 1400;
  fy = 1400;
  cx = 960;
  cy = 540;
  orthoScale = 10;
  near = 0.05;
  far = 2000;

  private material = new THREE.LineBasicMaterial({ color: 0xd0d0d0 });
  private gizmo = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);

  constructor(name: string) {
    super(name);
    this.canScale = false;
    this.root.add(this.gizmo);
    this.markOverlay(this.gizmo);
    this.rebuildGizmo();
  }

  pickLines() {
    return [this.gizmo];
  }

  protected updateAppearance() {
    this.material.color.set(this.selected ? SELECT_COLOR : 0xd0d0d0);
  }

  /** Hidden while a view renders through this camera. */
  setGizmoVisible(visible: boolean) {
    this.gizmo.visible = visible;
  }

  /** Image size in world units for orthographic cameras (orthoScale spans the larger side, like Blender). */
  orthoImageSize() {
    const aspect = this.width / this.height;
    return aspect >= 1
      ? { w: this.orthoScale, h: this.orthoScale / aspect }
      : { w: this.orthoScale * aspect, h: this.orthoScale };
  }

  rebuildGizmo() {
    const pts: number[] = [];
    const seg = (a: number[], b: number[]) => pts.push(...a, ...b);
    if (this.type === "pinhole") {
      const d = 0.6;
      const corner = (u: number, v: number) => [((u - this.cx) / this.fx) * d, (-(v - this.cy) / this.fy) * d, -d];
      const tl = corner(0, 0), tr = corner(this.width, 0), br = corner(this.width, this.height), bl = corner(0, this.height);
      const o = [0, 0, 0];
      seg(o, tl); seg(o, tr); seg(o, br); seg(o, bl);
      seg(tl, tr); seg(tr, br); seg(br, bl); seg(bl, tl);
      // "Up" triangle above the top edge, like Blender.
      const w = tr[0] - tl[0];
      const midX = (tl[0] + tr[0]) / 2;
      const a = [midX - w * 0.3, tl[1] + w * 0.05, -d], b = [midX + w * 0.3, tl[1] + w * 0.05, -d], c = [midX, tl[1] + w * 0.3, -d];
      seg(a, b); seg(b, c); seg(c, a);
    } else {
      const { w, h } = this.orthoImageSize();
      const hw = w / 2, hh = h / 2, d = Math.max(0.5, Math.min(w, h) * 0.15);
      const rect = (z: number) => {
        seg([-hw, -hh, z], [hw, -hh, z]); seg([hw, -hh, z], [hw, hh, z]);
        seg([hw, hh, z], [-hw, hh, z]); seg([-hw, hh, z], [-hw, -hh, z]);
      };
      rect(0); rect(-d);
      seg([-hw, -hh, 0], [-hw, -hh, -d]); seg([hw, -hh, 0], [hw, -hh, -d]);
      seg([hw, hh, 0], [hw, hh, -d]); seg([-hw, hh, 0], [-hw, hh, -d]);
      seg([0, 0, 0], [0, 0, -2 * d]);
      const a = [-hw * 0.3, hh * 1.05, 0], b = [hw * 0.3, hh * 1.05, 0], c = [0, hh + hw * 0.3, 0];
      seg(a, b); seg(b, c); seg(c, a);
    }
    this.gizmo.geometry.dispose();
    this.gizmo.geometry = new THREE.BufferGeometry();
    this.gizmo.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  }

  /** Fit factor (viewport px per image px) and image rectangle when showing this camera in a viewport. */
  fit(viewW: number, viewH: number) {
    const s = Math.min(viewW / this.width, viewH / this.height);
    const w = this.width * s, h = this.height * s;
    return { s, frame: { x: (viewW - w) / 2, y: (viewH - h) / 2, w, h } };
  }

  /** Projection matrix that shows this camera's full image letterboxed inside a viewW x viewH viewport. */
  projection(viewW: number, viewH: number): CameraProjection {
    const { s, frame } = this.fit(viewW, viewH);
    const n = this.near, f = this.far;
    const m = new THREE.Matrix4();
    if (this.type === "pinhole") {
      const fx = this.fx * s, fy = this.fy * s;
      const cx = this.cx * s + frame.x, cy = this.cy * s + frame.y;
      m.set(
        (2 * fx) / viewW, 0, 1 - (2 * cx) / viewW, 0,
        0, (2 * fy) / viewH, (2 * cy) / viewH - 1, 0,
        0, 0, -(f + n) / (f - n), (-2 * f * n) / (f - n),
        0, 0, -1, 0,
      );
      return { matrix: m, frame, isPerspective: true };
    }
    const img = this.orthoImageSize();
    const wpp = img.w / frame.w; // world units per viewport pixel
    const hw = (viewW / 2) * wpp, hh = (viewH / 2) * wpp;
    m.makeOrthographic(-hw, hw, hh, -hh, n, f);
    return { matrix: m, frame, isPerspective: false };
  }
}

// ---------------------------------------------------------------------------
// Gaussian splat scene
// ---------------------------------------------------------------------------

export type RenderMode = "splat" | "points";

export class SplatElement extends SceneElement {
  readonly kind = "splat" as const;
  readonly mesh: SplatMesh;
  readonly ready: Promise<void>;
  renderMode: RenderMode = "splat";
  pointSize = 2;
  visible = true;
  loaded = false;
  loadProgress = 0;
  numSplats = 0;
  /** Gaussians currently colored by depth (see depth.ts). */
  depthView = false;
  /** Up to ~20k local-space splat centers (xyz triplets), used for the automatic depth range. */
  samples = new Float32Array(0);
  /** Robust (1st–99th percentile) local bounding box of the splat centers. */
  readonly bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));

  private points: THREE.Points | null = null;
  /** SplatMesh rendered by each view (index 0 = `mesh`); created lazily. */
  private viewMeshes: SplatMesh[] = [];
  private depthUniforms = new Map<SplatMesh, MeshDepthUniforms>();
  private outline = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: SELECT_COLOR }),
  );

  constructor(
    name: string,
    bytes: ArrayBuffer,
    /** Original file name (its extension tells Spark the format). */
    readonly fileName: string,
    /** The original file bytes (disk-backed Blob), embedded when saving a project. */
    public source: Blob,
    onProgress?: () => void,
  ) {
    super(name);
    this.mesh = new SplatMesh({
      fileBytes: bytes,
      fileName,
      onProgress: (e) => {
        if (e.lengthComputable) this.loadProgress = e.loaded / e.total;
        onProgress?.();
      },
    });
    this.mesh.layers.set(SPLAT_LAYERS[0]);
    this.viewMeshes.push(this.mesh);
    this.root.add(this.mesh);
    this.outline.visible = false;
    this.markOverlay(this.outline, true);
    this.root.add(this.outline);
    this.ready = this.mesh.initialized.then(() => this.onLoaded());
  }

  pickLines() {
    return [];
  }

  protected updateAppearance() {
    this.outline.visible = this.selected && this.loaded;
  }

  private onLoaded() {
    this.loaded = true;
    this.numSplats = this.mesh.numSplats;
    // Sample centers to compute a bounding box that ignores floaters.
    const maxSamples = 200_000;
    const stride = Math.max(1, Math.floor(this.numSplats / maxSamples));
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    const sampleStride = Math.max(1, Math.floor(this.numSplats / 20_000));
    const samples: number[] = [];
    this.mesh.forEachSplat((i, c, _s, _q, opacity) => {
      if (i % sampleStride === 0 && opacity > 0.1) samples.push(c.x, c.y, c.z);
      if (i % stride !== 0) return;
      xs.push(c.x); ys.push(c.y); zs.push(c.z);
    });
    this.samples = Float32Array.from(samples);
    if (xs.length > 0) {
      const pct = (a: number[], p: number) => {
        a.sort((u, v) => u - v);
        return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
      };
      this.bounds.min.set(pct(xs, 0.01), pct(ys, 0.01), pct(zs, 0.01));
      this.bounds.max.set(pct(xs, 0.99), pct(ys, 0.99), pct(zs, 0.99));
    }
    const box = new THREE.Box3Helper(this.bounds);
    this.outline.geometry.dispose();
    this.outline.geometry = box.geometry.clone();
    // Box3Helper encodes a unit cube scaled at render time; bake it.
    const size = this.bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const center = this.bounds.getCenter(new THREE.Vector3());
    this.outline.geometry.scale(size.x, size.y, size.z);
    this.outline.geometry.translate(center.x, center.y, center.z);
    box.dispose();
    this.updateVisibility();
    this.updateAppearance();
  }

  setRenderMode(mode: RenderMode) {
    this.renderMode = mode;
    if (mode === "points" && !this.points && this.loaded) this.buildPoints();
    this.updateVisibility();
  }

  setPointSize(size: number) {
    this.pointSize = size;
    if (this.points) (this.points.material as THREE.PointsMaterial).size = size;
  }

  /** The SplatMesh a view renders (created on first use, sharing this splat's GPU data). */
  viewMesh(index: number): SplatMesh {
    let m = this.viewMeshes[index];
    if (m) return m;
    m = new SplatMesh({ packedSplats: this.mesh.packedSplats, extSplats: this.mesh.extSplats });
    m.layers.set(SPLAT_LAYERS[index]);
    this.viewMeshes[index] = m;
    this.root.add(m);
    this.updateVisibility();
    if (this.depthView) setSplatDepthView(m, this.meshDepth(m), true);
    return m;
  }

  private meshDepth(m: SplatMesh) {
    let u = this.depthUniforms.get(m);
    if (!u) this.depthUniforms.set(m, (u = makeDepthUniforms()));
    return u;
  }

  setDepthView(on: boolean) {
    this.depthView = on;
    for (const m of this.viewMeshes) if (m) setSplatDepthView(m, this.meshDepth(m), on);
  }

  setDepthRange(viewIndex: number, min: number, max: number) {
    const m = this.viewMesh(viewIndex);
    setMeshDepthRange(m, this.meshDepth(m), min, max);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.updateVisibility();
  }

  private updateVisibility() {
    for (const m of this.viewMeshes) if (m) m.visible = this.visible && this.renderMode === "splat";
    if (this.points) this.points.visible = this.visible && this.renderMode === "points";
  }

  private buildPoints() {
    const n = this.mesh.numSplats;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const tmp = new THREE.Color();
    let k = 0;
    this.mesh.forEachSplat((_i, c, _s, _q, opacity, color) => {
      if (opacity < 0.05) return;
      pos[k * 3] = c.x; pos[k * 3 + 1] = c.y; pos[k * 3 + 2] = c.z;
      // Splat colors are display (sRGB) values; three expects linear vertex colors.
      tmp.setRGB(Math.min(1, Math.max(0, color.r)), Math.min(1, Math.max(0, color.g)), Math.min(1, Math.max(0, color.b)), THREE.SRGBColorSpace);
      col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;
      k++;
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col.subarray(0, k * 3), 3));
    const mat = new THREE.PointsMaterial({ size: this.pointSize, sizeAttenuation: false, vertexColors: true });
    // Shared uniforms (see cuts.ts / depth.ts) drive cuts and depth coloring.
    mat.onBeforeCompile = (shader) => {
      patchPointCutShader(shader);
      patchPointDepthShader(shader);
    };
    this.points = new THREE.Points(geom, mat);
    this.points.raycast = () => {}; // picking goes through the splat mesh
    this.root.add(this.points);
  }

  override dispose() {
    // View meshes share the main mesh's data: detach it so it's freed only once.
    for (const m of this.viewMeshes.slice(1)) {
      if (!m) continue;
      m.packedSplats = undefined;
      m.extSplats = undefined;
      m.splats = undefined;
      m.dispose();
    }
    this.mesh.dispose();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------

const Z_AXIS = new THREE.Vector3(0, 0, 1);
/** How far a cut-plane's removal region extends behind the plane (meters). */
const CUT_PLANE_DEPTH = 1000;
/** In-plane half size used for unbounded cut-planes (meters): effectively infinite. */
const UNBOUNDED_HALF = 10_000;

/**
 * Base for elements that remove gaussians: each describes an oriented box
 * (center, rotation, half extents). Everything inside an enabled box is hidden,
 * for gaussians (Spark BOX SDF, opacity 0) and point clouds (shader test).
 */
export abstract class CutElement extends SceneElement {
  enabled = true;
  readonly sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0 });
  /** World -> box-local transform and half extents of the removal box (updated by syncCut). */
  readonly inverse = new THREE.Matrix4();
  readonly half = new THREE.Vector3();

  protected abstract computeBox(center: THREE.Vector3, quat: THREE.Quaternion, half: THREE.Vector3): void;

  /** True: removes what is inside the box. False: removes everything outside it (keeps the inside). */
  removesInside() {
    return true;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.updateAppearance();
  }

  /** Push the current pose into the Spark SDF and the point-cloud box. */
  syncCut() {
    const center = new THREE.Vector3(), quat = new THREE.Quaternion();
    this.computeBox(center, quat, this.half);
    this.half.set(Math.abs(this.half.x), Math.abs(this.half.y), Math.abs(this.half.z));
    this.sdf.position.copy(center);
    this.sdf.quaternion.copy(quat);
    this.sdf.scale.copy(this.half); // Spark reads the box half extents from the SDF's scale
    // Inverted SDF: "inside" (removed) becomes everything outside the box.
    this.sdf.invert = !this.removesInside();
    this.inverse.compose(center, quat, new THREE.Vector3(1, 1, 1)).invert();
  }

  /** True if a world-space point is removed by this cut (call syncCut first). */
  cuts(p: THREE.Vector3) {
    if (!this.enabled) return false;
    const l = p.clone().applyMatrix4(this.inverse);
    const inside = Math.abs(l.x) <= this.half.x && Math.abs(l.y) <= this.half.y && Math.abs(l.z) <= this.half.z;
    return inside === this.removesInside();
  }
}

// ---------------------------------------------------------------------------
// Cut plane
// ---------------------------------------------------------------------------

export type CutDirection = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
export const CUT_DIRECTIONS: CutDirection[] = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];
export const AXIS_LETTERS = ["x", "y", "z"] as const;

/**
 * A bounded cut-plane: removes the gaussians behind the plane (opposite to the cut
 * direction) that also fall inside the plane's rectangle. With +Y, gaussians with
 * y < plane.y whose x/z are within the rectangle are hidden.
 * The rectangle is sized along the two world axes in the plane (`extent`, also
 * editable with the S tool); the extent along the normal axis is unused.
 */
export class CutPlaneElement extends CutElement {
  readonly kind = "cutplane" as const;
  direction: CutDirection;
  /** Rectangle size along each world axis (the normal axis component is ignored). */
  readonly extent = new THREE.Vector3(10, 10, 10);
  /**
   * Only cut inside the rectangle. Unbounded planes cut the whole half-space behind
   * them (the rectangle is then just for display), like cut-planes before rectangles
   * existed: useful to remove far-away floaters.
   */
  bounded = true;

  private visual = new THREE.Object3D();
  private wireMat = new THREE.LineBasicMaterial({ color: 0x7fc8ff, transparent: true, opacity: 0.35 });
  private borderMat = new THREE.LineBasicMaterial({ color: 0x7fc8ff });
  private wire = new THREE.LineSegments(new THREE.BufferGeometry(), this.wireMat);
  private border = new THREE.LineSegments(new THREE.BufferGeometry(), this.borderMat);
  private arrow: THREE.ArrowHelper;

  constructor(name: string, direction: CutDirection) {
    super(name);
    this.direction = direction;
    this.canRotate = false;
    this.arrow = new THREE.ArrowHelper(Z_AXIS, new THREE.Vector3(), 1, 0xffffff);
    this.visual.add(this.wire, this.border, this.arrow);
    this.root.add(this.visual);
    this.markOverlay(this.visual);
    this.rebuild();
  }

  dirVector(out = new THREE.Vector3()) {
    out.set(0, 0, 0).setComponent(this.axisIndex(), this.direction[0] === "+" ? 1 : -1);
    return out;
  }

  axisIndex() {
    return "XYZ".indexOf(this.direction[1]);
  }

  /** The two in-plane world axes (u, v) and a right-handed rotation whose local x/y/z = u/v/normal. */
  basis() {
    const k = this.axisIndex();
    const iu = (k + 1) % 3, iv = (k + 2) % 3;
    const n = this.dirVector();
    const eu = new THREE.Vector3().setComponent(iu, 1);
    const ev = new THREE.Vector3().setComponent(iv, 1);
    if (new THREE.Vector3().crossVectors(eu, ev).dot(n) < 0) ev.negate();
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(eu, ev, n));
    return { iu, iv, n, quat };
  }

  setDirection(d: CutDirection) {
    this.direction = d;
    this.rebuild();
  }

  /** Set the rectangle size along a world axis. */
  setExtent(axis: number, size: number) {
    this.extent.setComponent(axis, Math.max(0.01, Math.abs(size)));
    this.rebuild();
  }

  override getScale(out = new THREE.Vector3()) {
    return out.copy(this.extent);
  }

  override setScale(s: THREE.Vector3) {
    this.extent.set(Math.max(0.01, Math.abs(s.x)), Math.max(0.01, Math.abs(s.y)), Math.max(0.01, Math.abs(s.z)));
    this.rebuild();
  }

  rebuild() {
    const { iu, iv, quat } = this.basis();
    const hu = this.extent.getComponent(iu) / 2, hv = this.extent.getComponent(iv) / 2;
    const div = 10;
    const pts: number[] = [];
    for (let i = 1; i < div; i++) {
      const tu = -hu + (i / div) * 2 * hu, tv = -hv + (i / div) * 2 * hv;
      pts.push(tu, -hv, 0, tu, hv, 0, -hu, tv, 0, hu, tv, 0);
    }
    this.wire.geometry.dispose();
    this.wire.geometry = new THREE.BufferGeometry();
    this.wire.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const b = [-hu, -hv, 0, hu, -hv, 0, hu, -hv, 0, hu, hv, 0, hu, hv, 0, -hu, hv, 0, -hu, hv, 0, -hu, -hv, 0];
    this.border.geometry.dispose();
    this.border.geometry = new THREE.BufferGeometry();
    this.border.geometry.setAttribute("position", new THREE.Float32BufferAttribute(b, 3));

    const len = THREE.MathUtils.clamp(Math.min(hu, hv) * 0.3, 0.3, 3);
    this.arrow.setLength(len, len * 0.25, len * 0.12);
    this.visual.quaternion.copy(quat);
    this.updateAppearance();
  }

  pickLines() {
    return [this.border, this.arrow.line];
  }

  protected updateAppearance() {
    const base = this.enabled ? new THREE.Color(0x7fc8ff) : new THREE.Color(0x777777);
    this.borderMat.color.copy(this.selected ? SELECT_COLOR : base);
    this.wireMat.color.copy(this.selected ? SELECT_COLOR : base);
    this.arrow.setColor(this.selected ? SELECT_COLOR : AXIS_COLORS[this.axisIndex()]);
  }

  /** Removal region: the rectangle extruded CUT_PLANE_DEPTH meters behind the plane. */
  protected computeBox(center: THREE.Vector3, quat: THREE.Quaternion, half: THREE.Vector3) {
    this.root.quaternion.identity();
    this.root.scale.set(1, 1, 1);
    const { iu, iv, n, quat: q } = this.basis();
    center.copy(this.root.position).addScaledVector(n, -CUT_PLANE_DEPTH / 2);
    quat.copy(q);
    if (this.bounded) half.set(this.extent.getComponent(iu) / 2, this.extent.getComponent(iv) / 2, CUT_PLANE_DEPTH / 2);
    else half.set(UNBOUNDED_HALF, UNBOUNDED_HALF, CUT_PLANE_DEPTH / 2);
  }
}

// ---------------------------------------------------------------------------
// Cut box
// ---------------------------------------------------------------------------

const BOX_COLOR = new THREE.Color(0xff7ad9);

/**
 * Crops to a box: by default keeps what is inside and removes everything outside;
 * inverted, removes what is inside and keeps the rest. The box is a unit cube
 * transformed by the element's pose, so its size in meters is its scale (G/R/S apply).
 */
export class CutBoxElement extends CutElement {
  readonly kind = "cutbox" as const;
  /** false: keep inside, remove outside (crop). true: remove inside, keep outside. */
  invert = false;
  private edgeMat = new THREE.LineBasicMaterial({ color: BOX_COLOR });
  private faceMat = new THREE.LineBasicMaterial({ color: BOX_COLOR, transparent: true, opacity: 0.3 });
  private edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), this.edgeMat);
  /** Face diagonals, shown when the box removes its inside (it reads as a solid block). */
  private faces: THREE.LineSegments;

  constructor(name: string) {
    super(name);
    const d: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
      for (const side of [-0.5, 0.5]) {
        const a = (axis + 1) % 3, b = (axis + 2) % 3;
        const p = (u: number, v: number) => {
          const v3 = [0, 0, 0];
          v3[axis] = side; v3[a] = u; v3[b] = v;
          return v3;
        };
        d.push(...p(-0.5, -0.5), ...p(0.5, 0.5), ...p(-0.5, 0.5), ...p(0.5, -0.5));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(d, 3));
    this.faces = new THREE.LineSegments(g, this.faceMat);
    this.root.add(this.edges, this.faces);
    this.markOverlay(this.edges);
    this.markOverlay(this.faces);
    this.updateAppearance();
  }

  pickLines() {
    return [this.edges];
  }

  protected updateAppearance() {
    const base = this.enabled ? BOX_COLOR : new THREE.Color(0x777777);
    this.edgeMat.color.copy(this.selected ? SELECT_COLOR : base);
    this.faceMat.color.copy(this.selected ? SELECT_COLOR : base);
    this.faces.visible = this.invert;
  }

  override removesInside() {
    return this.invert;
  }

  setInvert(invert: boolean) {
    this.invert = invert;
    this.updateAppearance();
  }

  protected computeBox(center: THREE.Vector3, quat: THREE.Quaternion, half: THREE.Vector3) {
    this.root.updateMatrixWorld();
    center.copy(this.root.position);
    quat.copy(this.root.quaternion);
    half.copy(this.root.scale).multiplyScalar(0.5);
  }
}
