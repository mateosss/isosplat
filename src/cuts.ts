import * as THREE from "three";

/*
 * Every cut (bounded cut-plane or cut-box) is described the same way: an oriented
 * box given by a world -> box-local matrix and half extents. A point is removed if
 * it lies inside any enabled box. Gaussians use Spark BOX SDFs with the same box;
 * point clouds use the uniforms below in their shader.
 */

export const MAX_POINT_CUTS = 64;

/** Uniforms shared by every point-cloud material (filled each frame by the editor). */
export const pointCutUniforms = {
  uCutCount: { value: 0 },
  uCutInv: { value: Array.from({ length: MAX_POINT_CUTS }, () => new THREE.Matrix4()) },
  uCutHalf: { value: Array.from({ length: MAX_POINT_CUTS }, () => new THREE.Vector3()) },
};

/** Inject the cut test into a PointsMaterial shader (vertex stage: points inside a cut are moved off-screen). */
export function patchPointCutShader(shader: THREE.WebGLProgramParametersWithUniforms) {
  Object.assign(shader.uniforms, pointCutUniforms);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
      #define MAX_POINT_CUTS ${MAX_POINT_CUTS}
      uniform int uCutCount;
      uniform mat4 uCutInv[MAX_POINT_CUTS];
      uniform vec3 uCutHalf[MAX_POINT_CUTS];`,
    )
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>
      {
        vec4 cutWorld = modelMatrix * vec4(transformed, 1.0);
        for (int i = 0; i < MAX_POINT_CUTS; i++) {
          if (i >= uCutCount) break;
          vec3 l = (uCutInv[i] * cutWorld).xyz;
          if (all(lessThanEqual(abs(l), uCutHalf[i]))) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume: culled
          }
        }
      }`,
    );
}
