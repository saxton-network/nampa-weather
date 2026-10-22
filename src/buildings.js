// Loads Overture building tiles near the camera and meshes them in a worker.

import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'

const BASE = import.meta.env.BASE_URL

// World-space footprint rings (flat [x, z, ...]) with bounding boxes.
function footprints(tile) {
  const ox = tile.i * tile.size
  const oz = tile.j * tile.size
  const all = { list: [], minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
  for (const rec of tile.b) {
    const src = rec[6]
    const ring = new Float32Array(src.length)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (let k = 0; k < src.length; k += 2) {
      const x = (ring[k] = ox + src[k] / 10)
      const z = (ring[k + 1] = oz + src[k + 1] / 10)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    all.list.push({ ring, minX, maxX, minZ, maxZ })
    all.minX = Math.min(all.minX, minX)
    all.maxX = Math.max(all.maxX, maxX)
    all.minZ = Math.min(all.minZ, minZ)
    all.maxZ = Math.max(all.maxZ, maxZ)
  }
  return all
}

function crossesRing(r, ax, az, bx, bz) {
  const n = r.length
  for (let k = 0; k < n; k += 2) {
    const cx = r[k], cz = r[k + 1]
    const dx = r[(k + 2) % n], dz = r[(k + 3) % n]
    const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
    const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax)
    if (d1 > 0 === d2 > 0) continue
    const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx)
    const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx)
    if (d3 > 0 !== d4 > 0) return true
  }
  return false
}

function insideRing(r, x, z) {
  let inside = false
  for (let k = 0, n = r.length; k < n; k += 2) {
    const xi = r[k], zi = r[k + 1], xj = r[(k + 2) % n], zj = r[(k + 3) % n]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

export class Buildings {
  constructor({ maxConcurrent = 4 } = {}) {
    this.group = new Group()
    this.group.name = 'buildings'
    this.material = new MeshBasicMaterial({ vertexColors: true })
    this.tiles = new Map() // "i_j" -> { state, mesh, count }
    this.index = null
    this.maxConcurrent = maxConcurrent
    this.loading = 0
    this.buildingCount = 0
    this.lastError = null
    this.pending = new Map()
    this.nextId = 1
    this.worker = new Worker(new URL('./buildings.worker.js', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e) => {
      const done = this.pending.get(e.data.id)
      this.pending.delete(e.data.id)
      done?.(e.data)
    }
    this.ready = fetch(`${BASE}data/buildings/index.json`)
      .then((r) => r.json())
      .then((index) => {
        this.index = index
        this.attribution = index.attribution
      })
      .catch((err) => {
        this.lastError = `index: ${err.message}`
      })
  }

  get stats() {
    let loaded = 0
    for (const t of this.tiles.values()) if (t.state === 'ready') loaded++
    return { tiles: loaded, loading: this.loading, buildings: this.buildingCount }
  }

  build(tile) {
    return new Promise((resolve) => {
      const id = this.nextId++
      this.pending.set(id, resolve)
      this.worker.postMessage({ id, tile })
    })
  }

  async load(key) {
    const entry = { state: 'loading', mesh: null, count: 0 }
    this.tiles.set(key, entry)
    this.loading++
    try {
      const tile = await fetch(`${BASE}data/buildings/${key}.json`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      entry.footprints = footprints(tile)
      const out = await this.build(tile)
      if (out.error) throw new Error(out.error)
      if (this.tiles.get(key) !== entry) return
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(out.positions, 3))
      geometry.setAttribute('normal', new BufferAttribute(out.normals, 3))
      geometry.setAttribute('color', new BufferAttribute(out.colors, 3))
      geometry.computeBoundingSphere()
      const mesh = new Mesh(geometry, this.material)
      mesh.name = `buildings ${key}`
      mesh.position.set(tile.i * tile.size, 0, tile.j * tile.size)
      mesh.updateMatrix()
      mesh.matrixAutoUpdate = false
      this.group.add(mesh)
      entry.mesh = mesh
      entry.count = out.count
      entry.state = 'ready'
      this.buildingCount += out.count
    } catch (err) {
      entry.state = 'failed'
      this.lastError = `${key}: ${err.message}`
    } finally {
      this.loading--
    }
  }

  unload(key) {
    const entry = this.tiles.get(key)
    this.tiles.delete(key)
    if (entry?.mesh) {
      this.group.remove(entry.mesh)
      entry.mesh.geometry.dispose()
      this.buildingCount -= entry.count
    }
  }

  // True if the ground-plane segment (x0,z0)-(x1,z1) crosses a loaded building
  // footprint. Footprints containing the start point (x0,z0) are ignored.
  blocks(x0, z0, x1, z1) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1)
    const minZ = Math.min(z0, z1), maxZ = Math.max(z0, z1)
    for (const entry of this.tiles.values()) {
      const f = entry.footprints
      if (!f || f.maxX < minX || f.minX > maxX || f.maxZ < minZ || f.minZ > maxZ) continue
      for (const b of f.list) {
        if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue
        if (crossesRing(b.ring, x0, z0, x1, z1) && !insideRing(b.ring, x0, z0)) return true
      }
    }
    return false
  }

  // camera: local-frame position; agl: metres above ground.
  update(camPos, agl) {
    if (!this.index) return
    const size = this.index.tileSize
    const radius = Math.min(Math.max(2500 + agl * 3, 2500), 8000)
    const keep = radius + 1500
    const wanted = []
    for (const [i, j] of this.index.tiles) {
      const cx = (i + 0.5) * size
      const cz = (j + 0.5) * size
      const d = Math.hypot(cx - camPos.x, cz - camPos.z) - size * 0.7
      const key = `${i}_${j}`
      if (d < radius && !this.tiles.has(key)) wanted.push([d, key])
      else if (d > keep && this.tiles.has(key)) this.unload(key)
    }
    wanted.sort((a, b) => a[0] - b[0])
    for (const [, key] of wanted) {
      if (this.loading >= this.maxConcurrent) break
      this.load(key)
    }
  }
}
