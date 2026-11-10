import * as THREE from "three";

const COLORS = ["#ff3352", "#8bdc00", "#2890ff"];
const LABELS = ["X", "Y", "Z"];

/** Blender-like navigation gizmo in the viewport corner. Click a bubble to align the view. */
export class AxisGizmo {
  private ctx: CanvasRenderingContext2D;
  private bubbles: { x: number; y: number; dir: THREE.Vector3 }[] = [];
  private size = 100;
  private radius = 9;

  constructor(private canvas: HTMLCanvasElement, onPick: (dir: THREE.Vector3) => void) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("pointerdown", (e) => e.stopPropagation());
    canvas.addEventListener("click", (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      // Front-most bubbles are last in the list.
      for (let i = this.bubbles.length - 1; i >= 0; i--) {
        const b = this.bubbles[i];
        if (Math.hypot(b.x - x, b.y - y) <= this.radius + 2) return onPick(b.dir.clone());
      }
    });
  }

  draw(camera: THREE.Camera) {
    // Size follows the element (the minimap uses a smaller gizmo).
    this.size = this.canvas.clientWidth || 100;
    this.radius = this.size < 80 ? 7 : 9;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(this.size * dpr);
    if (this.canvas.width !== px) this.canvas.width = this.canvas.height = px;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);
    const c = this.size / 2;
    const len = c - this.radius - 2;

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.fill();

    const inv = camera.quaternion.clone().invert();
    const items: { v: THREE.Vector3; axis: number; positive: boolean }[] = [];
    for (let axis = 0; axis < 3; axis++) {
      for (const positive of [true, false]) {
        const dir = new THREE.Vector3().setComponent(axis, positive ? 1 : -1);
        items.push({ v: dir.applyQuaternion(inv), axis, positive });
      }
    }
    items.sort((a, b) => a.v.z - b.v.z); // back to front
    this.bubbles = [];
    ctx.font = `bold ${this.size < 80 ? 9 : 11}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const it of items) {
      const x = c + it.v.x * len, y = c - it.v.y * len;
      const color = COLORS[it.axis];
      if (it.positive) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, this.radius, 0, Math.PI * 2);
      if (it.positive) {
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = "#111";
        ctx.fillText(LABELS[it.axis], x, y + 0.5);
      } else {
        ctx.fillStyle = color + "55";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const dir = new THREE.Vector3().setComponent(it.axis, it.positive ? 1 : -1);
      this.bubbles.push({ x, y, dir });
    }
  }
}
