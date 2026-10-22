// Loads Overture building tiles near the camera and meshes them in a worker.

import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'
import { receiveShadows } from './shadows.js'

const BASE = import.meta.env.BASE_URL

// Windows, shopfronts and doors drawn from the worker's facade attribute
// [u along wall (m), height above ground (m), wall length (m), style].
const FACADE_VERTEX = /* glsl */ `
attribute vec4 facade;
varying vec4 vFacade;
`
const FACADE_FRAGMENT = /* glsl */ `
{
  float st = vFacade.w;
  if (st > -0.5) {
    bool doorWall = st > 9.5;
    float style = doorWall ? st - 10.0 : st;
    float u = vFacade.x;
    float v = vFacade.y;
    float wallLen = vFacade.z;
    vec2 fw = fwidth(vFacade.xy);
    float blur = max(fw.x, fw.y);
    float detail = 1.0 - smoothstep(0.12, 0.5, blur);
    bool house = style < 0.5;
    bool shop = style > 0.5 && style < 1.5;
    float floorH = house ? 2.9 : (shop ? 3.8 : 3.2);
    float spacing = house ? 3.4 : (shop ? 3.2 : 3.0);
    float winW = house ? 1.2 : (shop ? 1.6 : 1.4);
    float winH = house ? 1.25 : 1.6;
    float sill = house ? 0.95 : 0.9;
    float n = floor((wallLen - 1.2) / spacing);
    float glass = 0.0;
    float frame = 0.0;
    float door = 0.0;
    if (n >= 1.0 && v > 0.0) {
      float margin = (wallLen - n * spacing) * 0.5;
      float cu = (u - margin) / spacing;
      float cell = floor(cu);
      float x = (fract(cu) - 0.5) * spacing; // metres from the window's centre line
      float fl = floor(v / floorH);
      float fv = v - fl * floorH; // metres above this floor
      float valid = step(0.0, cell) * step(cell, n - 1.0);
      float wx = winW * 0.5 - abs(x);
      float wy = min(fv - sill, sill + winH - fv);
      if (shop && fl < 0.5) {
        wx = spacing * 0.5 - 0.15 - abs(x); // storefront glass
        wy = min(fv - 0.35, 3.1 - fv);
      }
      float e = max(blur, 0.015);
      float outer = valid * smoothstep(-e, e, wx) * smoothstep(-e, e, wy);
      float inner = valid * smoothstep(-e, e, wx - 0.08) * smoothstep(-e, e, wy - 0.08);
      if (doorWall && house && fl < 0.5 && cell == floor(n * 0.5)) {
        door = valid * smoothstep(-e, e, 0.5 - abs(x)) * smoothstep(-e, e, 2.1 - fv) * step(0.0, fv);
        outer *= 1.0 - door;
        inner *= 1.0 - door;
      }
      glass = inner;
      frame = outer - inner;
    }
    vec3 wall = diffuseColor.rgb;
    float sky = clamp(fract(v / floorH) * 1.4, 0.0, 1.0);
    vec3 glassC = mix(vec3(0.025, 0.035, 0.05), vec3(0.08, 0.11, 0.14), sky);
    vec3 c = wall;
    c = mix(c, vec3(0.72, 0.7, 0.67), frame * detail);
    c = mix(c, glassC, glass * detail);
    c = mix(c, vec3(0.15, 0.085, 0.045), door * detail);
    // From afar the windows average into a slightly darker wall.
    c = mix(c, wall * 0.82, (1.0 - detail) * step(1.0, n));
    // Darker plinth along the ground.
    c *= mix(0.72, 1.0, smoothstep(-0.1, 0.4, v));
    diffuseColor.rgb = c;
  }
}
`

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

function nearestOnRing(r, x, z) {
  let best = [0, 0, Infinity]
  for (let k = 0, n = r.length; k < n; k += 2) {
    const ax = r[k], az = r[k + 1], bx = r[(k + 2) % n], bz = r[(k + 3) % n]
    const dx = bx - ax, dz = bz - az
    const len2 = dx * dx + dz * dz
    const t = len2 ? Math.min(Math.max(((x - ax) * dx + (z - az) * dz) / len2, 0), 1) : 0
    const px = ax + t * dx, pz = az + t * dz
    const d = Math.hypot(x - px, z - pz)
    if (d < best[2]) best = [px, pz, d]
  }
  return best
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
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = FACADE_VERTEX + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFacade = facade;')
      shader.fragmentShader = 'varying vec4 vFacade;\n' + shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n' + FACADE_FRAGMENT)
    }
    receiveShadows(this.material)
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
      geometry.setAttribute('facade', new BufferAttribute(out.facades, 4))
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

  // Moves the circle (x, z, r) out of any building footprint it overlaps.
  collide(x, z, r) {
    for (let pass = 0; pass < 2; pass++) {
      let moved = false
      for (const entry of this.tiles.values()) {
        const f = entry.footprints
        if (!f || f.maxX < x - r || f.minX > x + r || f.maxZ < z - r || f.minZ > z + r) continue
        for (const b of f.list) {
          if (b.maxX < x - r || b.minX > x + r || b.maxZ < z - r || b.minZ > z + r) continue
          const [ex, ez, d] = nearestOnRing(b.ring, x, z)
          const inside = insideRing(b.ring, x, z)
          if (!inside && d >= r) continue
          // Push out along the line to the nearest wall point.
          const nx = d > 1e-6 ? (x - ex) / d : 1
          const nz = d > 1e-6 ? (z - ez) / d : 0
          const s = inside ? -1 : 1
          x = ex + nx * s * r
          z = ez + nz * s * r
          moved = true
        }
      }
      if (!moved) break
    }
    return [x, z]
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
