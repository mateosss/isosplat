import { Editor } from "../editor";
import { CutPlaneElement, type ElementKind, SceneElement, SplatElement } from "../elements";

const GROUPS: { kind: ElementKind; title: string; badge: string }[] = [
  { kind: "camera", title: "Cameras", badge: "CAM" },
  { kind: "splat", title: "3DGS scenes", badge: "3DGS" },
  { kind: "cutplane", title: "Cut-planes", badge: "CUT" },
];

export class HierarchyPanel {
  private pending = false;

  constructor(private list: HTMLElement, private editor: Editor) {
    editor.on("elements", () => this.schedule());
    editor.on("selection", () => this.schedule());
    editor.on("props", () => this.schedule());
    this.render();
  }

  private schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  render() {
    this.list.replaceChildren();
    for (const g of GROUPS) {
      const items = this.editor.elements.filter((e) => e.kind === g.kind);
      const header = document.createElement("div");
      header.className = "h-group";
      header.textContent = `${g.title} (${items.length})`;
      this.list.append(header);
      for (const el of items) this.list.append(this.item(el, g.badge));
    }
  }

  private item(el: SceneElement, badgeText: string) {
    const row = document.createElement("div");
    row.className = "h-item";
    row.classList.toggle("selected", el === this.editor.selected);
    const badge = document.createElement("span");
    badge.className = `badge ${el.kind}`;
    badge.textContent = badgeText;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = el.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    if (el instanceof SplatElement) {
      meta.textContent = el.loaded
        ? `${formatCount(el.numSplats)}${el.renderMode === "points" ? " · pts" : ""}`
        : `loading ${Math.round(el.loadProgress * 100)}%`;
      row.classList.toggle("disabled", !el.visible);
    } else if (el instanceof CutPlaneElement) {
      meta.textContent = el.direction;
      row.classList.toggle("disabled", !el.enabled);
    }
    row.append(badge, name, meta);
    row.addEventListener("click", () => this.editor.select(el));
    return row;
  }
}

function formatCount(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}
