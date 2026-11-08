import * as THREE from "three";
import { Viewport } from "./viewport";

/**
 * Shooter-style navigation: mouse look (pointer lock), WASD to move, Q/E down/up,
 * Shift to go faster, wheel to change the base speed. Esc leaves the mode.
 */
export class FlyMode {
  active = false;
  speed = 2; // m/s
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private orbitDistance = 5;
  onChange: () => void = () => {};

  constructor(private vp: Viewport, private hud: HTMLElement) {
    document.addEventListener("pointerlockchange", () => {
      if (this.active && document.pointerLockElement !== vp.canvas) this.exit();
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.active || document.pointerLockElement !== vp.canvas) return;
      const k = 0.0025;
      this.yaw -= e.movementX * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * k, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    });
    vp.canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 0.05, 500);
        this.updateHud();
      },
      { capture: true, passive: false },
    );
  }

  enter() {
    if (this.active) return;
    this.vp.unlock();
    this.active = true;
    this.vp.controls.enabled = false;
    const cam = this.vp.activeCam;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.yaw = Math.atan2(fwd.y, fwd.x);
    this.pitch = Math.asin(THREE.MathUtils.clamp(fwd.z, -1, 1));
    this.orbitDistance = Math.max(1, cam.position.distanceTo(this.vp.controls.target));
    this.keys.clear();
    const req = this.vp.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    req?.catch?.(() => {
      /* pointer lock refused: keyboard still works, Esc exits */
    });
    this.updateHud();
    this.onChange();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    if (document.pointerLockElement === this.vp.canvas) document.exitPointerLock();
    const cam = this.vp.activeCam;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    this.vp.controls.target.copy(cam.position).addScaledVector(fwd, this.orbitDistance);
    this.vp.controls.enabled = true;
    this.vp.controls.update();
    this.hud.classList.add("hidden");
    this.onChange();
  }

  onKey(e: KeyboardEvent, down: boolean): boolean {
    if (!this.active) return false;
    if (down && e.key === "Escape") {
      this.exit();
      return true;
    }
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.keys[down ? "add" : "delete"]("Shift");
    else this.keys[down ? "add" : "delete"](e.code);
    return true;
  }

  update(dt: number) {
    if (!this.active) return;
    const cam = this.vp.activeCam;
    const fwd = new THREE.Vector3(
      Math.cos(this.pitch) * Math.cos(this.yaw),
      Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
    );
    const right = new THREE.Vector3(Math.sin(this.yaw), -Math.cos(this.yaw), 0);
    const move = new THREE.Vector3();
    if (this.keys.has("KeyW")) move.add(fwd);
    if (this.keys.has("KeyS")) move.sub(fwd);
    if (this.keys.has("KeyD")) move.add(right);
    if (this.keys.has("KeyA")) move.sub(right);
    if (this.keys.has("KeyE") || this.keys.has("Space")) move.z += 1;
    if (this.keys.has("KeyQ") || this.keys.has("ControlLeft")) move.z -= 1;
    if (move.lengthSq() > 0) {
      const v = this.speed * (this.keys.has("Shift") ? 4 : 1);
      cam.position.addScaledVector(move.normalize(), v * dt);
    }
    cam.lookAt(cam.position.clone().add(fwd));
  }

  private updateHud() {
    this.hud.textContent =
      `WASD fly · speed ${this.speed.toFixed(2)} m/s (wheel to change, Shift ×4)\n` +
      `Q/E down/up · Esc to exit`;
    this.hud.classList.remove("hidden");
  }
}
