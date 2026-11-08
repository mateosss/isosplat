import * as THREE from "three";
import { Editor } from "./editor";
import { CameraElement, CutPlaneElement, SceneElement, SplatElement } from "./elements";
import type { ViewState } from "./viewport";

/*
 * .isosplat project file — a self-contained binary container:
 *
 *   bytes 0..7    magic "ISOSPLAT"
 *   bytes 8..11   uint32 LE  format version
 *   bytes 12..15  uint32 LE  JSON length (bytes)
 *   then          JSON (UTF-8), see ProjectJson
 *   then          the original splat files, concatenated; each splat entry in the
 *                 JSON has { offset, length } relative to the end of the JSON.
 *
 * Splat files are embedded unchanged (.ply, .spz, …), so they can be extracted
 * again with any tool: `tail -c +$((16 + jsonLength + offset + 1)) | head -c length`.
 */

const MAGIC = "ISOSPLAT";
const VERSION = 1;
export const PROJECT_EXTENSION = ".isosplat";

interface ElementJsonBase {
  name: string;
  position: number[];
  quaternion: number[];
  scale: number[];
}
type CameraJson = ElementJsonBase & {
  kind: "camera";
  type: CameraElement["type"];
  width: number; height: number;
  fx: number; fy: number; cx: number; cy: number;
  orthoScale: number; near: number; far: number;
};
type SplatJson = ElementJsonBase & {
  kind: "splat";
  fileName: string;
  renderMode: SplatElement["renderMode"];
  pointSize: number;
  visible: boolean;
  data: { offset: number; length: number };
};
type CutJson = ElementJsonBase & {
  kind: "cutplane";
  direction: CutPlaneElement["direction"];
  size: number;
  enabled: boolean;
};
type ElementJson = CameraJson | SplatJson | CutJson;

export interface ProjectJson {
  format: "isosplat";
  version: number;
  world: Editor["world"];
  overlays: boolean;
  view: ViewState;
  selected: number | null;
  elements: ElementJson[];
}

/** Build the project file. Splat data is referenced, not copied, so this is cheap even for huge scenes. */
export function buildProject(editor: Editor, view: ViewState): { blob: Blob; json: ProjectJson } {
  const parts: Blob[] = [];
  let offset = 0;
  const base = (e: SceneElement): ElementJsonBase => ({
    name: e.name,
    position: e.root.position.toArray(),
    quaternion: e.root.quaternion.toArray(),
    scale: e.root.scale.toArray(),
  });
  const elements: ElementJson[] = editor.elements.map((e) => {
    if (e instanceof CameraElement) {
      const { type, width, height, fx, fy, cx, cy, orthoScale, near, far } = e;
      return { kind: "camera", ...base(e), type, width, height, fx, fy, cx, cy, orthoScale, near, far };
    }
    if (e instanceof SplatElement) {
      const data = { offset, length: e.source.size };
      parts.push(e.source);
      offset += e.source.size;
      return {
        kind: "splat", ...base(e), fileName: e.fileName,
        renderMode: e.renderMode, pointSize: e.pointSize, visible: e.visible, data,
      };
    }
    const c = e as CutPlaneElement;
    return { kind: "cutplane", ...base(c), direction: c.direction, size: c.size, enabled: c.enabled };
  });
  const json: ProjectJson = {
    format: "isosplat",
    version: VERSION,
    world: { ...editor.world },
    overlays: editor.overlaysVisible,
    view,
    selected: editor.selected ? editor.elements.indexOf(editor.selected) : null,
    elements,
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json, null, 1));
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode(MAGIC), 0);
  const dv = new DataView(header.buffer);
  dv.setUint32(8, VERSION, true);
  dv.setUint32(12, jsonBytes.length, true);
  return { blob: new Blob([header, jsonBytes, ...parts], { type: "application/octet-stream" }), json };
}

/** Parse a project file; splat data is returned as lazy slices of the file. */
export async function readProject(file: Blob) {
  const header = new DataView(await file.slice(0, 16).arrayBuffer());
  const magic = new TextDecoder().decode(new Uint8Array(header.buffer, 0, 8));
  if (magic !== MAGIC) throw new Error("Not an IsoSplat project file");
  const version = header.getUint32(8, true);
  if (version > VERSION) throw new Error(`Project version ${version} is newer than this app supports (${VERSION})`);
  const jsonLength = header.getUint32(12, true);
  const json = JSON.parse(await file.slice(16, 16 + jsonLength).text()) as ProjectJson;
  const dataStart = 16 + jsonLength;
  const slice = (d: { offset: number; length: number }) => file.slice(dataStart + d.offset, dataStart + d.offset + d.length);
  return { json, slice };
}

/**
 * Replace the editor contents with a project. Returns once the scene is set up;
 * splats finish loading in the background (the returned promise `loaded` resolves then).
 */
export async function applyProject(editor: Editor, file: Blob) {
  const { json, slice } = await readProject(file);
  editor.clear();
  Object.assign(editor.world, json.world);

  const applyPose = (e: SceneElement, j: ElementJsonBase) => {
    e.root.position.fromArray(j.position);
    e.root.quaternion.fromArray(j.quaternion);
    e.root.scale.fromArray(j.scale);
    e.name = j.name;
  };

  const created: (SceneElement | null)[] = [];
  const loads: Promise<unknown>[] = [];
  for (const j of json.elements) {
    if (j.kind === "camera") {
      const cam = editor.addCamera();
      applyPose(cam, j);
      Object.assign(cam, {
        type: j.type, width: j.width, height: j.height, fx: j.fx, fy: j.fy, cx: j.cx, cy: j.cy,
        orthoScale: j.orthoScale, near: j.near, far: j.far,
      });
      cam.rebuildGizmo();
      created.push(cam);
    } else if (j.kind === "cutplane") {
      const cut = editor.addCutPlane(j.direction, new THREE.Vector3().fromArray(j.position));
      applyPose(cut, j);
      cut.setSize(j.size);
      cut.setEnabled(j.enabled);
      created.push(cut);
    } else if (j.kind === "splat") {
      // Keep the hierarchy order: reserve the slot, the element is added when its bytes are read.
      const index = created.length;
      created.push(null);
      loads.push(
        editor.importSplatBlob(slice(j.data), j.fileName, (el) => {
          applyPose(el, j);
          el.setVisible(j.visible);
          el.setPointSize(j.pointSize);
          created[index] = el;
        }).then((el) => el.setRenderMode(j.renderMode)),
      );
    }
  }
  editor.emit("elements");
  const loaded = Promise.all(loads).then(() => {
    // Restore hierarchy order (splats were appended when their data became available).
    const order = created.filter((e): e is SceneElement => !!e && editor.elements.includes(e));
    const rest = editor.elements.filter((e) => !order.includes(e));
    editor.elements.splice(0, editor.elements.length, ...order, ...rest);
    if (json.selected !== null && created[json.selected]) editor.select(created[json.selected]);
    editor.emit("elements");
  });
  return { json, loaded };
}

/** Repoint splat sources at a freshly written project file (the old File snapshot may become unreadable). */
export async function rebindSources(editor: Editor, file: Blob) {
  const { json: written, slice } = await readProject(file);
  {
    const splats = editor.splats();
    let i = 0;
    for (const j of written.elements) {
      if (j.kind !== "splat") continue;
      const el = splats[i++];
      if (el) el.source = slice(j.data);
    }
  }
}
