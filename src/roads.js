// Road data shared by the street labels and the ground, and a rasterizer that
// paints roads into a per-terrain-tile texture.
//
// Texture channels (read by the ground shader in ground.js):
//   R  asphalt coverage
//   G  0.5 = sidewalk or path; inside asphalt, values above 0.5 are yellow paint
//   B  white paint
//   A  1 minus street-light glow (pools of light used at night)
// Markings stop short of segment ends so they don't run through intersections.

import { shortName } from './streets.js'

const BASE = import.meta.env.BASE_URL

// Index = kind id from data-prep/build_roads.py KINDS.
// w: asphalt width (m); walk: sidewalks; lines: centre/edge markings.
const KIND = [
  { name: 'motorway', w: 11.5, lines: 'motorway' },
  { name: 'trunk', w: 11.5, lines: 'motorway' },
  { name: 'primary', w: 14, walk: true, lines: 'double', lamps: 36 },
  { name: 'secondary', w: 12, walk: true, lines: 'double', lamps: 38 },
  { name: 'tertiary', w: 10, walk: true, lines: 'dashed', lamps: 42 },
  { name: 'residential', w: 8.5, walk: true, lamps: 55 },
  { name: 'unclassified', w: 7 },
  { name: 'living_street', w: 6, walk: true, lamps: 45 },
  { name: 'service', w: 5 },
  { name: 'driveway', w: 3.5 },
  { name: 'parking_aisle', w: 6.5 },
  { name: 'alley', w: 4.5 },
  { name: 'track', w: 3.5 },
  { name: 'pedestrian', w: 4, path: true },
  { name: 'path', w: 1.8, path: true }
]
const SIDEWALK = 2.4 // m of curb and sidewalk on each side
const TRIM = 9 // m of each segment end left unmarked

export class RoadTiles {
  constructor() {
    this.cache = new Map()
    this.ready = fetch(`${BASE}data/roads/index.json`)
      .then((r) => r.json())
      .then((index) => {
        this.index = index
        this.keys = new Set(index.tiles.map(([i, j]) => `${i}_${j}`))
      })
      .catch((err) => {
        this.lastError = `roads index: ${err.message}`
      })
  }

  get size() {
    return this.index?.tileSize ?? 1000
  }

  has(key) {
    return !!this.keys?.has(key)
  }

  get(key) {
    let p = this.cache.get(key)
    if (!p) {
      p = fetch(`${BASE}data/roads/${key}.json`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((t) => {
          t.short = t.names.map(shortName)
          return t
        })
      p.catch(() => this.cache.delete(key))
      this.cache.set(key, p)
      // Keep the cache bounded; tiles are small, so a generous cap is fine.
      if (this.cache.size > 160) this.cache.delete(this.cache.keys().next().value)
    }
    return p
  }

  // Keys of road tiles overlapping the local-frame box.
  keysIn(minX, maxX, minZ, maxZ) {
    const s = this.size
    const out = []
    for (let i = Math.floor(minX / s); i <= Math.floor(maxX / s); i++) {
      for (let j = Math.floor(minZ / s); j <= Math.floor(maxZ / s); j++) {
        const key = `${i}_${j}`
        if (this.has(key)) out.push(key)
      }
    }
    return out
  }
}

// Polyline in local metres from a segment record [name, rank, kind, x0, z0, ...].
function points(tile, seg) {
  const ox = tile.i * tile.size
  const oz = tile.j * tile.size
  const pts = []
  for (let k = 3; k < seg.length; k += 2) pts.push([ox + seg[k] / 10, oz + seg[k + 1] / 10])
  return pts
}

// The part of a polyline between distance a from the start and b from the end.
function trimmed(pts, a, b) {
  let total = 0
  for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
  if (total <= a + b) return null
  const out = []
  let run = 0
  for (let k = 1; k < pts.length; k++) {
    const [x0, z0] = pts[k - 1]
    const [x1, z1] = pts[k]
    const len = Math.hypot(x1 - x0, z1 - z0)
    const s0 = Math.max(a - run, 0)
    const s1 = Math.min(total - b - run, len)
    if (s1 > s0 && len > 0) {
      if (!out.length) out.push([x0 + ((x1 - x0) * s0) / len, z0 + ((z1 - z0) * s0) / len])
      out.push([x0 + ((x1 - x0) * s1) / len, z0 + ((z1 - z0) * s1) / len])
    }
    run += len
  }
  return out.length > 1 ? out : null
}

// Polyline shifted sideways by d metres (positive = right of travel).
function offset(pts, d) {
  return pts.map((p, k) => {
    const a = pts[Math.max(k - 1, 0)]
    const b = pts[Math.min(k + 1, pts.length - 1)]
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const len = Math.hypot(dx, dz) || 1
    return [p[0] - (dz / len) * d, p[1] + (dx / len) * d]
  })
}

function addPath(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1])
}

// Street lights along a road tile's segments: [x, z, side_x, side_z] in local
// metres (side = unit vector from the lamp toward the road). Generated from
// the segment geometry, so the ground glow and the lamp posts always agree.
export function lampsFor(tile) {
  if (tile.lamps) return tile.lamps
  const out = []
  for (const s of tile.segs) {
    const k = KIND[s[2]]
    if (!k?.lamps) continue
    const pts = points(tile, s)
    let run = 0
    let next = k.lamps / 2
    let n = 0
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1]
      const [x1, z1] = pts[i]
      const len = Math.hypot(x1 - x0, z1 - z0)
      if (len < 1e-3) continue
      const dx = (x1 - x0) / len
      const dz = (z1 - z0) / len
      while (next <= run + len) {
        const t = next - run
        const side = n++ % 2 ? 1 : -1
        const off = k.w / 2 + 1.0
        // Right-hand normal is (-dz, dx); lamps alternate sides of the road.
        out.push([x0 + dx * t - dz * off * side, z0 + dz * t + dx * off * side, dz * side, -dx * side])
        next += k.lamps
      }
      run += len
    }
  }
  tile.lamps = out
  return out
}

// Paints all roads from `tiles` onto ctx. `toCanvas` is the affine
// [a, b, c, d, e, f] mapping local (x, z) metres to canvas pixels;
// `markings` turns lane paint on (only worth it on close-up tiles).
export function drawRoads(ctx, size, toCanvas, tiles, markings, glow) {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  ctx.setTransform(...toCanvas)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  const segs = []
  for (const t of tiles) for (const s of t.segs) segs.push([KIND[s[2]] ?? KIND[6], points(t, s)])

  // Sidewalks and paths: one stroke per width so overlaps don't add up.
  const byWidth = (filter, width) => {
    const groups = new Map()
    for (const [k, pts] of segs) {
      if (!filter(k)) continue
      const w = width(k)
      if (!groups.has(w)) groups.set(w, [])
      groups.get(w).push(pts)
    }
    return groups
  }
  ctx.strokeStyle = 'rgb(0,128,0)'
  for (const [w, lines] of byWidth((k) => k.walk || k.path, (k) => (k.path ? k.w : k.w + 2 * SIDEWALK))) {
    ctx.lineWidth = w
    ctx.beginPath()
    for (const pts of lines) addPath(ctx, pts)
    ctx.stroke()
  }
  // Asphalt adds red on top, leaving the sidewalk green underneath.
  ctx.globalCompositeOperation = 'lighter'
  ctx.strokeStyle = 'rgb(255,0,0)'
  for (const [w, lines] of byWidth((k) => !k.path, (k) => k.w)) {
    ctx.lineWidth = w
    ctx.beginPath()
    for (const pts of lines) addPath(ctx, pts)
    ctx.stroke()
  }
  if (glow) {
    // Pools of light: cut alpha around each lamp (kept above 0.2 so the
    // colour channels survive the canvas's premultiplied storage).
    ctx.globalCompositeOperation = 'destination-out'
    for (const t of tiles) {
      for (const [x, z, sx, sz] of lampsFor(t)) {
        const cx = x + sx * 2.5
        const cz = z + sz * 2.5
        const g = ctx.createRadialGradient(cx, cz, 0, cx, cz, 9)
        g.addColorStop(0, 'rgba(0,0,0,0.7)')
        g.addColorStop(0.35, 'rgba(0,0,0,0.3)')
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = g
        ctx.fillRect(cx - 9, cz - 9, 18, 18)
      }
    }
    ctx.globalCompositeOperation = 'lighter'
  }
  if (!markings) return

  const yellow = []
  const white = []
  const dashedYellow = []
  const dashedWhite = []
  for (const [k, pts] of segs) {
    if (!k.lines) continue
    const core = trimmed(pts, TRIM, TRIM)
    if (!core) continue
    const edge = k.w / 2 - 0.45
    if (k.lines === 'double') {
      yellow.push(offset(core, -0.2), offset(core, 0.2))
      white.push(offset(core, -edge), offset(core, edge))
      if (k.w >= 13) dashedWhite.push(offset(core, -k.w / 4), offset(core, k.w / 4))
    } else if (k.lines === 'dashed') {
      dashedYellow.push(core)
    } else if (k.lines === 'motorway') {
      white.push(offset(core, -edge), offset(core, edge))
      dashedWhite.push(core)
    }
  }
  const paint = (lines, color, dash) => {
    if (!lines.length) return
    ctx.strokeStyle = color
    ctx.lineWidth = 0.14
    ctx.lineCap = 'butt'
    ctx.setLineDash(dash ?? [])
    ctx.beginPath()
    for (const pts of lines) addPath(ctx, pts)
    ctx.stroke()
  }
  paint(yellow, 'rgb(0,127,0)')
  paint(dashedYellow, 'rgb(0,127,0)', [3, 9])
  paint(white, 'rgb(0,0,255)')
  paint(dashedWhite, 'rgb(0,0,255)', [3, 9])
  ctx.setLineDash([])
}
