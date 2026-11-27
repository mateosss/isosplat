import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { type CameraElement, SceneElement, SELECT_COLOR, type SplatElement } from "./elements";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface Poses {
  /** Seconds (absolute, as in the file). */
  t: Float64Array;
  /** xyz per pose. */
  p: Float32Array;
  /** Quaternion xyzw per pose. */
  q: Float32Array;
  format: "tum" | "euroc";
}

export const TRAJECTORY_EXTENSIONS = /\.(tum|txt|csv)$/i;

/**
 * Parse a trajectory of poses T_world_camera:
 * - TUM: `timestamp tx ty tz qx qy qz qw`, whitespace-separated, timestamp in seconds
 *   (values above 1e11 are taken as nanoseconds, as some tools write them).
 * - EuRoC CSV: `timestamp[ns], px, py, pz, qw, qx, qy, qz[, …]`, comma-separated (extra
 *   columns such as the ground truth's velocities and biases are ignored).
 * Lines starting with `#` and empty lines are skipped. Poses are sorted by time.
 */
export function parseTrajectory(text: string): Poses {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  if (!lines.length) throw new Error("no poses in the file");
  const euroc = lines[0].includes(",");
  const rows: number[][] = [];
  for (const [i, line] of lines.entries()) {
    const v = line.trim().split(euroc ? /\s*,\s*/ : /\s+/).map(Number);
    if (v.length < 8 || v.slice(0, 8).some((x) => !Number.isFinite(x))) {
      // A header without '#' (e.g. "timestamp,x,y,…") is fine; anything else is an error.
      if (i === 0 && Number.isNaN(v[0])) continue;
      throw new Error(`line ${i + 1}: expected 8 numbers, got "${line.trim().slice(0, 60)}"`);
    }
    rows.push(v);
  }
  if (!rows.length) throw new Error("no poses in the file");
  rows.sort((a, b) => a[0] - b[0]);
  const n = rows.length;
  const nanoseconds = euroc || Math.abs(rows[0][0]) > 1e11;
  const t = new Float64Array(n), p = new Float32Array(n * 3), q = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    t[i] = nanoseconds ? r[0] / 1e9 : r[0];
    p.set([r[1], r[2], r[3]], i * 3);
    // EuRoC: qw qx qy qz; TUM: qx qy qz qw.
    const [x, y, z, w] = euroc ? [r[5], r[6], r[7], r[4]] : [r[4], r[5], r[6], r[7]];
    const len = Math.hypot(x, y, z, w) || 1;
    q.set([x / len, y / len, z / len, w / len], i * 4);
  }
  return { t, p, q, format: euroc ? "euroc" : "tum" };
}

// ---------------------------------------------------------------------------
// Fat-line resolution
// ---------------------------------------------------------------------------

/** Every fat-line material: their pixel widths need the size of the image being rendered. */
const lineMaterials = new Set<LineMaterial>();

/** Set the target size (CSS px for views, image px for renders) before rendering. */
export function setLineResolution(w: number, h: number) {
  for (const m of lineMaterials) m.resolution.set(w, h);
}

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------

/** OpenCV camera (+Z forward, −Y up) to three.js camera (−Z forward, +Y up): 180° about X. */
const OPENCV_TO_THREE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

/** Frustum shape (the files have no intrinsics): 4:3 image, 60° horizontal field of view. */
const FRUSTUM_ASPECT = 4 / 3;
const FRUSTUM_HFOV = THREE.MathUtils.degToRad(60);

/**
 * A camera trajectory: the path through every pose and camera frustums at evenly spaced
 * points along it. Poses are T_world_camera with the camera looking down +Z and image up
 * along −Y (OpenCV / TUM / EuRoC convention).
 *
 * With a parent splat the trajectory follows the splat's transform (the poses are in the
 * splat's frame); the trajectory's own transform is applied on top, in world space.
 * It is scene content, not an overlay: it shows with overlays off and in PNG renders.
 */
export class TrajectoryElement extends SceneElement {
  readonly kind = "trajectory" as const;
  parent: SplatElement | null = null;
  visible = true;
  /** Trim, in seconds from the first pose. */
  start = 0;
  end: number;
  /** Number of frustums, spread evenly by distance along the trimmed path (first and last included). */
  cameraCount = 20;
  /** Frustum depth (m). */
  frustumSize = 0.15;
  frustumColor = "#22c3ee";
  pathColor = "#bef1ff";
  frustumOpacity = 0.8;
  pathOpacity = 0.6;
  showPath = true;
  /** Line width (px of the rendered image). */
  lineWidth = 2;
  /** Radius of the dot at each frustum's camera center (m); 0 hides the dots. */
  dotRadius = 0.02;
  /** Draw over the splats instead of being hidden by the gaussians in front of it. */
  onTop = false;
  /** Scene camera moved along the trajectory by the playhead (the properties panel creates one if needed). */
  camera: CameraElement | null = null;
  /** Playhead, in seconds from the first pose. */
  time = 0;
  /** Playing in real time (see step). */
  playing = false;
  /** Wall clock (ms) and playhead when playback started: real time even on slow frames. */
  private playAnchor = { wall: 0, time: 0 };

  /** Holds the parent's transform (see syncParent). */
  private content = new THREE.Group();
  private pathMat = new LineMaterial({ linewidth: 2 });
  private frustumMat = new LineMaterial({ linewidth: 2 });
  private path = new LineSegments2(new LineSegmentsGeometry(), this.pathMat);
  private frustums = new LineSegments2(new LineSegmentsGeometry(), this.frustumMat);
  private dotMat = new THREE.MeshBasicMaterial();
  private dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), this.dotMat, 1);
  /** 1 px copy of the lines on the overlay layer: picking and the selection highlight. */
  private proxy = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SELECT_COLOR }));

  constructor(
    name: string,
    readonly poses: Poses,
    /** Original file name and bytes, embedded when saving a project. */
    readonly fileName: string,
    public source: Blob,
  ) {
    super(name);
    this.end = this.duration;
    this.content.matrixAutoUpdate = false;
    this.root.add(this.content);
    this.content.add(this.path, this.frustums, this.dots, this.proxy);
    this.markOverlay(this.proxy);
    this.proxy.raycast = () => {};
    for (const m of [this.pathMat, this.frustumMat]) lineMaterials.add(m);
    // Bounding spheres would be computed once; positions change on every rebuild.
    for (const o of [this.path, this.frustums, this.dots]) o.frustumCulled = false;
    this.rebuild();
  }

  get duration() {
    const t = this.poses.t;
    return t.length ? t[t.length - 1] - t[0] : 0;
  }

  get count() {
    return this.poses.t.length;
  }

  pickLines() {
    return [this.proxy];
  }

  protected updateAppearance() {
    this.proxy.visible = this.selected && this.visible;
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.content.visible = v;
    this.updateAppearance();
  }

  /**
   * Show or hide the frustums, dots and selection highlight (not the path), for a view that looks
   * through this trajectory's camera. Hiding restores exactly what was shown before.
   */
  setCameraMarksVisible(visible: boolean) {
    if (!visible) {
      this.marksShown = [this.frustums.visible, this.dots.visible, this.proxy.visible];
      this.frustums.visible = this.dots.visible = this.proxy.visible = false;
    } else if (this.marksShown) {
      [this.frustums.visible, this.dots.visible, this.proxy.visible] = this.marksShown;
      this.marksShown = null;
    }
  }
  private marksShown: [boolean, boolean, boolean] | null = null;

  /** Called every frame: follow the parent splat. */
  syncParent(splats: SplatElement[]) {
    if (this.parent && !splats.includes(this.parent)) this.parent = null;
    if (this.parent) {
      this.parent.root.updateMatrixWorld();
      this.content.matrix.copy(this.parent.root.matrixWorld);
    } else {
      this.content.matrix.identity();
    }
    this.content.matrixWorldNeedsUpdate = true;
  }

  /** Indices of the poses inside the trim. */
  trimmed(): [number, number] {
    const t = this.poses.t;
    const t0 = t[0];
    let i = 0, j = t.length - 1;
    while (i < t.length && t[i] - t0 < this.start) i++;
    while (j >= 0 && t[j] - t0 > this.end) j--;
    return [i, j];
  }

  /** Pose indices of the frustums: evenly spaced by distance along the trimmed path. */
  private cameraIndices(i0: number, i1: number) {
    const n = Math.min(Math.max(0, Math.round(this.cameraCount)), i1 - i0 + 1);
    if (n <= 0) return [];
    if (n === 1) return [i0];
    const p = this.poses.p;
    const cum = [0];
    for (let i = i0 + 1; i <= i1; i++) {
      const d = Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2], p[i * 3 + 2] - p[i * 3 - 1]);
      cum.push(cum[cum.length - 1] + d);
    }
    const total = cum[cum.length - 1];
    const out: number[] = [];
    let k = 0;
    for (let c = 0; c < n; c++) {
      if (total < 1e-9) {
        out.push(i0 + Math.round((c / (n - 1)) * (i1 - i0)));
        continue;
      }
      const target = (c / (n - 1)) * total;
      while (k + 1 < cum.length && cum[k + 1] <= target) k++;
      // Nearest pose to the target distance.
      const pick = k + 1 < cum.length && cum[k + 1] - target < target - cum[k] ? k + 1 : k;
      out.push(i0 + pick);
    }
    return out;
  }

  /** Rebuild the geometry after a data or style change. */
  rebuild() {
    this.pathMat.color.set(this.pathColor);
    this.frustumMat.color.set(this.frustumColor);
    this.dotMat.color.set(this.frustumColor);
    this.pathMat.linewidth = this.frustumMat.linewidth = Math.max(0.1, this.lineWidth);
    const pathStyle = this.styleMaterial(this.pathMat, this.pathOpacity);
    this.styleMaterial(this.dotMat, this.frustumOpacity);
    const frustumStyle = this.styleMaterial(this.frustumMat, this.frustumOpacity);
    this.path.renderOrder = pathStyle;
    this.frustums.renderOrder = frustumStyle;

    const { p, q } = this.poses;
    const [i0, i1] = this.trimmed();
    const path: number[] = [];
    for (let i = i0; i < i1; i++) path.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5]);

    // Frustum in camera coordinates: +Z forward, −Y up.
    const d = this.frustumSize;
    const hw = Math.tan(FRUSTUM_HFOV / 2) * d, hh = hw / FRUSTUM_ASPECT;
    const corners = [[-hw, -hh, d], [hw, -hh, d], [hw, hh, d], [-hw, hh, d]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    // Small triangle above the top edge (−Y) marks "up", like the camera gizmo.
    const up = [[-hw * 0.3, -hh * 1.1, d], [hw * 0.3, -hh * 1.1, d], [0, -hh * 1.1 - hw * 0.3, d]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const edges: [THREE.Vector3, THREE.Vector3][] = [];
    const o = new THREE.Vector3();
    for (let c = 0; c < 4; c++) edges.push([o, corners[c]], [corners[c], corners[(c + 1) % 4]]);
    for (let c = 0; c < 3; c++) edges.push([up[c], up[(c + 1) % 3]]);

    const cams = this.cameraIndices(i0, i1);
    const frustums: number[] = [];
    const m = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    this.dots.dispose();
    this.dots.count = 0;
    const dots = new THREE.InstancedMesh(this.dots.geometry, this.dotMat, Math.max(1, cams.length));
    dots.frustumCulled = false;
    dots.renderOrder = frustumStyle;
    dots.count = this.dotRadius > 0 ? cams.length : 0;
    for (const [k, i] of cams.entries()) {
      pos.fromArray(p, i * 3);
      quat.fromArray(q, i * 4);
      m.compose(pos, quat, one);
      for (const [u, v] of edges) frustums.push(...a.copy(u).applyMatrix4(m).toArray(), ...b.copy(v).applyMatrix4(m).toArray());
      dots.setMatrixAt(k, new THREE.Matrix4().compose(pos, new THREE.Quaternion(), new THREE.Vector3().setScalar(this.dotRadius)));
    }
    this.content.remove(this.dots);
    this.dots = dots;
    this.content.add(dots);

    this.setSegments(this.path, this.showPath ? path : []);
    this.setSegments(this.frustums, frustums);
    const all = (this.showPath ? path : []).concat(frustums);
    this.proxy.geometry.dispose();
    this.proxy.geometry = new THREE.BufferGeometry();
    this.proxy.geometry.setAttribute("position", new THREE.Float32BufferAttribute(all, 3));
    this.updateAppearance();
  }

  /**
   * Apply opacity and "on top" to a material; returns the render order for its objects.
   * - Opaque: opaque pass, before the splats. It writes depth, so gaussians behind it are
   *   rejected and those in front blend over it: correct occlusion.
   * - Translucent or on top: transparent pass after the splats (order 20). Splats write no
   *   depth, so nothing can hide a translucent line behind the gaussians in front of it
   *   (drawn before them it would vanish under every splat on screen): it is drawn over them.
   *   On top also skips the depth test against other opaque geometry.
   */
  private styleMaterial(mat: THREE.Material, opacity: number) {
    const o = THREE.MathUtils.clamp(opacity, 0, 1);
    const transparent = this.onTop || o < 1;
    if (mat.transparent !== transparent) mat.needsUpdate = true;
    mat.transparent = transparent;
    mat.opacity = o;
    mat.depthTest = !this.onTop;
    mat.depthWrite = o >= 1;
    return transparent ? 20 : 0;
  }

  private setSegments(line: LineSegments2, positions: number[]) {
    line.geometry.dispose();
    const g = new LineSegmentsGeometry();
    if (positions.length) g.setPositions(positions);
    line.geometry = g;
    line.visible = positions.length > 0;
  }

  /** World-space bounding box of the trimmed path (for framing). */
  worldBounds() {
    const box = new THREE.Box3();
    const [i0, i1] = this.trimmed();
    const m = this.posesToWorld();
    const v = new THREE.Vector3();
    for (let i = i0; i <= i1; i++) box.expandByPoint(v.fromArray(this.poses.p, i * 3).applyMatrix4(m));
    return box;
  }

  /** Pose space -> world: the trajectory's own transform, then the parent's (= content.matrixWorld, without waiting a frame). */
  posesToWorld() {
    this.root.updateMatrixWorld();
    const m = this.root.matrixWorld.clone();
    if (this.parent) {
      this.parent.root.updateMatrixWorld();
      m.multiply(this.parent.root.matrixWorld);
    }
    return m;
  }

  // ------------------------------------------------------------- playhead

  /** Seconds from the first pose of pose i. */
  timeOf(i: number) {
    return this.poses.t[i] - this.poses.t[0];
  }

  /** Index of the last pose at or before the playhead. */
  get frame() {
    const t = this.poses.t, target = t[0] + this.time;
    let lo = 0, hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= target + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Jump to pose i (exact, no interpolation) and stop playback. */
  setFrame(i: number) {
    const n = this.count;
    i = THREE.MathUtils.clamp(Math.round(i), 0, n - 1);
    this.playing = false;
    this.time = this.timeOf(i);
    this.applyCamera();
  }

  /** Start playing from the playhead (from the trim start if it is outside the trim or at its end). */
  play() {
    const [i0, i1] = this.trimmed();
    if (i1 <= i0) return;
    const t0 = this.timeOf(i0), t1 = this.timeOf(i1);
    if (this.time < t0 || this.time >= t1 - 1e-6) this.time = t0;
    this.playAnchor = { wall: performance.now(), time: this.time };
    this.playing = true;
  }

  /** Called every frame: follow the wall clock and move the camera; stops at the end of the trim. */
  step() {
    if (!this.playing) return;
    const [, i1] = this.trimmed();
    this.time = this.playAnchor.time + (performance.now() - this.playAnchor.wall) / 1000;
    if (this.time >= this.timeOf(i1)) {
      this.time = this.timeOf(i1);
      this.playing = false;
    }
    this.applyCamera();
  }

  /**
   * Pose at the playhead, in pose space (OpenCV camera: +Z forward, −Y up). Between poses it is a
   * time-parameterized cubic Hermite spline (Catmull-Rom tangents from the neighbouring poses):
   * smooth through sparse keyframes, and indistinguishable from the poses when they are dense.
   * Orientations use the same spline on sign-aligned quaternions, renormalized.
   */
  poseAt(time = this.time) {
    const { t, p, q } = this.poses;
    const n = t.length;
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
    const k = Math.min(this.frameAt(time), n - 1);
    if (k >= n - 1 || t[k + 1] - t[k] < 1e-9) {
      position.fromArray(p, k * 3);
      quaternion.fromArray(q, k * 4);
      return { position, quaternion };
    }
    const h = t[k + 1] - t[k];
    const s = THREE.MathUtils.clamp((t[0] + time - t[k]) / h, 0, 1);
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    const a = Math.max(0, k - 1), d = Math.min(n - 1, k + 2);
    // Tangent (per second) at a pose, from its neighbours lo and hi.
    const tangent = (vals: (j: number) => number[], lo: number, hi: number) => {
      const dt = t[hi] - t[lo] || 1;
      return vals(hi).map((v, c) => (v - vals(lo)[c]) / dt);
    };
    const pos = (j: number) => [p[j * 3], p[j * 3 + 1], p[j * 3 + 2]];
    const qk = [q[k * 4], q[k * 4 + 1], q[k * 4 + 2], q[k * 4 + 3]];
    const quat = (j: number) => {
      const v = [q[j * 4], q[j * 4 + 1], q[j * 4 + 2], q[j * 4 + 3]];
      return v[0] * qk[0] + v[1] * qk[1] + v[2] * qk[2] + v[3] * qk[3] < 0 ? v.map((x) => -x) : v; // same hemisphere
    };
    const hermite = (vals: (j: number) => number[]) => {
      const m0 = tangent(vals, a, k + 1), m1 = tangent(vals, k, d);
      const v0 = vals(k), v1 = vals(k + 1);
      return v0.map((_, c) => h00 * v0[c] + h10 * h * m0[c] + h01 * v1[c] + h11 * h * m1[c]);
    };
    position.fromArray(hermite(pos));
    quaternion.fromArray(hermite(quat)).normalize();
    return { position, quaternion };
  }

  private frameAt(time: number) {
    const saved = this.time;
    this.time = time;
    const f = this.frame;
    this.time = saved;
    return f;
  }

  /** Put the driven camera at the playhead pose (three.js camera: −Z forward, +Y up). */
  applyCamera() {
    if (!this.camera) return;
    const { position, quaternion } = this.poseAt();
    quaternion.multiply(OPENCV_TO_THREE);
    const world = this.posesToWorld().multiply(new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1)));
    // Ignore the parent's scale: the camera keeps unit scale.
    world.decompose(this.camera.root.position, this.camera.root.quaternion, new THREE.Vector3());
  }

  override dispose() {
    lineMaterials.delete(this.pathMat);
    lineMaterials.delete(this.frustumMat);
    this.dots.dispose();
    super.dispose();
  }
}
