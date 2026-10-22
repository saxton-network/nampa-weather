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
import { HalfFloatType } from 'three'
import { WORLD_TO_ECEF } from './geo.js'

export class Sky {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.ready = false
    this.composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType })
    this.normalPass = new NormalPass(scene, camera)
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
      new EffectPass(camera, this.aerial, new ToneMappingEffect({ mode: ToneMappingMode.AGX }), new SMAAEffect())
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

  setDate(date) {
    getSunDirectionECEF(date, this.aerial.sunDirection)
    getMoonDirectionECEF(date, this.aerial.moonDirection)
  }

  // Sun elevation in degrees at the scene origin (positive = above horizon).
  get sunElevation() {
    const up = WORLD_TO_ECEF.elements
    const s = this.aerial.sunDirection
    return (Math.asin(up[4] * s.x + up[5] * s.y + up[6] * s.z) * 180) / Math.PI
  }

  setSize(w, h) {
    this.composer.setSize(w, h)
  }

  render(dt) {
    if (this.ready) this.composer.render(dt)
  }
}
