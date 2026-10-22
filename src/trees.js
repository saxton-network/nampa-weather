// Low-poly 3D trees seeded wherever the aerial photos show canopy
// (data-prep/build_landcover.py). One instanced mesh per 1 km tile per shape,
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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

const BASE = import.meta.env.BASE_URL
const RECORD = 10 // bytes: int16 x_dm, int16 z_dm, float32 base_y, uint8 height_dm/2, uint8 seed
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

// Unit-height shapes: trunk from just below ground up to the canopy.
const trunk = () => colored(new CylinderGeometry(0.035, 0.05, 0.42, 5).translate(0, 0.16, 0), 0x5b4532)
const SHAPES = [
  mergeGeometries([trunk(), colored(new IcosahedronGeometry(0.34, 0).scale(1, 0.88, 1).translate(0, 0.64, 0), 0x3d6b2c)]),
  mergeGeometries([trunk(), colored(new ConeGeometry(0.26, 0.78, 7).translate(0, 0.6, 0), 0x2e5227)])
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
    this.material = new MeshBasicMaterial({ vertexColors: true })
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
      const shapeOf = (seed) => (seed % 7 === 0 ? 1 : 0) // about one conifer in seven
      const counts = [0, 0]
      for (let k = 0; k < n; k++) counts[shapeOf(view.getUint8(k * RECORD + 9))]++
      const meshes = SHAPES.map((g, shape) => {
        const mesh = new InstancedMesh(g, this.material, Math.max(counts[shape], 1))
        mesh.count = 0
        mesh.name = `trees ${key} ${shape}`
        return mesh
      })
      for (let k = 0; k < n; k++) {
        const o = k * RECORD
        const seed = view.getUint8(o + 9)
        const mesh = meshes[shapeOf(seed)]
        const h = view.getUint8(o + 8) / 5
        const wide = 0.8 + ((seed * 37) % 100) / 250
        p.set(i * size + view.getInt16(o, true) / 10, view.getFloat32(o + 4, true), j * size + view.getInt16(o + 2, true) / 10)
        q.setFromAxisAngle(Y, (seed / 256) * Math.PI * 2)
        s.set(h * wide, h, h * wide)
        mesh.setMatrixAt(mesh.count, m.compose(p, q, s))
        tint.setRGB(0.85 + (seed % 5) * 0.06, 0.9 + (seed % 3) * 0.07, 0.85 + (seed % 4) * 0.05)
        mesh.setColorAt(mesh.count, tint)
        mesh.count++
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
