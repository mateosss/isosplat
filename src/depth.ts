import * as THREE from "three";
import { dyno, type SplatMesh } from "@sparkjsdev/spark";
import type { Editor } from "./editor";

/*
 * Depth view: colors every gaussian / point by its view-space depth (distance
 * along the camera's viewing axis) using matplotlib's "jet" colormap.
 * Both renderers read the same [min, max] range, so splats and point clouds match.
 */

/** GLSL jet colormap (matplotlib), t in [0, 1] -> sRGB. Dark blue -> blue -> cyan -> yellow -> red -> dark red. */
const JET_GLSL = "clamp(vec3(1.5) - abs(vec3(4.0 * t) - vec3(3.0, 2.0, 1.0)), 0.0, 1.0)";

/** CSS gradient with the same colormap, for the legend. */
export const JET_CSS =
  "linear-gradient(to right, rgb(0,0,128) 0%, rgb(0,0,255) 12.5%, rgb(0,255,255) 37.5%, rgb(255,255,0) 62.5%, rgb(255,0,0) 87.5%, rgb(128,0,0) 100%)";

// ---------------------------------------------------------------- shared range

const splatMin = new dyno.DynoFloat({ value: 0.5 });
const splatMax = new dyno.DynoFloat({ value: 20 });

/** three.js uniforms shared by every point-cloud material. */
export const pointDepthUniforms = {
  uDepthView: { value: false },
  uDepthMin: { value: 0.5 },
  uDepthMax: { value: 20 },
};

export const depthRange = { min: 0.5, max: 20 };

/** Set the current range. Returns true if it changed (splats then need regenerating). */
export function setDepthRange(min: number, max: number) {
  if (max - min < 1e-3) max = min + 1e-3;
  if (Math.abs(min - depthRange.min) < 1e-5 && Math.abs(max - depthRange.max) < 1e-5) return false;
  depthRange.min = splatMin.value = pointDepthUniforms.uDepthMin.value = min;
  depthRange.max = splatMax.value = pointDepthUniforms.uDepthMax.value = max;
  return true;
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
function makeJetModifier(mesh: SplatMesh) {
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (!gsplat) throw new Error("No gsplat input");
    const { center } = dyno.splitGsplat(gsplat).outputs;
    const { z } = dyno.split(mesh.context.worldToView.apply(center)).outputs;
    const { rgb } = new JetDepth({ depth: dyno.neg(z), zMin: splatMin, zMax: splatMax }).outputs;
    return { gsplat: dyno.combineGsplat({ gsplat, rgb }) };
  });
}

export function setSplatDepthView(mesh: SplatMesh, on: boolean) {
  mesh.enableWorldToView = on; // regenerate when the camera moves
  mesh.worldModifier = on ? makeJetModifier(mesh) : undefined;
  mesh.updateGenerator();
}

// ---------------------------------------------------------------- point clouds (three.js)

/** Patch a PointsMaterial so it can color points by depth (toggled by the shared uniforms). */
export function addPointDepthView(material: THREE.PointsMaterial) {
  material.onBeforeCompile = (shader) => {
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
  };
}

// ---------------------------------------------------------------- automatic range

/**
 * Depth range covering what is actually visible: each splat's robust bounding box,
 * clipped by the enabled cut-planes, measured along the camera's view axis.
 */
export function autoDepthRange(editor: Editor, camera: THREE.Camera): { min: number; max: number } | null {
  camera.updateMatrixWorld();
  const view = camera.matrixWorldInverse;
  let min = Infinity, max = -Infinity;
  const corner = new THREE.Vector3();
  for (const s of editor.splats()) {
    if (!s.loaded || !s.visible) continue;
    const box = s.bounds.clone().applyMatrix4(s.root.matrixWorld);
    for (const c of editor.cutPlanes()) {
      if (!c.enabled) continue;
      const axis = c.axisIndex();
      const p = c.root.position.getComponent(axis);
      if (c.direction[0] === "+") box.min.setComponent(axis, Math.max(box.min.getComponent(axis), p));
      else box.max.setComponent(axis, Math.min(box.max.getComponent(axis), p));
    }
    if (box.isEmpty()) continue;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      const d = -corner.applyMatrix4(view).z;
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
  }
  if (!Number.isFinite(min)) return null;
  return { min: Math.max(0, min), max: Math.max(max, Math.max(0, min) + 1e-3) };
}

/**
 * Per-frame update: toggle depth view on every element and refresh the range
 * (automatic for `camera`, or the manual values from the world settings).
 */
export function updateDepthView(editor: Editor, camera: THREE.Camera) {
  const w = editor.world;
  pointDepthUniforms.uDepthView.value = w.depthView;
  for (const s of editor.splats()) if (s.loaded && s.depthView !== w.depthView) s.setDepthView(w.depthView);
  if (!w.depthView) return;
  if (w.depthAuto) {
    const r = autoDepthRange(editor, camera);
    if (r) {
      w.depthMin = r.min;
      w.depthMax = r.max;
    }
  }
  if (setDepthRange(w.depthMin, w.depthMax)) {
    for (const s of editor.splats()) if (s.loaded) s.mesh.updateVersion();
  }
}
