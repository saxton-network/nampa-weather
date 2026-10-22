// Streaming quadtree terrain: Web Mercator tiles meshed in the local frame.
//
// Elevation comes from AWS Terrain Tiles (terrarium PNG, USGS 3DEP in the US)
// up to z15; deeper tiles resample their z15 ancestor. Imagery tiles go to
// the provider's max zoom. A tile replaces its parent only once all of its
// visible children have loaded, so the ground never has holes while refining.

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Frustum,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Sphere,
  Texture,
  Vector3
} from 'three'
import {
  geodeticToLocal,
  latToTileY,
  lonToTileX,
  tileXToLon,
  tileYToLat
} from './geo.js'
import region from './region.json'

const SEG = 32
const GRID = SEG + 1
const ELEVATION_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

export const IMAGERY_PROVIDERS = {
  esri: {
    name: 'Esri World Imagery',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 19,
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  },
  usgs: {
    name: 'USGS National Map (NAIP)',
    url: (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 16,
    credit: 'Imagery: USGS The National Map, USDA NAIP (public domain)'
  }
}

export const TERRAIN_CREDIT = 'Terrain: AWS Terrain Tiles (USGS 3DEP, Mapzen)'

// Grid indices plus two-sided skirts along all four edges.
const INDEX = (() => {
  const idx = []
  for (let j = 0; j < SEG; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * GRID + i
      const b = a + GRID
      const c = a + 1
      const d = b + 1
      idx.push(a, b, c, c, b, d)
    }
  }
  const edges = [
    Array.from({ length: GRID }, (_, i) => i),
    Array.from({ length: GRID }, (_, i) => SEG * GRID + i),
    Array.from({ length: GRID }, (_, j) => j * GRID),
    Array.from({ length: GRID }, (_, j) => j * GRID + SEG)
  ]
  let s = GRID * GRID
  for (const edge of edges) {
    for (let k = 0; k < SEG; k++) {
      const a = edge[k]
      const b = edge[k + 1]
      const sa = s + k
      const sb = s + k + 1
      idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa)
    }
    s += GRID
  }
  return idx
})()
const SKIRT_SOURCE = [
  ...Array.from({ length: GRID }, (_, i) => i),
  ...Array.from({ length: GRID }, (_, i) => SEG * GRID + i),
  ...Array.from({ length: GRID }, (_, j) => j * GRID),
  ...Array.from({ length: GRID }, (_, j) => j * GRID + SEG)
]
const VERTEX_COUNT = GRID * GRID + SKIRT_SOURCE.length

class LRU {
  constructor(max) {
    this.max = max
    this.map = new Map()
  }

  get(key) {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }

  set(key, v) {
    this.map.set(key, v)
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
  }
}

let decodeCanvas = null

async function fetchBitmap(url, signal) {
  const res = await fetch(url, { mode: 'cors', signal })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  const blob = await res.blob()
  return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

async function fetchElevation(z, x, y) {
  const bitmap = await fetchBitmap(ELEVATION_URL(z, x, y))
  decodeCanvas ??= new OffscreenCanvas(256, 256)
  const ctx = decodeCanvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const px = ctx.getImageData(0, 0, 256, 256, { colorSpace: 'srgb' }).data
  const out = new Float32Array(256 * 256)
  for (let i = 0; i < out.length; i++) {
    out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768
  }
  return out
}

function sampleBilinear(data, px, py) {
  px = Math.min(Math.max(px, 0), 255)
  py = Math.min(Math.max(py, 0), 255)
  const ix = Math.min(Math.floor(px), 254)
  const iy = Math.min(Math.floor(py), 254)
  const fx = px - ix
  const fy = py - iy
  const i = iy * 256 + ix
  const top = data[i] * (1 - fx) + data[i + 1] * fx
  const bot = data[i + 256] * (1 - fx) + data[i + 257] * fx
  return top * (1 - fy) + bot * fy
}

class Tile {
  constructor(z, x, y, parent) {
    this.z = z
    this.x = x
    this.y = y
    this.parent = parent
    this.children = null
    this.state = 'new'
    this.mesh = null
    this.heights = null
    this.lastVisited = 0
    this.noSplit = false
    this.west = tileXToLon(x, z)
    this.east = tileXToLon(x + 1, z)
    this.north = tileYToLat(y, z)
    this.south = tileYToLat(y + 1, z)
    const range = parent?.heightRange ?? [-100, 4500]
    this.setBounds(range[0], range[1])
  }

  get ready() {
    return this.state === 'ready'
  }

  setBounds(minH, maxH) {
    this.heightRange = [minH, maxH]
    const pts = []
    for (const lat of [this.north, (this.north + this.south) / 2, this.south]) {
      for (const lon of [this.west, (this.west + this.east) / 2, this.east]) {
        pts.push(geodeticToLocal(lat, lon, minH), geodeticToLocal(lat, lon, maxH))
      }
    }
    this.sphere = new Sphere().setFromPoints(pts)
    this.widthMeters = pts[0].distanceTo(pts[4])
  }

  contains(lat, lon) {
    return lon >= this.west && lon <= this.east && lat <= this.north && lat >= this.south
  }

  ensureChildren() {
    if (this.children) return this.children
    const z = this.z + 1
    const x = this.x * 2
    const y = this.y * 2
    this.children = [
      new Tile(z, x, y, this),
      new Tile(z, x + 1, y, this),
      new Tile(z, x, y + 1, this),
      new Tile(z, x + 1, y + 1, this)
    ]
    return this.children
  }

  // Geodetic height of the rendered surface at (lat, lon), from the mesh grid.
  heightAt(lat, lon) {
    const u = (lonToTileX(lon, this.z) - this.x) * SEG
    const v = (latToTileY(lat, this.z) - this.y) * SEG
    const i = Math.min(Math.max(Math.floor(u), 0), SEG - 1)
    const j = Math.min(Math.max(Math.floor(v), 0), SEG - 1)
    const fu = Math.min(Math.max(u - i, 0), 1)
    const fv = Math.min(Math.max(v - j, 0), 1)
    const h = this.heights
    const a = h[j * GRID + i]
    const b = h[j * GRID + i + 1]
    const c = h[(j + 1) * GRID + i]
    const d = h[(j + 1) * GRID + i + 1]
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv
  }
}

export class Terrain {
  constructor(renderer, { provider = 'esri', sseThreshold = 1.0, maxTiles = 700, maxConcurrent = 8 } = {}) {
    this.renderer = renderer
    this.group = new Group()
    this.group.name = 'terrain'
    this.provider = IMAGERY_PROVIDERS[provider] ?? IMAGERY_PROVIDERS.esri
    this.maxImageryZoom = Math.min(region.terrain.maxImageryZoom, this.provider.maxZoom)
    this.maxElevationZoom = region.terrain.maxElevationZoom
    this.sseThreshold = sseThreshold
    this.maxTiles = maxTiles
    this.maxConcurrent = maxConcurrent
    this.anisotropy = renderer.capabilities.getMaxAnisotropy()
    this.elevationCache = new LRU(400)
    this.frame = 0
    this.loading = 0
    this.loadedCount = 0
    this.failedCount = 0
    this.lastError = null
    this.needed = new Set()
    this.frustum = new Frustum()
    this.projScreen = new Matrix4()
    this.camPos = new Vector3()

    const { rootZoom, rootRadiusTiles: r } = region.terrain
    const cx = Math.floor(lonToTileX(region.origin.lon, rootZoom))
    const cy = Math.floor(latToTileY(region.origin.lat, rootZoom))
    this.roots = []
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) this.roots.push(new Tile(rootZoom, x, y, null))
    }
  }

  get stats() {
    let visible = 0
    for (const m of this.group.children) if (m.visible) visible++
    return { loaded: this.loadedCount, visible, loading: this.loading, queued: this.needed.size, failed: this.failedCount }
  }

  elevationTile(z, x, y) {
    const key = `${z}/${x}/${y}`
    let p = this.elevationCache.get(key)
    if (!p) {
      p = fetchElevation(z, x, y)
      p.catch(() => this.elevationCache.map.delete(key))
      this.elevationCache.set(key, p)
    }
    return p
  }

  async load(tile) {
    tile.state = 'loading'
    this.loading++
    try {
      const ez = Math.min(tile.z, this.maxElevationZoom)
      const shift = tile.z - ez
      const ex = tile.x >> shift
      const ey = tile.y >> shift
      const [elev, bitmap] = await Promise.all([
        this.elevationTile(ez, ex, ey),
        fetchBitmap(this.provider.url(tile.z, tile.x, tile.y))
      ])
      if (tile.state !== 'loading') {
        bitmap.close()
        return
      }
      this.buildMesh(tile, elev, ez, ex, ey, bitmap)
      tile.state = 'ready'
      this.loadedCount++
    } catch (err) {
      tile.state = 'failed'
      this.failedCount++
      this.lastError = String(err.message ?? err)
      if (tile.parent) tile.parent.noSplit = true
    } finally {
      this.loading--
    }
  }

  buildMesh(tile, elev, ez, ex, ey, bitmap) {
    const scale = 2 ** (tile.z - ez)
    const heights = new Float32Array(GRID * GRID)
    const pos = new Float32Array(VERTEX_COUNT * 3)
    const uv = new Float32Array(VERTEX_COUNT * 2)
    const v3 = new Vector3()
    let minH = Infinity
    let maxH = -Infinity
    for (let j = 0; j < GRID; j++) {
      const ty = tile.y + j / SEG
      const lat = tileYToLat(ty, tile.z)
      const py = (ty / scale - ey) * 256 - 0.5
      for (let i = 0; i < GRID; i++) {
        const tx = tile.x + i / SEG
        const lon = tileXToLon(tx, tile.z)
        const px = (tx / scale - ex) * 256 - 0.5
        const h = sampleBilinear(elev, px, py)
        const k = j * GRID + i
        heights[k] = h
        if (h < minH) minH = h
        if (h > maxH) maxH = h
        geodeticToLocal(lat, lon, h, v3).toArray(pos, k * 3)
        uv[k * 2] = i / SEG
        uv[k * 2 + 1] = j / SEG
      }
    }
    // Skirts drop straight down by a depth proportional to the tile size.
    const skirt = Math.max(tile.widthMeters / SEG, 2)
    for (let s = 0; s < SKIRT_SOURCE.length; s++) {
      const src = SKIRT_SOURCE[s]
      const k = GRID * GRID + s
      pos[k * 3] = pos[src * 3]
      pos[k * 3 + 1] = pos[src * 3 + 1] - skirt
      pos[k * 3 + 2] = pos[src * 3 + 2]
      uv[k * 2] = uv[src * 2]
      uv[k * 2 + 1] = uv[src * 2 + 1]
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(pos, 3))
    geometry.setAttribute('uv', new BufferAttribute(uv, 2))
    geometry.setIndex(INDEX)
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()

    const texture = new Texture(bitmap)
    texture.flipY = false
    texture.colorSpace = SRGBColorSpace
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping
    texture.minFilter = LinearMipmapLinearFilter
    texture.magFilter = LinearFilter
    texture.anisotropy = this.anisotropy
    texture.needsUpdate = true

    const mesh = new Mesh(geometry, new MeshBasicMaterial({ map: texture }))
    mesh.name = `tile ${tile.z}/${tile.x}/${tile.y}`
    mesh.visible = false
    mesh.matrixAutoUpdate = false
    tile.mesh = mesh
    tile.heights = heights
    tile.setBounds(minH, maxH)
    this.group.add(mesh)
  }

  disposeTile(tile) {
    if (tile.children) for (const c of tile.children) this.disposeTile(c)
    tile.children = null
    if (tile.mesh) {
      this.group.remove(tile.mesh)
      tile.mesh.geometry.dispose()
      tile.mesh.material.map.source.data?.close?.()
      tile.mesh.material.map.dispose()
      tile.mesh.material.dispose()
      tile.mesh = null
      this.loadedCount--
    }
    tile.heights = null
    tile.state = 'new'
  }

  hide(tile) {
    if (tile.mesh) tile.mesh.visible = false
    if (tile.children) for (const c of tile.children) this.hide(c)
  }

  wantsSplit(tile) {
    if (tile.z >= this.maxImageryZoom || tile.noSplit) return false
    const d = Math.max(this.camPos.distanceTo(tile.sphere.center) - tile.sphere.radius, 1)
    const texel = tile.widthMeters / 256
    return (texel * this.screenScale) / d > this.sseThreshold
  }

  visit(tile) {
    tile.lastVisited = this.frame
    if (!this.frustum.intersectsSphere(tile.sphere)) {
      this.hide(tile)
      return
    }
    if (this.wantsSplit(tile)) {
      const children = tile.ensureChildren()
      let ready = true
      for (const c of children) {
        c.lastVisited = this.frame
        if (c.state === 'failed') {
          tile.noSplit = true
          ready = false
        } else if (!c.ready) {
          if (c.state === 'new') this.needed.add(c)
          if (this.frustum.intersectsSphere(c.sphere)) ready = false
        }
      }
      if (ready) {
        tile.mesh.visible = false
        for (const c of children) {
          if (c.ready) this.visit(c)
        }
        return
      }
    }
    tile.mesh.visible = true
    if (tile.children) for (const c of tile.children) this.hide(c)
  }

  update(camera) {
    this.frame++
    camera.updateMatrixWorld()
    this.camPos.setFromMatrixPosition(camera.matrixWorld)
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projScreen)
    const height = this.renderer.domElement.height
    this.screenScale = height / (2 * Math.tan((camera.fov * Math.PI) / 360))
    this.needed.clear()

    for (const root of this.roots) {
      if (root.ready) this.visit(root)
      else if (root.state === 'new') this.needed.add(root)
    }

    if (this.loading < this.maxConcurrent && this.needed.size) {
      const queue = [...this.needed].sort(
        (a, b) => a.z - b.z || this.camPos.distanceTo(a.sphere.center) - this.camPos.distanceTo(b.sphere.center)
      )
      for (const t of queue) {
        if (this.loading >= this.maxConcurrent) break
        this.load(t)
      }
    }

    if (this.frame % 60 === 0) this.prune()
  }

  prune() {
    const all = []
    const walk = (t) => {
      if (t.children) for (const c of t.children) walk(c)
      if (t.parent && t.mesh) all.push(t)
    }
    for (const r of this.roots) walk(r)
    const stale = this.frame - 600
    all.sort((a, b) => a.lastVisited - b.lastVisited)
    let excess = this.loadedCount - this.maxTiles
    for (const t of all) {
      // Tiles visited this frame are rendered or are ancestors of rendered tiles.
      if (t.lastVisited >= this.frame - 1) continue
      if (t.lastVisited < stale || excess > 0) {
        excess--
        this.disposeTile(t)
        if (t.parent?.children?.every((c) => c.state === 'new')) t.parent.children = null
      }
    }
  }

  // Geodetic height of the rendered ground, or null if nothing has loaded there.
  heightAt(lat, lon) {
    return this.groundAt(lat, lon)?.height ?? null
  }

  // { height, zoom } from the most detailed loaded tile at (lat, lon), or null.
  groundAt(lat, lon) {
    let tile = this.roots.find((r) => r.ready && r.contains(lat, lon))
    if (!tile) return null
    for (;;) {
      const next = tile.children?.find((c) => c.ready && c.contains(lat, lon))
      if (!next) break
      tile = next
    }
    return { height: tile.heightAt(lat, lon), zoom: tile.z }
  }
}
