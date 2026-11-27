import * as THREE from "three";
import type { Editor } from "./editor";
import { CutPlaneElement } from "./elements";
import type { View } from "./viewport";

/** How close (px) the pointer must be to a cut-plane arrow to grab it. */
const GRAB_PIXELS = 8;

/**
 * Drag a cut-plane by its normal arrow: the plane slides along its normal, following the
 * point of the normal line closest to the mouse ray. Arrows are overlays, so this only
 * works in views with overlays on.
 */
export class CutPlaneDrag {
  private drag: { view: View; plane: CutPlaneElement; start: THREE.Vector3; s0: number } | null = null;

  constructor(private editor: Editor) {}

  get active() {
    return this.drag !== null;
  }

  /** The cut-plane whose arrow is under the pointer in `view`, if any. */
  hit(view: View, clientX: number, clientY: number): CutPlaneElement | null {
    if (!view.overlays) return null;
    const mouse = view.toLocal(clientX, clientY);
    let best: CutPlaneElement | null = null;
    let bestDist = GRAB_PIXELS;
    for (const plane of this.editor.cutPlanes()) {
      const [a, b] = plane.arrowSegment().map((p) => view.worldToPixel(p));
      const d = distToSegment(mouse, a, b);
      if (d < bestDist) {
        bestDist = d;
        best = plane;
      }
    }
    return best;
  }

  begin(view: View, plane: CutPlaneElement, clientX: number, clientY: number) {
    const s0 = this.axisParam(view, plane.root.position, plane.dirVector(), clientX, clientY);
    if (s0 === null) return false; // looking straight along the normal: nothing to drag along
    this.drag = { view, plane, start: plane.root.position.clone(), s0 };
    return true;
  }

  move(clientX: number, clientY: number) {
    const d = this.drag;
    if (!d) return;
    const n = d.plane.dirVector();
    const s = this.axisParam(d.view, d.start, n, clientX, clientY);
    if (s === null) return;
    d.plane.root.position.copy(d.start).addScaledVector(n, s - d.s0);
  }

  end() {
    this.drag = null;
  }

  cancel() {
    if (this.drag) this.drag.plane.root.position.copy(this.drag.start);
    this.drag = null;
  }

  /** Parameter s of the point origin + s·axis closest to the mouse ray (null if they are parallel). */
  private axisParam(view: View, origin: THREE.Vector3, axis: THREE.Vector3, clientX: number, clientY: number) {
    const p = view.toLocal(clientX, clientY);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(view.toNdc(p.x, p.y), view.activeCam);
    const d = ray.ray.direction, w0 = origin.clone().sub(ray.ray.origin);
    const b = axis.dot(d);
    const denom = 1 - b * b; // axis and d are unit vectors
    if (denom < 1e-4) return null;
    return (b * d.dot(w0) - axis.dot(w0)) / denom;
  }
}

function distToSegment(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) {
  const ab = b.clone().sub(a);
  const len2 = ab.lengthSq();
  const t = len2 > 0 ? THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / len2, 0, 1) : 0;
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}
