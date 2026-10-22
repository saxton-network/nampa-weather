// Night look, applied after the atmosphere and before tone mapping:
// a cool, desaturated grade, a star field and the moon disc (lit from the
// real sun direction, so it shows the right phase), plus glow from lit
// windows and street lights.
//
// Glowing surfaces mark themselves by writing alpha below 1 (glow = 1 - alpha);
// the atmosphere pass carries alpha through unchanged.

import { Effect, EffectAttribute } from 'postprocessing'
import { Matrix4, Uniform, Vector3 } from 'three'

// Shared with the ground, building and lamp shaders: 1 when lights are on.
export const NIGHT_UNIFORMS = { nightLights: { value: 0 } }

const fragmentShader = /* glsl */ `
uniform float night;
uniform vec3 moonDir;
uniform vec3 sunDir;
uniform mat4 viewToWorld;
uniform mat4 projInverse;
uniform float exposure;
uniform float moonSize;

float h13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  if (night > 0.5) {
    // Night vision: colour drains out and shifts blue.
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c, l * vec3(0.55, 0.72, 1.2), 0.8);
    // Display-referred amounts below are divided by exposure so they read
    // the same however bright the moonlight is set.
    float k = 1.0 / exposure;
    if (depth >= 0.99999) {
      vec4 v = projInverse * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
      vec3 dir = normalize(mat3(viewToWorld) * (v.xyz / v.w));
      float up = smoothstep(0.0, 0.12, dir.y);
      // Stars: one candidate per cell of a fine grid on the sky.
      vec3 g = dir * 240.0;
      vec3 cell = floor(g);
      float hs = h13(cell);
      if (hs > 0.982) {
        vec3 jitter = vec3(h13(cell + 1.3), h13(cell + 2.7), h13(cell + 5.1)) - 0.5;
        vec3 sd = normalize(cell + 0.5 + jitter * 0.6);
        float a = length(cross(dir, sd));
        float s = smoothstep(0.0024, 0.0, a) * pow((hs - 0.982) / 0.018, 2.0);
        c += vec3(0.85, 0.92, 1.0) * s * 1.6 * k * up;
      }
      // Moon disc, lit from the sun's direction, with a soft halo.
      float cosA = dot(dir, moonDir);
      float ang = acos(clamp(cosA, -1.0, 1.0));
      vec3 moonCol = vec3(0.9, 0.92, 1.0);
      if (ang < moonSize) {
        vec3 x = (dir - moonDir * cosA) / sin(moonSize);
        float r2 = dot(x, x);
        vec3 n = x - moonDir * sqrt(max(1.0 - r2, 0.0));
        float lit = max(dot(n, sunDir), 0.0);
        float maria = 0.82 + 0.18 * h13(floor(x * 9.0 + 4.0));
        float edge = smoothstep(1.0, 0.94, sqrt(r2));
        c = mix(c, moonCol * (lit * maria * 2.6 + 0.025) * k, edge);
      }
      c += moonCol * exp(-ang / 0.06) * 0.06 * k * up;
    }
    float a = inputColor.a;
    float glow = (a > 0.001 && a < 0.995) ? 1.0 - a : 0.0;
    c += vec3(1.0, 0.72, 0.38) * glow * 1.3 * k;
  }
  outputColor = vec4(c, 1.0);
}
`

export class NightEffect extends Effect {
  constructor(camera) {
    super('NightEffect', fragmentShader, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([
        ['night', new Uniform(0)],
        ['moonDir', new Uniform(new Vector3(0, 1, 0))],
        ['sunDir', new Uniform(new Vector3(0, -1, 0))],
        ['viewToWorld', new Uniform(new Matrix4())],
        ['projInverse', new Uniform(new Matrix4())],
        ['exposure', new Uniform(1)],
        // Drawn about 2.5x its real 0.26 degree radius so it reads on screen.
        ['moonSize', new Uniform(0.0115)]
      ])
    })
    this.camera = camera
  }

  update(renderer) {
    const u = this.uniforms
    u.get('viewToWorld').value.copy(this.camera.matrixWorld)
    u.get('projInverse').value.copy(this.camera.projectionMatrixInverse)
    u.get('exposure').value = renderer.toneMappingExposure
  }
}
