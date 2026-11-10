import * as THREE from "three";
import { dyno, type SplatMesh } from "@sparkjsdev/spark";
import type { Editor } from "./editor";

/*
 * Depth view: colors every gaussian / point by its view-space depth (distance
 * along the camera's viewing axis) using matplotlib's "jet" colormap.
 * Splats and point clouds read the same [min, max] range for a view, so they match.
 * Each view has its own range: point clouds get it through shared uniforms set
 * before the view renders, splats through per-mesh uniforms (each view renders its
 * own SplatMesh, see SplatElement.viewMesh).
 */

/** GLSL jet colormap (matplotlib), t in [0, 1] -> sRGB. Dark blue -> blue -> cyan -> yellow -> red -> dark red. */
const JET_GLSL = "clamp(vec3(1.5) - abs(vec3(4.0 * t) - vec3(3.0, 2.0, 1.0)), 0.0, 1.0)";

/** CSS gradient with the same colormap, for the legend. */
export const JET_CSS =
  "linear-gradient(to right, rgb(0,0,128) 0%, rgb(0,0,255) 12.5%, rgb(0,255,255) 37.5%, rgb(255,255,0) 62.5%, rgb(255,0,0) 87.5%, rgb(128,0,0) 100%)";

// ---------------------------------------------------------------- range

/** Depth range uniforms of one SplatMesh. */
export interface MeshDepthUniforms {
  min: dyno.DynoFloat;
  max: dyno.DynoFloat;
}

export function makeDepthUniforms(): MeshDepthUniforms {
  return { min: new dyno.DynoFloat({ value: 0.5 }), max: new dyno.DynoFloat({ value: 20 }) };
}

/** Set a mesh's range; regenerates its splats only if it changed. */
export function setMeshDepthRange(mesh: SplatMesh, u: MeshDepthUniforms, min: number, max: number) {
  if (Math.abs(u.min.value - min) < 1e-5 && Math.abs(u.max.value - max) < 1e-5) return;
  u.min.value = min;
  u.max.value = max;
  mesh.updateVersion();
}

/** three.js uniforms shared by every point-cloud material. */
export const pointDepthUniforms = {
  uDepthView: { value: false },
  uDepthMin: { value: 0.5 },
  uDepthMax: { value: 20 },
};

export const depthRange = { min: 0.5, max: 20 };

/** Range of the view being rendered (point clouds read it). */
function setPointDepthRange(min: number, max: number) {
  depthRange.min = pointDepthUniforms.uDepthMin.value = min;
  depthRange.max = pointDepthUniforms.uDepthMax.value = max;
}

// ---------------------------------------------------------------- splats (Spark dyno)

type F = dyno.DynoVal<"float">;

class JetDepth extends dyno.Dyno<{ depth: "float"; zMin: "float"; zMax: "float" }, { rgb: "vec3" }> {
  constructor(inputs: { depth: F; zMin: F; zMax: F }) {
    super({
      inTypes: { depth: "float", zMin: "float", zMax: "float" },
      outTypes: { rgb: "vec3" },
      inputs,
      statements: ({ inputs: i, outputs: o }) => [
        `float t = clamp((${i.depth} - ${i.zMin}) / max(${i.zMax} - ${i.zMin}, 1e-6), 0.0, 1.0);`,
        `${o.rgb} = ${JET_GLSL};`,
      ],
    });
  }
}

/** World-space modifier for one mesh: replaces the color by jet(depth), keeps opacity and shape. */
function makeJetModifier(mesh: SplatMesh, u: MeshDepthUniforms) {
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (!gsplat) throw new Error("No gsplat input");
    const { center } = dyno.splitGsplat(gsplat).outputs;
    const { z } = dyno.split(mesh.context.worldToView.apply(center)).outputs;
    const { rgb } = new JetDepth({ depth: dyno.neg(z), zMin: u.min, zMax: u.max }).outputs;
    return { gsplat: dyno.combineGsplat({ gsplat, rgb }) };
  });
}

export function setSplatDepthView(mesh: SplatMesh, u: MeshDepthUniforms, on: boolean) {
  mesh.enableWorldToView = on; // regenerate when the camera moves
  mesh.worldModifier = on ? makeJetModifier(mesh, u) : undefined;
  mesh.updateGenerator();
}

// ---------------------------------------------------------------- point clouds (three.js)

/** Inject depth coloring into a PointsMaterial shader (toggled by the shared uniforms). */
export function patchPointDepthShader(shader: THREE.WebGLProgramParametersWithUniforms) {
  {
    Object.assign(shader.uniforms, pointDepthUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vViewDepth;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvViewDepth = -mvPosition.z;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vViewDepth;\nuniform bool uDepthView;\nuniform float uDepthMin;\nuniform float uDepthMax;",
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        if (uDepthView) {
          float t = clamp((vViewDepth - uDepthMin) / max(uDepthMax - uDepthMin, 1e-6), 0.0, 1.0);
          // jet is defined in sRGB; three expects linear here and encodes on output.
          diffuseColor.rgb = sRGBTransferEOTF(vec4(${JET_GLSL}, 1.0)).rgb;
        }`,
      );
  }
}

// ---------------------------------------------------------------- automatic range

/**
 * Depth range covering what is actually visible: a sample of each splat's centers,
 * minus the ones removed by cuts, measured along the camera's view axis
 * (1st–99th percentile, so floaters don't stretch the colormap).
 */
export function autoDepthRange(editor: Editor, camera: THREE.Camera): { min: number; max: number } | null {
  camera.updateMatrixWorld();
  const toView = camera.matrixWorldInverse;
  const depths: number[] = [];
  const p = new THREE.Vector3();
  for (const s of editor.splats()) {
    if (!s.loaded || !s.visible) continue;
    s.root.updateMatrixWorld();
    const m = s.root.matrixWorld;
    const smp = s.samples;
    for (let i = 0; i < smp.length; i += 3) {
      p.set(smp[i], smp[i + 1], smp[i + 2]).applyMatrix4(m);
      if (editor.isCut(p)) continue;
      depths.push(-p.applyMatrix4(toView).z);
    }
  }
  if (depths.length === 0) return null;
  const sorted = Float64Array.from(depths).sort();
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
  const min = Math.max(0, at(0.01));
  return { min, max: Math.max(at(0.99), min + 1e-3) };
}

/**
 * Called before rendering a view: toggle depth view on every element and set the range
 * (automatic for `camera`, or the manual values from the world settings). Views have
 * their own automatic range; only the main view writes it back to the world settings.
 */
export function updateDepthView(
  editor: Editor,
  camera: THREE.Camera,
  viewIndex: number,
  writeWorld = true,
): { min: number; max: number } | null {
  const w = editor.world;
  pointDepthUniforms.uDepthView.value = w.depthView;
  for (const s of editor.splats()) if (s.loaded && s.depthView !== w.depthView) s.setDepthView(w.depthView);
  if (!w.depthView) return null;
  let min = w.depthMin, max = w.depthMax;
  if (w.depthAuto) {
    const r = autoDepthRange(editor, camera);
    if (r) ({ min, max } = r);
    else ({ min, max } = depthRange); // nothing visible: keep the last range
    if (writeWorld) {
      w.depthMin = min;
      w.depthMax = max;
    }
  }
  if (max - min < 1e-3) max = min + 1e-3;
  setPointDepthRange(min, max);
  for (const s of editor.splats()) if (s.loaded) s.setDepthRange(viewIndex, min, max);
  return { min, max };
}
