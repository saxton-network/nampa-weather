// Builds one building tile's mesh off the main thread.
//
// Input records come from data-prep/build_buildings.py:
//   [baseY, height, minHeight, kind, roof, heightEstimated, ringDecimeters, facadeColor?, roofColor?]
// The ring is counter-clockwise in (x, -z), in decimetres from the tile origin.
// Output is non-indexed geometry with flat normals and linear vertex colours
// (albedo for the atmosphere's post-process lighting).

import { ShapeUtils, Vector2 } from 'three'

const KIND_RESIDENTIAL = 1
const KIND_COMMERCIAL = 2
const ROOF_FLAT = 0
const ROOF_GABLED = 1
const ROOF_HIPPED = 2
const ROOF_PYRAMIDAL = 3
const FOUNDATION = 2 // walls extend below ground to hide terrain mismatch
const PITCH = Math.tan((24 * Math.PI) / 180)

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const hexToLinear = (hex) => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255)
]

const PALETTE = {
  wallResidential: [0xd9cfbf, 0xcfc6b8, 0xe3ddd2, 0xbfb6a4, 0xa9a49a, 0xc9bda5, 0xb7c0c4, 0xd8d3c8, 0x9e8f7d, 0xe8e2d6],
  wallCommercial: [0xbdb8ae, 0xa7a49d, 0xc8c1b3, 0x9a968e, 0xd2cdc2, 0xb3a58f],
  wallOther: [0xc2b49c, 0xb9b1a3, 0xa79c8a, 0xcfc8ba],
  roofPitched: [0x4a4744, 0x5b534b, 0x3c3a39, 0x6b5a4c, 0x55504d, 0x704f43, 0x4e4f52],
  roofFlat: [0x9c9a96, 0xb8b6b1, 0x8a8783, 0xc9c7c2, 0x76736e]
}
const LINEAR = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, v.map(hexToLinear)]))

function hash(a, b) {
  let h = (a * 374761393 + b * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

const pick = (list, h) => list[h % list.length]

class Builder {
  constructor() {
    this.pos = []
    this.nor = []
    this.col = []
  }

  // Adds a triangle, flipping its winding so the normal faces `want`.
  tri(a, b, c, color, want) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-9) return
    nx /= len
    ny /= len
    nz /= len
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
      ;[b, c] = [c, b]
      nx = -nx
      ny = -ny
      nz = -nz
    }
    this.pos.push(...a, ...b, ...c)
    for (let i = 0; i < 3; i++) {
      this.nor.push(nx, ny, nz)
      this.col.push(color[0], color[1], color[2])
    }
  }

  quad(a, b, c, d, color, want) {
    this.tri(a, b, c, color, want)
    this.tri(a, c, d, color, want)
  }
}

// Minimum-area bounding rectangle over the ring's edge directions.
function orientedBox(xs, zs) {
  const n = xs.length
  let best = null
  for (let k = 0; k < n; k++) {
    const dx = xs[(k + 1) % n] - xs[k]
    const dz = zs[(k + 1) % n] - zs[k]
    const len = Math.hypot(dx, dz)
    if (len < 0.5) continue
    const ux = dx / len
    const uz = dz / len
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (let i = 0; i < n; i++) {
      const pu = xs[i] * ux + zs[i] * uz
      const pv = -xs[i] * uz + zs[i] * ux
      if (pu < minU) minU = pu
      if (pu > maxU) maxU = pu
      if (pv < minV) minV = pv
      if (pv > maxV) maxV = pv
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area < best.area) best = { area, ux, uz, minU, maxU, minV, maxV }
  }
  if (!best) return null
  let { ux, uz, minU, maxU, minV, maxV } = best
  // Make u the long axis.
  if (maxV - minV > maxU - minU) {
    ;[ux, uz] = [-uz, ux]
    ;[minU, maxU, minV, maxV] = [minV, maxV, -maxU, -minU]
  }
  const cu = (minU + maxU) / 2
  const cv = (minV + maxV) / 2
  return {
    area: best.area,
    ux,
    uz,
    vx: -uz,
    vz: ux,
    cx: cu * ux - cv * uz,
    cz: cu * uz + cv * ux,
    halfL: (maxU - minU) / 2,
    halfW: (maxV - minV) / 2
  }
}

function polygonArea(xs, zs) {
  let a = 0
  for (let i = 0, n = xs.length; i < n; i++) {
    const j = (i + 1) % n
    a += xs[i] * -zs[j] - xs[j] * -zs[i]
  }
  return a / 2
}

function addPitchedRoof(b, box, eaveY, ridgeY, type, roofColor, wallColor) {
  const { ux, uz, vx, vz, cx, cz } = box
  const over = 0.35
  const L = box.halfL + over
  const W = box.halfW + over
  const eave = eaveY - over * PITCH
  const at = (u, v, y) => [cx + ux * u + vx * v, y, cz + uz * u + vz * v]
  const up = [0, 1, 0]
  const c00 = at(-L, -W, eave), c10 = at(L, -W, eave), c11 = at(L, W, eave), c01 = at(-L, W, eave)
  if (type === ROOF_GABLED) {
    const r0 = at(-L, 0, ridgeY), r1 = at(L, 0, ridgeY)
    b.quad(c00, c10, r1, r0, roofColor, up)
    b.quad(c01, c11, r1, r0, roofColor, up)
    // Gable ends are wall-coloured triangles over the footprint's short sides.
    const g0 = at(-box.halfL, -box.halfW, eaveY), g1 = at(-box.halfL, box.halfW, eaveY), gr0 = at(-box.halfL, 0, ridgeY)
    const h0 = at(box.halfL, -box.halfW, eaveY), h1 = at(box.halfL, box.halfW, eaveY), hr0 = at(box.halfL, 0, ridgeY)
    b.tri(g0, g1, gr0, wallColor, [-ux, 0, -uz])
    b.tri(h0, h1, hr0, wallColor, [ux, 0, uz])
  } else {
    const ridgeHalf = type === ROOF_PYRAMIDAL ? 0 : Math.max(L - W, 0)
    const r0 = at(-ridgeHalf, 0, ridgeY), r1 = at(ridgeHalf, 0, ridgeY)
    b.quad(c00, c10, r1, r0, roofColor, up)
    b.quad(c01, c11, r1, r0, roofColor, up)
    b.tri(c00, c01, r0, roofColor, up)
    b.tri(c10, c11, r1, roofColor, up)
  }
}

function buildTile(tile) {
  const b = new Builder()
  for (const rec of tile.b) {
    const [baseY, height, minHeight, kind, roofHint, , ring, facadeHex, roofHex] = rec
    const n = ring.length / 2
    if (n < 3) continue
    const xs = new Float64Array(n)
    const zs = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      xs[i] = ring[i * 2] / 10
      zs[i] = ring[i * 2 + 1] / 10
    }
    const h = hash(ring[0], ring[1])
    const area = Math.abs(polygonArea(xs, zs))

    const wallColor = facadeHex != null
      ? hexToLinear(facadeHex)
      : pick(kind === KIND_RESIDENTIAL ? LINEAR.wallResidential : kind === KIND_COMMERCIAL ? LINEAR.wallCommercial : LINEAR.wallOther, h)

    let roof = roofHint
    let box = null
    if (roof !== ROOF_FLAT) {
      box = orientedBox(xs, zs)
      const rect = box ? area / box.area : 0
      const smallUnknown = kind === 0 && area < 400 && height < 10
      if (roof < 0) {
        roof = (kind === KIND_RESIDENTIAL || smallUnknown) && rect > 0.75 && area < 900 && box.halfW > 1.5
          ? (h % 5 < 3 ? ROOF_GABLED : ROOF_HIPPED)
          : ROOF_FLAT
      } else if (!box || rect < 0.6) {
        roof = ROOF_FLAT
      }
    }
    const pitched = roof === ROOF_GABLED || roof === ROOF_HIPPED || roof === ROOF_PYRAMIDAL
    const roofColor = roofHex != null
      ? hexToLinear(roofHex)
      : pick(pitched ? LINEAR.roofPitched : LINEAR.roofFlat, h >>> 3)

    const bottom = minHeight > 0 ? baseY + minHeight : baseY - FOUNDATION
    let top = baseY + Math.max(height, 2.5)
    let eave = top
    if (pitched) {
      const roofH = Math.min(Math.max(box.halfW * PITCH, 0.8), 4.5)
      eave = Math.max(top - roofH, baseY + 2.5)
      top = eave + roofH
    }

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const out = [-(zs[j] - zs[i]), 0, xs[j] - xs[i]]
      b.quad([xs[i], bottom, zs[i]], [xs[j], bottom, zs[j]], [xs[j], eave, zs[j]], [xs[i], eave, zs[i]], wallColor, out)
    }

    if (pitched) {
      addPitchedRoof(b, box, eave, top, roof, roofColor, wallColor)
    } else {
      const contour = []
      for (let i = 0; i < n; i++) contour.push(new Vector2(xs[i], -zs[i]))
      for (const [p, q, r] of ShapeUtils.triangulateShape(contour, [])) {
        b.tri([xs[p], top, zs[p]], [xs[q], top, zs[q]], [xs[r], top, zs[r]], roofColor, [0, 1, 0])
      }
    }
  }
  return {
    positions: new Float32Array(b.pos),
    normals: new Float32Array(b.nor),
    colors: new Float32Array(b.col)
  }
}

self.onmessage = (e) => {
  const { id, tile } = e.data
  try {
    const out = buildTile(tile)
    self.postMessage({ id, ...out, count: tile.b.length }, [out.positions.buffer, out.normals.buffer, out.colors.buffer])
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) })
  }
}
