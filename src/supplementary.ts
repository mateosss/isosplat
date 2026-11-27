import type { ProjectJson } from "./project";

/*
 * Bundled scenes of the supplementary-material build (see scripts/build-supplementary.mjs).
 *
 * The build must work when opened straight from disk (file://), where fetch() and module
 * scripts are blocked. Classic <script src> still works, so each scene is a script
 * `scenes/<id>.js` that registers its project JSON and its splat data: the splat files
 * concatenated, gzipped and split into base64 chunks. The scene list is inlined in the page.
 */

export interface SceneEntry {
  id: string;
  label: string;
}

interface SceneData {
  json: ProjectJson;
  chunks: string[];
}

type SceneWindow = Window & { SCENES?: SceneEntry[]; SCENE_DATA?: Record<string, SceneData> };
const w = window as SceneWindow;

export const scenes: SceneEntry[] = w.SCENES ?? [];

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => {
      s.remove();
      resolve();
    };
    s.onerror = () => {
      s.remove();
      reject(new Error(`could not load ${src}`));
    };
    document.head.append(s);
  });
}

type Base64Ctor = Uint8ArrayConstructor & { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> };

function decodeBase64(s: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as Base64Ctor).fromBase64;
  if (native) return native(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decoded scenes, so switching back to one is instant. */
const cache = new Map<string, { json: ProjectJson; data: Blob }>();

/** Load a bundled scene: its project JSON and a `slice` over its (decompressed) splat data. */
export async function loadScene(entry: SceneEntry) {
  let scene = cache.get(entry.id);
  if (!scene) {
    await loadScript(`scenes/${entry.id}.js`);
    const raw = w.SCENE_DATA?.[entry.id];
    if (!raw) throw new Error(`scene ${entry.id} is missing its data`);
    delete w.SCENE_DATA![entry.id]; // drop the base64 text once decoded
    const gz = new Blob(raw.chunks.map(decodeBase64));
    const data = await new Response(gz.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
    scene = { json: raw.json, data };
    cache.set(entry.id, scene);
  }
  const { json, data } = scene;
  return { json, slice: (d: { offset: number; length: number }) => data.slice(d.offset, d.offset + d.length) };
}
