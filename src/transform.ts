import * as THREE from "three";
import { Editor } from "./editor";
import { AXIS_COLORS, SceneElement } from "./elements";
import type { View, Viewport } from "./viewport";
import { toast } from "./ui/toast";

export type TransformMode = "G" | "R" | "S";
type Constraint = { axis: number; space: "global" | "local" } | null;

const MODE_NAMES: Record<TransformMode, string> = { G: "Move", R: "Rotate", S: "Scale" };
const AXIS_NAMES = ["X", "Y", "Z"];

/**
 * Blender-style modal transform: G/R/S to start, X/Y/Z to constrain (press again
 * for local axes, a third time to clear), type numbers for exact values,
 * Ctrl to snap, Shift for precision, LMB/Enter to confirm, RMB/Esc to cancel.
 */
export class TransformTool {
  active = false;
  private mode: TransformMode = "G";
  private el: SceneElement | null = null;
  private startPos = new THREE.Vector3();
  private startQuat = new THREE.Quaternion();
  private startScale = new THREE.Vector3();
  private startMouse = new THREE.Vector2();
  private mouse = new THREE.Vector2();
  private constraint: Constraint = null;
  private numeric = "";
  private snap = false;
  private precision = false;
  /** Accumulated rotation angle (rad), tracked incrementally so it can exceed ±180°. */
  private angle = 0;
  private lastMouseAngle = 0;

  /** The view the transform was started in (its camera and pixel coordinates are used). */
  view!: View;

  constructor(private vp: Viewport, private editor: Editor, private hud: HTMLElement) {}

  /** Mouse coordinates are view pixels. Switching mode mid-transform keeps the original view. */
  begin(mode: TransformMode, mouse: THREE.Vector2, view: View = this.view) {
    const el = this.editor.selected;
    if (!el) return;
    if (mode === "R" && !el.canRotate) return toast(`${el.kind === "cutplane" ? "Cut-planes" : "This element"} can't be rotated`);
    if (mode === "S" && !el.canScale) return toast("Cameras can't be scaled");
    view.unlock();
    if (!this.active) {
      this.view = view;
      this.el = el;
      this.startPos.copy(el.root.position);
      this.startQuat.copy(el.root.quaternion);
      this.startScale.copy(el.getScale());
      this.constraint = null;
    } else {
      this.restore();
    }
    this.active = true;
    this.mode = mode;
    this.numeric = "";
    this.startMouse.copy(mouse);
    this.mouse.copy(mouse);
    this.angle = 0;
    this.lastMouseAngle = this.mouseAngle(mouse);
    this.view.controls.enabled = false;
    this.apply();
  }

  onPointerMove(mouse: THREE.Vector2, e: { shiftKey: boolean; ctrlKey: boolean }) {
    if (!this.active) return;
    if (this.mode === "R") {
      const a = this.mouseAngle(mouse);
      let d = a - this.lastMouseAngle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.angle += d * (e.shiftKey ? 0.1 : 1);
      this.lastMouseAngle = a;
    }
    this.mouse.copy(mouse);
    this.snap = e.ctrlKey;
    this.precision = e.shiftKey;
    this.apply();
  }

  /** Returns true if the key was consumed. */
  onKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    const k = e.key;
    const lower = k.toLowerCase();
    if (k === "Escape") this.cancel();
    else if (k === "Enter" || k === " ") this.confirm();
    else if (lower === "x" || lower === "y" || lower === "z") this.cycleConstraint("xyz".indexOf(lower));
    else if (lower === "g" || lower === "r" || lower === "s") this.begin(lower.toUpperCase() as TransformMode, this.mouse);
    else if (/^[0-9.]$/.test(k)) this.numeric += k;
    else if (k === "-") this.numeric = this.numeric.startsWith("-") ? this.numeric.slice(1) : "-" + this.numeric;
    else if (k === "Backspace") this.numeric = this.numeric.slice(0, -1);
    else if (k === "Control" || k === "Shift") {
      this.snap = e.ctrlKey;
      this.precision = e.shiftKey;
    } else return true; // swallow everything else while transforming
    if (this.active) this.apply();
    return true;
  }

  onKeyUp(e: KeyboardEvent) {
    if (!this.active) return;
    if (e.key === "Control" || e.key === "Shift") {
      this.snap = e.ctrlKey;
      this.precision = e.shiftKey;
      this.apply();
    }
  }

  confirm() {
    this.finish();
  }

  cancel() {
    this.restore();
    this.finish();
  }

  private finish() {
    this.active = false;
    this.el = null;
    this.view.controls.enabled = true;
    this.vp.constraintLine.visible = false;
    this.hud.classList.add("hidden");
    this.editor.emit("props");
  }

  private restore() {
    if (!this.el) return;
    this.el.root.position.copy(this.startPos);
    this.el.root.quaternion.copy(this.startQuat);
    this.el.setScale(this.startScale);
  }

  private cycleConstraint(axis: number) {
    const c = this.constraint;
    const hasLocal = this.el?.kind !== "cutplane";
    if (!c || c.axis !== axis) this.constraint = { axis, space: "global" };
    else if (c.space === "global" && hasLocal) this.constraint = { axis, space: "local" };
    else this.constraint = null;
  }

  private mouseAngle(mouse: THREE.Vector2) {
    const c = this.view.worldToPixel(this.startPos);
    return Math.atan2(-(mouse.y - c.y), mouse.x - c.x);
  }

  private axisVector() {
    if (!this.constraint) return null;
    const v = new THREE.Vector3().setComponent(this.constraint.axis, 1);
    if (this.constraint.space === "local") v.applyQuaternion(this.startQuat);
    return v;
  }

  private numericValue(): number | null {
    if (this.numeric === "" || this.numeric === "-") return null;
    const v = parseFloat(this.numeric);
    return Number.isFinite(v) ? v : null;
  }

  private apply() {
    const el = this.el;
    if (!el) return;
    const cam = this.view.activeCam;
    cam.updateMatrixWorld();
    const p0 = this.startPos;
    const md = this.mouse.clone().sub(this.startMouse);
    if (this.precision && this.mode !== "R") md.multiplyScalar(0.1);
    const axis = this.axisVector();
    const num = this.numericValue();
    let info = "";

    // Constraint line visualisation
    const line = this.vp.constraintLine;
    line.visible = !!axis; // overlay layer: shown only in views with overlays on
    if (axis) {
      const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
      const a = p0.clone().addScaledVector(axis, -1000), b = p0.clone().addScaledVector(axis, 1000);
      pos.setXYZ(0, a.x, a.y, a.z);
      pos.setXYZ(1, b.x, b.y, b.z);
      pos.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      (line.material as THREE.LineBasicMaterial).color.copy(AXIS_COLORS[this.constraint!.axis]);
    }
    const constraintText = this.constraint
      ? ` along ${this.constraint.space} ${AXIS_NAMES[this.constraint.axis]}`
      : "";

    if (this.mode === "G") {
      const delta = new THREE.Vector3();
      if (axis) {
        let amount: number;
        if (num !== null) amount = num;
        else {
          // Project the mouse delta onto the axis' on-screen direction.
          const unit = this.view.worldPerPixel(p0) * 100;
          const s0 = this.view.worldToPixel(p0);
          const s1 = this.view.worldToPixel(p0.clone().addScaledVector(axis, unit));
          const sd = s1.sub(s0);
          const pxPerWorld = sd.length() / unit;
          amount = pxPerWorld > 1e-3 ? md.dot(sd.normalize()) / pxPerWorld : 0;
          if (this.snap) amount = Math.round(amount / 0.1) * 0.1;
        }
        delta.copy(axis).multiplyScalar(amount);
        info = `${amount.toFixed(3)} m`;
      } else {
        const wpp = this.view.worldPerPixel(p0);
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
        delta.addScaledVector(right, md.x * wpp).addScaledVector(up, -md.y * wpp);
        if (this.snap) delta.set(snapTo(delta.x, 0.1), snapTo(delta.y, 0.1), snapTo(delta.z, 0.1));
        info = `D: ${delta.x.toFixed(3)}  ${delta.y.toFixed(3)}  ${delta.z.toFixed(3)}`;
      }
      el.root.position.copy(p0).add(delta);
    } else if (this.mode === "R") {
      let angle = num !== null ? THREE.MathUtils.degToRad(num) : this.angle;
      if (num === null && this.snap) angle = THREE.MathUtils.degToRad(snapTo(THREE.MathUtils.radToDeg(angle), 5));
      const toViewer = this.view.isOrtho || cam.projectionMatrix.elements[11] !== -1
        ? new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).normalize()
        : cam.position.clone().sub(p0).normalize();
      let rotAxis = toViewer;
      let sign = 1;
      if (axis) {
        rotAxis = axis;
        // Typed values follow the right-hand rule; mouse motion follows the screen.
        sign = num !== null ? 1 : Math.sign(axis.dot(toViewer)) || 1;
      }
      const q = new THREE.Quaternion().setFromAxisAngle(rotAxis, angle * sign);
      el.root.quaternion.copy(q.multiply(this.startQuat));
      info = `${THREE.MathUtils.radToDeg(angle).toFixed(2)}°`;
    } else {
      const c = this.view.worldToPixel(p0);
      const d0 = Math.max(4, this.startMouse.distanceTo(c));
      let factor = num ?? this.mouse.distanceTo(c) / d0;
      if (num === null && this.precision) factor = 1 + (factor - 1) * 0.1;
      if (num === null && this.snap) factor = snapTo(factor, 0.1);
      const s = this.startScale.clone();
      if (this.constraint) s.setComponent(this.constraint.axis, s.getComponent(this.constraint.axis) * factor);
      else s.multiplyScalar(factor);
      el.setScale(s);
      info = `×${factor.toFixed(3)}`;
      if (this.constraint?.space === "global" && el.kind !== "cutplane") info += " (scale is always applied on local axes)";
    }

    const numText = this.numeric ? `  [${this.numeric}]` : "";
    this.hud.textContent =
      `${MODE_NAMES[this.mode]}${constraintText}: ${info}${numText}\n` +
      `X/Y/Z constrain · Ctrl snap · Shift precise · LMB/Enter confirm · RMB/Esc cancel`;
    this.hud.classList.remove("hidden");
  }
}

function snapTo(v: number, step: number) {
  return Math.round(v / step) * step;
}
