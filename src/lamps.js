// Street-light posts near the camera, at the same spots whose light pools the
// ground paints (roads.js lampsFor). Only shown at night; the lamp heads glow.

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  NoBlending,
  Quaternion,
  Vector3
} from 'three'
import { geodeticToLocal, localToGeodetic } from './geo.js'
import { NIGHT_UNIFORMS } from './night.js'
import { lampsFor } from './roads.js'
import { receiveShadows } from './shadows.js'

const RANGE = 420 // m
const MAX = 1500
const POLE_HEIGHT = 7.5

const poleGeometry = new CylinderGeometry(0.07, 0.1, POLE_HEIGHT, 6).translate(0, POLE_HEIGHT / 2, 0)
// Arm and head reach 1.6 m over the road (local -z of the instance).
const headGeometry = new BoxGeometry(0.34, 0.16, 0.7).translate(0, POLE_HEIGHT - 0.1, -1.6)
const armGeometry = new BoxGeometry(0.06, 0.06, 1.6).translate(0, POLE_HEIGHT - 0.02, -0.8)

const glowMaterial = new MeshBasicMaterial({ color: 0xfff1d6, blending: NoBlending })
glowMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.nightLights = NIGHT_UNIFORMS.nightLights
  shader.fragmentShader = 'uniform float nightLights;\n' + shader.fragmentShader.replace(
    '#include <color_fragment>',
    '#include <color_fragment>\n  if (nightLights > 0.5) diffuseColor.a = 0.02;' // full glow (night.js)
  )
}

const m = new Matrix4()
const q = new Quaternion()
const p = new Vector3()
const one = new Vector3(1, 1, 1)
const Y = new Vector3(0, 1, 0)
const geo = { lat: 0, lon: 0, height: 0 }

export class Lamps {
  constructor(roads, terrain) {
    this.roads = roads
    this.terrain = terrain
    this.group = new Group()
    this.group.name = 'lamps'
    const metal = receiveShadows(new MeshBasicMaterial({ color: 0x5d6064 }))
    this.poles = new InstancedMesh(poleGeometry, metal, MAX)
    this.arms = new InstancedMesh(armGeometry, metal, MAX)
    this.heads = new InstancedMesh(headGeometry, glowMaterial, MAX)
    for (const mesh of [this.poles, this.arms, this.heads]) {
      mesh.count = 0
      mesh.frustumCulled = false
      this.group.add(mesh)
    }
    this.center = null
    this.count = 0
    this.building = false
  }

  set visible(on) {
    this.group.visible = on
  }

  // Rebuilds the instance list when the camera has moved far enough.
  async update(camPos) {
    if (!this.group.visible || this.building || !this.roads.index) return
    if (this.center && Math.hypot(camPos.x - this.center.x, camPos.z - this.center.z) < 60 && this.complete) return
    this.building = true
    try {
      const keys = this.roads.keysIn(camPos.x - RANGE, camPos.x + RANGE, camPos.z - RANGE, camPos.z + RANGE)
      const tiles = (await Promise.all(keys.map((k) => this.roads.get(k).catch(() => null)))).filter(Boolean)
      const lamps = []
      for (const t of tiles) {
        for (const l of lampsFor(t)) {
          const d = Math.hypot(l[0] - camPos.x, l[1] - camPos.z)
          if (d < RANGE) lamps.push([d, l])
        }
      }
      lamps.sort((a, b) => a[0] - b[0])
      let n = 0
      let missing = 0
      for (const [, [x, z, sx, sz]] of lamps) {
        if (n >= MAX) break
        p.set(x, camPos.y, z)
        localToGeodetic(p, geo)
        const h = this.terrain.heightAt(geo.lat, geo.lon)
        if (h == null) {
          missing++
          continue
        }
        geodeticToLocal(geo.lat, geo.lon, h, p)
        // Face the arm toward the road: local -z points along (sx, sz).
        q.setFromAxisAngle(Y, Math.atan2(-sx, -sz))
        m.compose(p, q, one)
        this.poles.setMatrixAt(n, m)
        this.arms.setMatrixAt(n, m)
        this.heads.setMatrixAt(n, m)
        n++
      }
      for (const mesh of [this.poles, this.arms, this.heads]) {
        mesh.count = n
        mesh.instanceMatrix.needsUpdate = true
      }
      this.count = n
      this.center = camPos.clone()
      this.complete = missing === 0
    } finally {
      this.building = false
    }
  }
}
