import * as THREE from "three";
import { Editor } from "../editor";
import { AXIS_LETTERS, CameraElement, CutBoxElement, CUT_DIRECTIONS, CutPlaneElement, SceneElement, SplatElement } from "../elements";
import type { View, Viewport } from "../viewport";

type Binding = { sync: () => void };

/** Properties of the selected element. Values are re-synced every frame (except the focused field). */
export class PropertiesPanel {
  private bindings: Binding[] = [];

  /** Called by "Render PNG" buttons; set by main. */
  onRender: (cam: CameraElement | null) => void = () => {};
  /** Called by "Preview in minimap"; set by main. */
  onPreview: (cam: CameraElement) => void = () => {};

  /** `view` is the main view (camera buttons and framing act on it). */
  constructor(private body: HTMLElement, private editor: Editor, private vp: Viewport, private view: View) {
    editor.on("selection", () => this.render());
    editor.on("elements", () => {
      if (editor.selected && !editor.elements.includes(editor.selected)) this.render();
    });
    this.render();
  }

  sync() {
    for (const b of this.bindings) b.sync();
  }

  render() {
    this.bindings = [];
    this.body.replaceChildren();
    const el = this.editor.selected;
    if (this.editor.worldSelected) return this.worldSection();
    if (!el) {
      const p = document.createElement("div");
      p.className = "p-empty";
      p.textContent = "Nothing selected. Click an element in the hierarchy or the viewport.";
      this.body.append(p);
      return;
    }

    const general = this.section("Object");
    general.append(
      this.row("Name", this.text(() => el.name, (v) => {
        el.name = v || el.name;
        this.editor.emit("elements");
      })),
    );

    this.transformSection(el);
    if (el instanceof CameraElement) this.cameraSection(el);
    if (el instanceof SplatElement) this.splatSection(el);
    if (el instanceof CutPlaneElement) this.cutSection(el);
    if (el instanceof CutBoxElement) this.cutBoxSection(el);
  }

  // ----------------------------------------------------------- sections

  private transformSection(el: SceneElement) {
    const s = this.section("Transform");
    const p = el.root.position;
    s.append(this.row("Position", ...(["x", "y", "z"] as const).map((k) =>
      this.number(() => p[k], (v) => (p[k] = v), { tag: k, step: 0.1 }))));
    if (el.kind === "cutplane") {
      s.append(this.note("Cut-planes can be moved and resized (S), not rotated; use the cut direction below to orient them."));
      return;
    }
    const q = el.root.quaternion;
    // While scrubbing, edit from a snapshot so re-normalisation doesn't drift the other components.
    let base: THREE.Quaternion | null = null;
    s.append(this.row("Rotation (quat)", ...(["x", "y", "z", "w"] as const).map((k) =>
      this.number(() => q[k], (v) => {
        if (base) q.copy(base);
        q[k] = v;
        if (q.lengthSq() < 1e-12) q.identity();
        q.normalize();
      }, { tag: k, step: 0.05, onDragStart: () => (base = q.clone()) }))));
    // Typing (not scrubbing) should use the current value.
    s.addEventListener("focusin", () => (base = null));
    if (el.canScale) {
      s.append(this.row("Scale", ...(["x", "y", "z"] as const).map((k) =>
        this.number(() => el.getScale()[k], (v) => el.setScale(el.getScale().setComponent("xyz".indexOf(k), v)), { tag: k, step: 0.1 }))));
    }
    const buttons = document.createElement("div");
    buttons.className = "p-buttons";
    buttons.append(this.button("Reset rotation", () => q.identity()));
    s.append(buttons);
  }

  private cameraSection(cam: CameraElement) {
    const s = this.section("Camera");
    const changed = () => cam.rebuildGizmo();
    s.append(this.row("Type", this.segmented(
      [["pinhole", "Pinhole"], ["orthographic", "Orthographic"]],
      () => cam.type,
      (v) => {
        cam.type = v as CameraElement["type"];
        changed();
        this.render();
      },
    )));
    s.append(this.row("Resolution",
      this.number(() => cam.width, (v) => { cam.width = Math.max(1, Math.round(v)); changed(); }, { tag: "w", step: 1 }),
      this.number(() => cam.height, (v) => { cam.height = Math.max(1, Math.round(v)); changed(); }, { tag: "h", step: 1 }),
    ));
    if (cam.type === "pinhole") {
      s.append(this.row("Focal (px)",
        this.number(() => cam.fx, (v) => { cam.fx = Math.max(1, v); changed(); }, { tag: "fx", step: 10 }),
        this.number(() => cam.fy, (v) => { cam.fy = Math.max(1, v); changed(); }, { tag: "fy", step: 10 }),
      ));
      s.append(this.row("Principal (px)",
        this.number(() => cam.cx, (v) => { cam.cx = v; changed(); }, { tag: "cx", step: 1 }),
        this.number(() => cam.cy, (v) => { cam.cy = v; changed(); }, { tag: "cy", step: 1 }),
      ));
      const fov = document.createElement("span");
      fov.className = "value";
      this.bindings.push({
        sync: () => {
          const h = THREE.MathUtils.radToDeg(2 * Math.atan(cam.width / (2 * cam.fx)));
          const v = THREE.MathUtils.radToDeg(2 * Math.atan(cam.height / (2 * cam.fy)));
          const t = `${h.toFixed(1)}° × ${v.toFixed(1)}°`;
          if (fov.textContent !== t) fov.textContent = t;
        },
      });
      s.append(this.row("FOV (h × v)", fov));
    } else {
      s.append(this.row("Ortho scale",
        this.number(() => cam.orthoScale, (v) => { cam.orthoScale = Math.max(0.001, v); changed(); }, { step: 0.5 })));
      s.append(this.note("World size covered by the larger image side (like Blender)."));
    }
    s.append(this.row("Clip near/far",
      this.number(() => cam.near, (v) => (cam.near = Math.max(1e-4, v)), { step: 0.01 }),
      this.number(() => cam.far, (v) => (cam.far = Math.max(cam.near + 1e-3, v)), { step: 10 }),
    ));
    const buttons = document.createElement("div");
    buttons.className = "p-buttons";
    buttons.append(
      this.button("👁 Look from camera", () => this.view.lookFrom(cam)),
      this.button("▣ Preview in minimap", () => this.onPreview(cam)),
      this.button("Set from current view", () => {
        this.view.copyViewToCamera(cam);
        this.render();
      }),
      this.button("📷 Render PNG", () => this.onRender(cam)),
    );
    s.append(buttons);
    s.append(this.note("Camera looks along its local −Z axis with +Y up (three.js convention)."));
  }

  private worldSection() {
    const s = this.section("World");
    const w = this.editor.world;
    const apply = (c: string) => {
      w.background = c;
      this.vp.setBackground(c);
      this.editor.emit("props");
    };
    const color = document.createElement("input");
    color.type = "color";
    color.value = w.background;
    color.addEventListener("input", () => apply(color.value));
    this.bindings.push({ sync: () => void (color.value !== w.background && (color.value = w.background)) });
    const swatches = document.createElement("div");
    swatches.className = "swatches";
    for (const c of ["#3a3a3a", "#1d1d1d", "#000000", "#ffffff", "#e8e4dc", "#c9d6e3", "#2b3a4a"]) {
      const b = document.createElement("button");
      b.style.background = c;
      b.title = c;
      b.addEventListener("click", () => apply(c));
      swatches.append(b);
    }
    s.append(this.row("Background", color, swatches));
    s.append(this.row("Transparent PNG", this.checkbox(() => w.transparentRender, (v) => (w.transparentRender = v))));
    s.append(this.note("When enabled, rendered PNGs get a transparent background instead of the world color."));
    const buttons = document.createElement("div");
    buttons.className = "p-buttons";
    buttons.append(this.button("📷 Render PNG of view", () => this.onRender(null)));
    s.append(buttons);

    const d = this.section("Depth view");
    d.append(this.row("Depth view", this.checkbox(() => w.depthView, (v) => {
      w.depthView = v;
      this.editor.emit("props");
    })));
    d.append(this.row("Auto range", this.checkbox(() => w.depthAuto, (v) => (w.depthAuto = v))));
    // Editing the range switches to manual.
    d.append(this.row("Range (m)",
      this.number(() => w.depthMin, (v) => { w.depthAuto = false; w.depthMin = Math.max(0, v); }, { tag: "min", step: 0.1 }),
      this.number(() => w.depthMax, (v) => { w.depthAuto = false; w.depthMax = Math.max(w.depthMin + 0.01, v); }, { tag: "max", step: 0.1 }),
    ));
    d.append(this.note(
      "Colors gaussians and point clouds by their distance along the camera's view axis (jet colormap: blue = near, red = far). " +
      "Auto fits the range to the visible scene, clipped by the cut-planes. Toggle with Z or the ◐ Depth button.",
    ));
  }

  private splatSection(sp: SplatElement) {
    const s = this.section("3DGS scene");
    if (!sp.loaded) {
      s.append(this.note("Loading…"));
      sp.ready.then(() => this.editor.selected === sp && this.render()).catch(() => {});
      return;
    }
    s.append(this.row("Render", this.segmented(
      [["splat", "Gaussians"], ["points", "Point cloud"]],
      () => sp.renderMode,
      (v) => {
        sp.setRenderMode(v as SplatElement["renderMode"]);
        this.editor.emit("props");
        this.render();
      },
    )));
    if (sp.renderMode === "points") {
      s.append(this.row("Point size (px)",
        this.number(() => sp.pointSize, (v) => sp.setPointSize(Math.max(0.5, v)), { step: 0.5 })));
    }
    s.append(this.row("Visible", this.checkbox(() => sp.visible, (v) => {
      sp.setVisible(v);
      this.editor.emit("props");
    })));
    const info = document.createElement("span");
    info.className = "value";
    info.textContent = `${sp.numSplats.toLocaleString()} gaussians`;
    s.append(this.row("Info", info));
    const buttons = document.createElement("div");
    buttons.className = "p-buttons";
    buttons.append(this.button("Frame in view", () => this.view.frame(sp)));
    s.append(buttons);
  }

  private cutSection(cut: CutPlaneElement) {
    const s = this.section("Cut-plane");
    s.append(this.row("Cut direction", this.segmented(
      CUT_DIRECTIONS.map((d) => [d, d] as [string, string]),
      () => cut.direction,
      (v) => {
        cut.setDirection(v as CutPlaneElement["direction"]);
        this.editor.emit("props");
        this.render(); // the size fields depend on the in-plane axes
      },
    )));
    s.append(this.row("Enabled", this.checkbox(() => cut.enabled, (v) => {
      cut.setEnabled(v);
      this.editor.emit("props");
    })));
    s.append(this.row("Bounded", this.checkbox(() => cut.bounded, (v) => {
      cut.bounded = v;
      this.editor.emit("props");
      this.render();
    })));
    const { iu, iv } = cut.basis();
    s.append(this.row("Size (m)", ...[iu, iv].map((a) =>
      this.number(() => cut.extent.getComponent(a), (v) => cut.setExtent(a, v), { tag: AXIS_LETTERS[a], step: 0.5 }))));
    const axis = cut.direction[1].toLowerCase();
    const op = cut.direction[0] === "+" ? "<" : ">";
    const [u, v] = [AXIS_LETTERS[iu], AXIS_LETTERS[iv]];
    s.append(this.note(
      cut.bounded
        ? `Hides gaussians with ${axis} ${op} plane ${axis} whose ${u} and ${v} fall inside the rectangle ` +
          `(resize with S, constrain with ${u.toUpperCase()}/${v.toUpperCase()}). The arrow points to the side that is kept.`
        : `Unbounded: hides every gaussian with ${axis} ${op} plane ${axis}, whatever its ${u} and ${v} ` +
          `(the rectangle is only drawn). Useful to remove far-away floaters. The arrow points to the side that is kept.`,
    ));
  }

  private cutBoxSection(box: CutBoxElement) {
    const s = this.section("Cut-box");
    s.append(this.row("Enabled", this.checkbox(() => box.enabled, (v) => {
      box.setEnabled(v);
      this.editor.emit("props");
    })));
    s.append(this.row("Invert", this.checkbox(() => box.invert, (v) => {
      box.setInvert(v);
      this.editor.emit("props");
      this.render();
    })));
    s.append(this.note(
      (box.invert
        ? "Inverted: removes every gaussian inside the box and keeps the rest. "
        : "Keeps only the gaussians inside the box and removes everything outside it. ") +
      "Its scale is its size in meters; move, rotate and scale it with G / R / S.",
    ));
  }

  // ----------------------------------------------------------- widgets

  private section(title: string) {
    const s = document.createElement("div");
    s.className = "p-section";
    const h = document.createElement("h3");
    h.textContent = title;
    s.append(h);
    this.body.append(s);
    return s;
  }

  private row(label: string, ...fields: HTMLElement[]) {
    const r = document.createElement("div");
    r.className = "p-row";
    const l = document.createElement("label");
    l.textContent = label;
    const f = document.createElement("div");
    f.className = "fields";
    f.append(...fields);
    r.append(l, f);
    return r;
  }

  private note(text: string) {
    const p = document.createElement("div");
    p.className = "p-note";
    p.textContent = text;
    return p;
  }

  /**
   * Numeric field. Click to type; press and drag horizontally to scrub the value
   * (Shift = fine, Ctrl = snap to step). Esc while dragging restores the value.
   */
  private number(
    get: () => number,
    set: (v: number) => void,
    opts: { tag?: string; step?: number; onDragStart?: () => void } = {},
  ) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const input = document.createElement("input");
    input.type = "number";
    const step = opts.step ?? 0.1;
    input.step = String(step);
    if (opts.tag) {
      wrap.classList.add("has-tag");
      if (opts.tag.length > 1) wrap.classList.add(opts.tag.length > 2 ? "wider-tag" : "wide-tag");
      const tag = document.createElement("span");
      tag.textContent = opts.tag.toUpperCase();
      tag.className = `ax-${opts.tag}`;
      wrap.append(tag);
    }
    wrap.append(input);
    const fmt = (v: number) => String(Number(v.toFixed(4)));
    input.value = fmt(get());
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) set(v);
      input.value = fmt(get());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      e.stopPropagation();
    });

    // ---- drag to scrub
    let drag: { startX: number; startValue: number; dx: number; dragging: boolean; id: number } | null = null;
    const endDrag = (restore: boolean) => {
      if (!drag) return;
      if (input.hasPointerCapture(drag.id)) input.releasePointerCapture(drag.id);
      if (restore && drag.dragging) set(drag.startValue);
      const wasDrag = drag.dragging;
      drag = null;
      wrap.classList.remove("scrubbing");
      document.removeEventListener("keydown", onEsc, true);
      input.value = fmt(get());
      if (!wasDrag && !restore) {
        input.focus();
        input.select();
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      endDrag(true);
    };
    input.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || document.activeElement === input) return; // already editing: normal text behaviour
      e.preventDefault(); // don't focus yet; decide on pointerup whether it was a click or a drag
      input.setPointerCapture(e.pointerId);
      drag = { startX: e.clientX, startValue: get(), dx: 0, dragging: false, id: e.pointerId };
      document.addEventListener("keydown", onEsc, true);
    });
    input.addEventListener("pointermove", (e) => {
      if (!drag) return;
      drag.dx += e.movementX * (e.shiftKey ? 0.1 : 1);
      if (!drag.dragging && Math.abs(e.clientX - drag.startX) > 3) {
        drag.dragging = true;
        drag.dx = e.clientX - drag.startX;
        wrap.classList.add("scrubbing");
        opts.onDragStart?.();
      }
      if (!drag.dragging) return;
      // 10 px per step: position (0.1) -> 1 cm/px, focal (10) -> 1 px/px
      let v = drag.startValue + (drag.dx * step) / 10;
      if (e.ctrlKey) v = Math.round(v / step) * step;
      set(v);
      input.value = fmt(get());
    });
    input.addEventListener("pointerup", () => endDrag(false));
    input.addEventListener("pointercancel", () => endDrag(true));

    this.bindings.push({
      sync: () => {
        if (document.activeElement === input || drag?.dragging) return;
        const t = fmt(get());
        if (input.value !== t) input.value = t;
      },
    });
    return wrap;
  }

  private text(get: () => string, set: (v: string) => void) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = get();
    input.addEventListener("change", () => set(input.value.trim()));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      e.stopPropagation();
    });
    this.bindings.push({
      sync: () => {
        if (document.activeElement !== input && input.value !== get()) input.value = get();
      },
    });
    return input;
  }

  private checkbox(get: () => boolean, set: (v: boolean) => void) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = get();
    input.addEventListener("change", () => set(input.checked));
    this.bindings.push({ sync: () => void (input.checked = get()) });
    return input;
  }

  private segmented(options: [string, string][], get: () => string, set: (v: string) => void) {
    const seg = document.createElement("div");
    seg.className = "seg";
    const buttons = options.map(([value, label]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => {
        set(value);
        update();
      });
      seg.append(b);
      return { b, value };
    });
    const update = () => buttons.forEach(({ b, value }) => b.classList.toggle("active", get() === value));
    update();
    this.bindings.push({ sync: update });
    return seg;
  }

  private button(label: string, onClick: () => void) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }
}
