import * as THREE from "three";
import { SplatEdit, SplatEditRgbaBlendMode } from "@sparkjsdev/spark";
import { CameraElement, CutPlaneElement, type CutDirection, SceneElement, SplatElement } from "./elements";

type EventName = "elements" | "selection" | "props";
type Listener = () => void;

/** Owns the scene contents, the hierarchy and the selection. */
export class Editor {
  readonly scene = new THREE.Scene();
  readonly elements: SceneElement[] = [];
  selected: SceneElement | null = null;
  overlaysVisible = true;

  /** Clipping planes shared by all point-cloud materials (mutated in place). */
  readonly clipPlanes: THREE.Plane[] = [];
  /** One global Spark edit; its SDFs are the enabled cut-planes. Applies to every SplatMesh. */
  private cutEdit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfs: [] });
  private listeners = new Map<EventName, Set<Listener>>();
  private counters = new Map<string, number>();

  constructor() {
    this.scene.add(this.cutEdit);
  }

  on(event: EventName, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  emit(event: EventName) {
    this.listeners.get(event)?.forEach((fn) => fn());
  }

  uniqueName(base: string) {
    const n = (this.counters.get(base) ?? 0) + 1;
    this.counters.set(base, n);
    return n === 1 ? base : `${base}.${String(n - 1).padStart(3, "0")}`;
  }

  add<T extends SceneElement>(el: T): T {
    this.elements.push(el);
    this.scene.add(el.root);
    el.setOverlaysVisible(this.overlaysVisible);
    this.emit("elements");
    return el;
  }

  remove(el: SceneElement) {
    const i = this.elements.indexOf(el);
    if (i < 0) return;
    this.elements.splice(i, 1);
    if (this.selected === el) this.select(null);
    el.dispose();
    this.emit("elements");
  }

  select(el: SceneElement | null) {
    if (this.selected === el) return;
    this.selected?.setSelected(false);
    this.selected = el;
    el?.setSelected(true);
    this.emit("selection");
  }

  setOverlaysVisible(v: boolean) {
    this.overlaysVisible = v;
    this.elements.forEach((e) => e.setOverlaysVisible(v));
  }

  addCamera() {
    return this.add(new CameraElement(this.uniqueName("Camera")));
  }

  addCutPlane(direction: CutDirection = "+Z", position = new THREE.Vector3()) {
    const el = new CutPlaneElement(this.uniqueName("Cut-plane"), direction);
    el.root.position.copy(position);
    return this.add(el);
  }

  async importSplat(file: File) {
    const bytes = await file.arrayBuffer();
    const name = file.name.replace(/\.[^.]+$/, "");
    const el = new SplatElement(name, bytes, file.name, this.clipPlanes, () => this.emit("elements"));
    this.add(el);
    try {
      await el.ready;
    } catch (err) {
      this.remove(el);
      throw err;
    }
    this.emit("elements");
    if (this.selected === el) this.emit("selection");
    return el;
  }

  /** The 6 default cut-planes enclosing a 10 x 10 x 10 m cube centered at the origin. */
  addDefaultCutPlanes(size = 10) {
    const h = size / 2;
    const defs: [CutDirection, THREE.Vector3][] = [
      ["+X", new THREE.Vector3(-h, 0, 0)],
      ["-X", new THREE.Vector3(h, 0, 0)],
      ["+Y", new THREE.Vector3(0, -h, 0)],
      ["-Y", new THREE.Vector3(0, h, 0)],
      ["+Z", new THREE.Vector3(0, 0, -h)],
      ["-Z", new THREE.Vector3(0, 0, h)],
    ];
    for (const [d, p] of defs) this.addCutPlane(d, p).setSize(size);
  }

  cutPlanes() {
    return this.elements.filter((e): e is CutPlaneElement => e instanceof CutPlaneElement);
  }

  splats() {
    return this.elements.filter((e): e is SplatElement => e instanceof SplatElement);
  }

  cameras() {
    return this.elements.filter((e): e is CameraElement => e instanceof CameraElement);
  }

  /** Called every frame: sync cut-plane poses into the Spark edit and the clipping planes. */
  updateCuts() {
    const enabled = this.cutPlanes().filter((c) => c.enabled);
    enabled.forEach((c) => c.syncCut());
    const sdfs = enabled.map((c) => c.sdf);
    const prev = this.cutEdit.sdfs ?? [];
    if (prev.length !== sdfs.length || prev.some((s, i) => s !== sdfs[i])) this.cutEdit.sdfs = sdfs;
    this.clipPlanes.length = 0;
    enabled.forEach((c) => this.clipPlanes.push(c.clipPlane));
  }

  isCut(worldPoint: THREE.Vector3) {
    return this.cutPlanes().some((c) => c.cuts(worldPoint));
  }
}
