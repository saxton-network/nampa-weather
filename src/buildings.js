// Loads Overture building tiles near the camera and meshes them in a worker.

import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'

const BASE = import.meta.env.BASE_URL

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
