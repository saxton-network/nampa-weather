// Physically based sky, sun/sky lighting and aerial perspective
// (@takram/three-atmosphere, Bruneton precomputed scattering).
//
// Scene materials are unlit (MeshBasicMaterial) and treated as albedo; the
// AerialPerspectiveEffect lights them from a normal buffer, adds haze with
// distance, and draws the sky, sun and moon behind everything.

import {
  AerialPerspectiveEffect,
  getMoonDirectionECEF,
  getSunDirectionECEF,
  PrecomputedTexturesGenerator
} from '@takram/three-atmosphere'
import {
  EffectComposer,
  EffectPass,
  NormalPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode
} from 'postprocessing'
import { HalfFloatType, Vector3 } from 'three'
import { ecefDirToLocal, WORLD_TO_ECEF } from './geo.js'
import { NIGHT_UNIFORMS, NightEffect } from './night.js'

export class Sky {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.ready = false
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType })
    this.normalPass = new NormalPass(scene, camera)
    this.night = new NightEffect(camera)
    this.sunECEF = new Vector3()
    this.moonECEF = new Vector3()
    // Direction of the light that lights the scene: the sun, or the moon at night.
    this.lightECEF = new Vector3()
    this.aerial = new AerialPerspectiveEffect(camera, {
      sky: true,
      sunLight: true,
      skyLight: true,
      correctGeometricError: true,
      normalBuffer: this.normalPass.texture
    })
    this.aerial.worldToECEFMatrix.copy(WORLD_TO_ECEF)
    this.composer.addPass(new RenderPass(scene, camera))
    this.composer.addPass(this.normalPass)
    this.composer.addPass(
      new EffectPass(camera, this.aerial, this.night, new ToneMappingEffect({ mode: ToneMappingMode.AGX }), new SMAAEffect())
    )

    this.generator = new PrecomputedTexturesGenerator(renderer)
    this.generator
      .update()
      .then(() => {
        Object.assign(this.aerial, this.generator.textures)
        this.ready = true
      })
      .catch((err) => {
        this.error = String(err?.message ?? err)
      })
  }

  // Sets the sun and moon for `date`. Once the sun is well below the horizon
  // the moon becomes the light source: the atmosphere is lit from its
  // direction (moonlit sky glow, moon shadows) and the night effect draws the
  // moon disc with its real phase, stars and city lights.
  setDate(date) {
    getSunDirectionECEF(date, this.sunECEF)
    getMoonDirectionECEF(date, this.moonECEF)
    const sunUp = this.elevation(this.sunECEF)
    this.isNight = sunUp < -6
    const n = this.night.uniforms
    n.get('night').value = this.isNight ? 1 : 0
    NIGHT_UNIFORMS.nightLights.value = this.isNight ? 1 : 0
    ecefDirToLocal(this.moonECEF, n.get('moonDir').value)
    ecefDirToLocal(this.sunECEF, n.get('sunDir').value)
    this.lightECEF.copy(this.isNight ? this.moonECEF : this.sunECEF)
    this.aerial.sunDirection.copy(this.lightECEF)
    this.aerial.moonDirection.copy(this.moonECEF)
    this.aerial.sun = !this.isNight
    this.aerial.moon = !this.isNight
  }

  // Elevation in degrees of an ECEF direction, seen from the scene origin.
  elevation(dir) {
    const up = WORLD_TO_ECEF.elements
    return (Math.asin(up[4] * dir.x + up[5] * dir.y + up[6] * dir.z) * 180) / Math.PI
  }

  get sunElevation() {
    return this.elevation(this.sunECEF)
  }

  get moonElevation() {
    return this.elevation(this.moonECEF)
  }

  setSize(w, h) {
    this.composer.setSize(w, h)
  }

  render(dt) {
    if (this.ready) this.composer.render(dt)
  }
}
