// Ground shader: paints each terrain tile from its ground-type map (classified
// from aerial photos by data-prep/build_landcover.py) and its road texture
// (roads.js), with procedural detail that stays sharp up close and fades out
// with distance. Output is unlit albedo; the atmosphere pass lights it.

import { Color, DataTexture, NearestFilter, ShaderMaterial, Vector4 } from 'three'
import { SHADOW_GLSL, SHADOW_UNIFORMS } from './shadows.js'

// Ground types, same ids as build_landcover.py. Two colours per type (sRGB),
// blended by the noise mix in `w` (large patches, mid, fine grain, crop rows).
const TYPES = [
  { name: 'unknown', a: 0x8f8a74, b: 0x7d7865, w: [0.6, 0.3, 0.3, 0] },
  { name: 'lawn', a: 0x557f2f, b: 0x7a9e40, w: [0.7, 0.4, 0.35, 0] },
  { name: 'trees', a: 0x2a4422, b: 0x41632e, w: [0.3, 0.8, 0.4, 0] },
  { name: 'scrub', a: 0x8d8259, b: 0x6c7046, w: [0.5, 0.6, 0.5, 0] },
  { name: 'dirt', a: 0x977b57, b: 0xb09673, w: [0.6, 0.4, 0.45, 0] },
  { name: 'asphalt', a: 0x3a3a3d, b: 0x4a4a4b, w: [0.3, 0.2, 0.6, 0] },
  { name: 'concrete', a: 0x958f84, b: 0xa7a296, w: [0.4, 0.2, 0.5, 0] },
  { name: 'water', a: 0x23414f, b: 0x34606e, w: [0.4, 0.7, 0.2, 0] },
  { name: 'crop', a: 0x4e7c2a, b: 0x6c9a3a, w: [0.6, 0.2, 0.2, 0.7] },
  { name: 'plowed', a: 0x5f4430, b: 0x7f5d42, w: [0.4, 0.2, 0.3, 0.8] },
  { name: 'sand', a: 0xcdbb92, b: 0xe0d2ad, w: [0.3, 0.3, 0.5, 0] },
  { name: 'pool', a: 0x3fa6c9, b: 0x62c0dd, w: [0.1, 0.5, 0.1, 0] }
]
const N = TYPES.length

const lin = (hex) => {
  const c = new Color().setHex(hex) // three converts sRGB hex to linear
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`
}
const arr = (fn) => TYPES.map(fn).join(',\n  ')

const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vPos;
void main() {
  vUv = uv;
  vPos = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`

const fragmentShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D classMap;
uniform vec4 classXform; // xy offset, zw scale into the ground-type map
uniform sampler2D roadMap;
uniform float hasRoads;
varying vec2 vUv;
varying vec3 vPos;
${SHADOW_GLSL}

const vec3 COLOR_A[${N}] = vec3[](
  ${arr((t) => lin(t.a))}
);
const vec3 COLOR_B[${N}] = vec3[](
  ${arr((t) => lin(t.b))}
);
const vec4 MIX[${N}] = vec4[](
  ${arr((t) => `vec4(${t.w.map((v) => v.toFixed(2)).join(', ')})`)}
);
const vec3 ASPHALT = ${lin(0x333436)};
const vec3 ASPHALT_WORN = ${lin(0x46464a)};
const vec3 SIDEWALK = ${lin(0xa9a59c)};
const vec3 PAINT_WHITE = ${lin(0xe4e3dd)};
const vec3 PAINT_YELLOW = ${lin(0xd9ab2a)};

// Value noise on a lattice that repeats every 'period' cells. Coordinates are
// reduced modulo 1024 m first, so noise stays precise far from the origin
// and stays seamless across tiles.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, period));
  float b = hash12(mod(i + vec2(1.0, 0.0), period));
  float c = hash12(mod(i + vec2(0.0, 1.0), period));
  float d = hash12(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

vec3 groundColor(int id, vec4 n) {
  float t = clamp(0.5 + dot(MIX[id], n - 0.5) * 1.6, 0.0, 1.0);
  return mix(COLOR_A[id], COLOR_B[id], t);
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 w = mod(vPos.xz, 1024.0);
  // Metres covered by one pixel: fades fine detail out with distance.
  float px = length(fwidth(vPos.xz));
  float fine = 1.0 - smoothstep(0.04, 0.35, px);
  float grain = 1.0 - smoothstep(0.01, 0.08, px);
  // Surface grit (gravel, asphalt aggregate, grass blades) seen only up close.
  float grit = mix(0.5, vnoise(w * 40.0, 40960.0), 1.0 - smoothstep(0.004, 0.03, px));
  vec4 n = vec4(
    vnoise(w / 64.0, 16.0) * 0.6 + vnoise(w / 16.0, 64.0) * 0.4,
    vnoise(w / 2.0, 512.0),
    mix(0.5, vnoise(w * 2.0, 2048.0) * 0.6 + vnoise(w * 8.0, 8192.0) * 0.4, fine),
    mix(0.5, 0.5 + 0.5 * sin(vPos.x * 8.267), grain) // crop rows ~0.76 m apart
  );

  // Blend the four nearest ground-type texels, with jittered edges so the
  // map's pixel grid never shows.
  vec2 tp = (classXform.xy + vUv * classXform.zw) * 256.0 - 0.5;
  // Two octaves of offset: broad wobble plus finer ragged edges, in texels.
  tp += (vec2(vnoise(w / 2.5, 409.6), vnoise(w / 2.5 + 17.0, 409.6)) - 0.5) * 1.6;
  tp += (vec2(vnoise(w * 1.25, 1280.0), vnoise(w * 1.25 + 31.0, 1280.0)) - 0.5) * 0.6;
  vec2 cell = floor(tp);
  vec2 f = smoothstep(0.05, 0.95, fract(tp));
  ivec2 c0 = clamp(ivec2(cell), ivec2(0), ivec2(255));
  ivec2 c1 = clamp(ivec2(cell) + 1, ivec2(0), ivec2(255));
  int i00 = int(texelFetch(classMap, ivec2(c0.x, c0.y), 0).r * 255.0 + 0.5);
  int i10 = int(texelFetch(classMap, ivec2(c1.x, c0.y), 0).r * 255.0 + 0.5);
  int i01 = int(texelFetch(classMap, ivec2(c0.x, c1.y), 0).r * 255.0 + 0.5);
  int i11 = int(texelFetch(classMap, ivec2(c1.x, c1.y), 0).r * 255.0 + 0.5);
  i00 = min(i00, ${N - 1}); i10 = min(i10, ${N - 1}); i01 = min(i01, ${N - 1}); i11 = min(i11, ${N - 1});
  vec3 col = mix(
    mix(groundColor(i00, n), groundColor(i10, n), f.x),
    mix(groundColor(i01, n), groundColor(i11, n), f.x),
    f.y
  );

  if (hasRoads > 0.5) {
    vec4 r = texture2D(roadMap, vUv);
    float asphalt = smoothstep(0.3, 0.7, r.r);
    float side = smoothstep(0.2, 0.45, r.g) * (1.0 - asphalt);
    float yellow = clamp((r.g - 0.5) * 2.2, 0.0, 1.0) * asphalt;
    float white = clamp(r.b * 1.2, 0.0, 1.0);
    vec3 road = mix(ASPHALT, ASPHALT_WORN, clamp(n.x * 0.8 + (n.z - 0.5) * 0.8, 0.0, 1.0));
    vec3 walk = SIDEWALK * (0.92 + 0.16 * n.z);
    col = mix(col, walk, side);
    col = mix(col, road * (0.9 + 0.2 * grit), asphalt);
    col = mix(col, PAINT_YELLOW, yellow);
    col = mix(col, PAINT_WHITE, white);
  }
  col *= 0.88 + 0.24 * grit;
  col *= sunShade(vPos);
  gl_FragColor = vec4(col, 1.0);
}
`

// 1x1 black stand-in for tiles without roads.
const NO_ROADS = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
NO_ROADS.needsUpdate = true

const base = new ShaderMaterial({
  name: 'ground',
  vertexShader,
  fragmentShader,
  uniforms: {
    classMap: { value: null },
    classXform: { value: new Vector4(0, 0, 1, 1) },
    roadMap: { value: NO_ROADS },
    hasRoads: { value: 0 },
    ...SHADOW_UNIFORMS
  }
})

export function groundMaterial({ classMap, classXform, roadMap }) {
  const m = base.clone() // shares the compiled program
  Object.assign(m.uniforms, SHADOW_UNIFORMS) // shared objects, so updates reach every tile
  m.uniforms.classMap.value = classMap
  m.uniforms.classXform.value.copy(classXform)
  if (roadMap) {
    m.uniforms.roadMap.value = roadMap
    m.uniforms.hasRoads.value = 1
  }
  return m
}

export function classTextureSettings(t) {
  t.flipY = false
  t.minFilter = t.magFilter = NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}
