// Sun shadows for buildings and trees.
//
// The scene's materials are unlit albedo (the atmosphere pass does the
// lighting), so three's built-in shadow maps don't apply. Instead buildings
// and trees are rendered into a depth map from the (fixed) sun direction over
// a box that follows the camera, and the ground, building and tree shaders
// darken their albedo where that map says they are in shadow.

import {
  DepthTexture,
  Matrix4,
  MeshDepthMaterial,
  NearestFilter,
  OrthographicCamera,
  UnsignedIntType,
  Vector3,
  WebGLRenderTarget
} from 'three'
import { WORLD_TO_ECEF } from './geo.js'

// Shared uniform objects: every material that receives shadows points at these.
export const SHADOW_UNIFORMS = {
  sunShadowMap: { value: null },
  sunShadowMatrix: { value: new Matrix4() },
  sunShadowOn: { value: 0 },
  sunShadowTexel: { value: 1 / 2048 }
}

// Albedo multiplier in full shadow: the sun's share is gone, sky light remains.
const DARK = 0.42

export const SHADOW_GLSL = /* glsl */ `
uniform sampler2D sunShadowMap;
uniform mat4 sunShadowMatrix;
uniform float sunShadowOn;
uniform float sunShadowTexel;
// 1 in full sun, ${DARK} in full shadow; fades out toward the box edge.
float sunShade(vec3 worldPos) {
  if (sunShadowOn < 0.5) return 1.0;
  vec4 sc = sunShadowMatrix * vec4(worldPos, 1.0);
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float lit = 0.0;
  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      float d = texture2D(sunShadowMap, sc.xy + vec2(float(i), float(j)) * sunShadowTexel).r;
      lit += step(sc.z - 0.0004, d);
    }
  }
  lit /= 9.0;
  vec2 edge = min(sc.xy, 1.0 - sc.xy);
  float fade = smoothstep(0.0, 0.08, min(edge.x, edge.y));
  return mix(1.0, mix(${DARK.toFixed(2)}, 1.0, lit), fade);
}
`

// Patches a MeshBasicMaterial (optionally instanced) to receive sun shadows.
export function receiveShadows(material) {
  const previous = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer)
    Object.assign(shader.uniforms, SHADOW_UNIFORMS)
    shader.vertexShader = 'varying vec3 vSunWorld;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
  #ifdef USE_INSTANCING
    vSunWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
    vSunWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif`
    )
    shader.fragmentShader = 'varying vec3 vSunWorld;\n' + SHADOW_GLSL + shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  diffuseColor.rgb *= sunShade(vSunWorld);'
    )
  }
  material.customProgramCacheKey = () => `${material.type}-sun-shadow`
  return material
}

export class SunShadows {
  constructor(renderer, size = 2048) {
    this.renderer = renderer
    this.size = size
    this.target = new WebGLRenderTarget(size, size, {
      depthTexture: new DepthTexture(size, size, UnsignedIntType),
      depthBuffer: true
    })
    this.target.depthTexture.minFilter = this.target.depthTexture.magFilter = NearestFilter
    this.camera = new OrthographicCamera(-100, 100, 100, -100, 1, 2400)
    this.depthMaterial = new MeshDepthMaterial()
    this.sun = new Vector3(0, 1, 0)
    this.lastKey = ''
    SHADOW_UNIFORMS.sunShadowMap.value = this.target.depthTexture
    SHADOW_UNIFORMS.sunShadowTexel.value = 1 / size
  }

  disable() {
    SHADOW_UNIFORMS.sunShadowOn.value = 0
    this.lastKey = ''
  }

  // sunECEF: unit vector toward the sun in ECEF.
  setSun(sunECEF) {
    const m = WORLD_TO_ECEF.elements
    this.sun.set(
      m[0] * sunECEF.x + m[1] * sunECEF.y + m[2] * sunECEF.z,
      m[4] * sunECEF.x + m[5] * sunECEF.y + m[6] * sunECEF.z,
      m[8] * sunECEF.x + m[9] * sunECEF.y + m[10] * sunECEF.z
    ).normalize()
    this.lastKey = ''
  }

  // Re-renders the depth map when the box around `center` (radius r metres)
  // moves to a new grid cell; `casters` are the objects that cast shadows,
  // `hidden` are hidden for the pass.
  update(scene, center, r, casters, hidden) {
    if (this.sun.y < 0.05) {
      SHADOW_UNIFORMS.sunShadowOn.value = 0
      return
    }
    // Snap to a coarse grid so the map is only redrawn now and then, and
    // doesn't shimmer as the camera moves.
    const radius = 2 ** Math.ceil(Math.log2(Math.max(r, 60)))
    const step = radius / 4
    const cx = Math.round(center.x / step) * step
    const cz = Math.round(center.z / step) * step
    const key = `${radius}:${cx}:${cz}:${casters.map((c) => c.children.length).join(',')}`
    if (key === this.lastKey) return
    this.lastKey = key

    const cam = this.camera
    cam.left = cam.bottom = -radius
    cam.right = cam.top = radius
    cam.near = 1
    cam.far = 2400
    cam.position.set(cx, center.y, cz).addScaledVector(this.sun, 1200)
    cam.up.set(0, 0, -1)
    cam.lookAt(cx, center.y, cz)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()

    const vis = hidden.map((o) => o.visible)
    for (const o of hidden) o.visible = false
    const override = scene.overrideMaterial
    scene.overrideMaterial = this.depthMaterial
    const rt = this.renderer.getRenderTarget()
    this.renderer.setRenderTarget(this.target)
    this.renderer.clear()
    this.renderer.render(scene, cam)
    this.renderer.setRenderTarget(rt)
    scene.overrideMaterial = override
    hidden.forEach((o, k) => (o.visible = vis[k]))

    // World -> shadow-map UV and depth in [0, 1].
    SHADOW_UNIFORMS.sunShadowMatrix.value
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(cam.projectionMatrix)
      .multiply(cam.matrixWorldInverse)
    SHADOW_UNIFORMS.sunShadowOn.value = 1
  }
}
