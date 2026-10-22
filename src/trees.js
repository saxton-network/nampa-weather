// Low-poly 3D trees at the tree tops found in the 2018 USGS lidar survey
// (data-prep/build_trees_lidar.py), each with its measured height and crown
// radius, as a round broadleaf or a conifer. One instanced mesh per 1 km tile per shape,
// loaded only near the camera and only from low altitude.

import {
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3
} from 'three'
import { receiveShadows } from './shadows.js'

const BASE = import.meta.env.BASE_URL
// bytes: int16 x_dm, int16 z_dm, float32 base_y, uint8 height (0.2 m), uint8 crown radius (0.1 m), uint8 flags, uint8 seed
const RECORD = 12
const MAX_AGL = 600 // m; above this the trees are too small to matter
const RANGE = 1100 // m

function colored(geometry, hex) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry
  g.computeVertexNormals()
  const c = new Color().setHex(hex)
  const n = g.attributes.position.count
  const col = new Float32Array(n * 3)
  for (let k = 0; k < n; k++) c.toArray(col, k * 3)
  g.setAttribute('color', new BufferAttribute(col, 3))
  g.deleteAttribute('uv')
  return g
}

// Unit parts, each scaled per tree: a trunk (radius 1, height 1, base at 0),
// a round crown (radius 1, centred) and a conifer cone (radius 1, height 1).
const TRUNK = colored(new CylinderGeometry(0.75, 1, 1, 5).translate(0, 0.5, 0), 0x5b4532)
const CROWNS = [
  colored(new IcosahedronGeometry(1, 0), 0x3d6b2c),
  colored(new ConeGeometry(1, 1, 7).translate(0, 0.5, 0), 0x2e5227)
]

const m = new Matrix4()
const q = new Quaternion()
const p = new Vector3()
const s = new Vector3()
const Y = new Vector3(0, 1, 0)
const tint = new Color()

export class Trees {
  constructor() {
    this.group = new Group()
    this.group.name = 'trees'
    this.material = receiveShadows(new MeshBasicMaterial({ vertexColors: true }))
    this.tiles = new Map() // "i_j" -> { state, meshes, count }
    this.count = 0
    this.loading = 0
    this.ready = fetch(`${BASE}data/trees/index.json`)
      .then((r) => r.json())
      .then((index) => {
        this.index = index
      })
      .catch((err) => {
        this.lastError = `trees index: ${err.message}`
      })
  }

  set visible(on) {
    this.group.visible = on
  }

  async load(key) {
    const entry = { state: 'loading', meshes: [], count: 0 }
    this.tiles.set(key, entry)
    this.loading++
    try {
      const r = await fetch(`${BASE}data/trees/${key}.bin`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const view = new DataView(await r.arrayBuffer())
      if (this.tiles.get(key) !== entry) return
      const [i, j] = key.split('_').map(Number)
      const size = this.index.tileSize
      const n = view.byteLength / RECORD
      const shapeOf = (k) => view.getUint8(k * RECORD + 10) & 1 // conifer flag
      const counts = [0, 0]
      for (let k = 0; k < n; k++) counts[shapeOf(k)]++
      const make = (g, count, name) => {
        const mesh = new InstancedMesh(g, this.material, Math.max(count, 1))
        mesh.count = 0
        mesh.name = `trees ${key} ${name}`
        return mesh
      }
      const crowns = CROWNS.map((g, shape) => make(g, counts[shape], shape ? 'conifers' : 'crowns'))
      const trunks = make(TRUNK, n, 'trunks')
      const meshes = [...crowns, trunks]
      for (let k = 0; k < n; k++) {
        const o = k * RECORD
        const seed = view.getUint8(o + 11)
        const conifer = shapeOf(k)
        const h = view.getUint8(o + 8) / 5
        const r = view.getUint8(o + 9) / 10
        const x = i * size + view.getInt16(o, true) / 10
        const y = view.getFloat32(o + 4, true)
        const z = j * size + view.getInt16(o + 2, true) / 10
        q.setFromAxisAngle(Y, (seed / 256) * Math.PI * 2)
        tint.setRGB(0.85 + (seed % 5) * 0.06, 0.9 + (seed % 3) * 0.07, 0.85 + (seed % 4) * 0.05)
        // Crown: a round tree's crown is about as tall as it is wide (but at
        // most half the tree); a conifer's cone takes most of its height.
        const crowns_ = crowns[conifer]
        let trunkTop
        if (conifer) {
          p.set(x, y + h * 0.18, z)
          s.set(r, h * 0.82, r)
          trunkTop = h * 0.3
        } else {
          const ry = Math.min(r * 0.95, h * 0.45)
          p.set(x, y + h - ry, z)
          s.set(r, ry, r)
          trunkTop = h - ry * 1.4
        }
        crowns_.setMatrixAt(crowns_.count, m.compose(p, q, s))
        crowns_.setColorAt(crowns_.count, tint)
        crowns_.count++
        // Trunk from just below the ground into the crown, thicker for bigger trees.
        const tr = Math.min(Math.max(0.05 + r * 0.045, 0.07), 0.35)
        p.set(x, y - 0.3, z)
        s.set(tr, Math.max(trunkTop, 0.8) + 0.3, tr)
        trunks.setMatrixAt(trunks.count, m.compose(p, q, s))
        trunks.setColorAt(trunks.count, tint)
        trunks.count++
      }
      for (const mesh of meshes) {
        if (!mesh.count) continue
        mesh.instanceMatrix.needsUpdate = true
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
        mesh.computeBoundingSphere()
        this.group.add(mesh)
        entry.meshes.push(mesh)
      }
      entry.count = n
      entry.state = 'ready'
      this.count += n
    } catch (err) {
      entry.state = 'failed'
      this.lastError = `trees ${key}: ${err.message}`
    } finally {
      this.loading--
    }
  }

  unload(key) {
    const entry = this.tiles.get(key)
    this.tiles.delete(key)
    for (const mesh of entry?.meshes ?? []) {
      this.group.remove(mesh)
      mesh.dispose()
    }
    if (entry?.state === 'ready') this.count -= entry.count
  }

  update(camPos, agl) {
    if (!this.index) return
    const size = this.index.tileSize
    const range = agl > MAX_AGL ? 0 : RANGE
    const wanted = []
    for (const [i, j] of this.index.tiles) {
      const d = Math.hypot((i + 0.5) * size - camPos.x, (j + 0.5) * size - camPos.z) - size * 0.7
      const key = `${i}_${j}`
      if (d < range && !this.tiles.has(key)) wanted.push([d, key])
      else if (d > range + 400 && this.tiles.has(key) && this.tiles.get(key).state !== 'loading') this.unload(key)
    }
    wanted.sort((a, b) => a[0] - b[0])
    for (const [, key] of wanted) {
      if (this.loading >= 3) break
      this.load(key)
    }
  }
}
