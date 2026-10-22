// Builds one building tile's mesh off the main thread.
//
// Input records come from data-prep/build_buildings.py:
//   [baseY, height, minHeight, kind, roof, heightEstimated, ringDecimeters, facadeColor?, roofColor?, roofParts?]
// The ring is counter-clockwise in (x, -z), in decimetres from the tile origin.
// roofParts (buildings measured from lidar) holds 9 numbers per rectangle:
//   centre x, z (dm), ridge direction x, z (1/1000), half length along the
//   ridge, half width, ridge half length (dm; = half length for a gable),
//   eave and ridge height above the base (dm). Flat parts have ridge = eave.
// Output is non-indexed geometry with flat normals and linear vertex colours
// (albedo for the atmosphere's post-process lighting), plus a per-vertex
// facade attribute [u along the wall, height above ground, wall length, style]
// that the building shader (buildings.js) turns into windows and doors.
// Style: -1 none (roofs, gables, sheds), 0 house, 1 shopfront, 2 apartment/civic;
// +10 marks the wall that gets the front door.

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

const NO_FACADE = [0, 0, 0, -1]

class Builder {
  constructor() {
    this.pos = []
    this.nor = []
    this.col = []
    this.fac = []
  }

  // Adds a triangle, flipping its winding so the normal faces `want`.
  // fa/fb/fc are the facade attributes of the three corners.
  tri(a, b, c, color, want, fa = NO_FACADE, fb = NO_FACADE, fc = NO_FACADE) {
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
      ;[fb, fc] = [fc, fb]
      nx = -nx
      ny = -ny
      nz = -nz
    }
    this.pos.push(...a, ...b, ...c)
    this.fac.push(...fa, ...fb, ...fc)
    for (let i = 0; i < 3; i++) {
      this.nor.push(nx, ny, nz)
      this.col.push(color[0], color[1], color[2])
    }
  }

  quad(a, b, c, d, color, want, fa, fb, fc, fd) {
    this.tri(a, b, c, color, want, fa, fb, fc)
    this.tri(a, c, d, color, want, fa, fc, fd)
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

// Facade style from the building's type and size, and the wall that gets the
// front door (the longest).
function facadeStyle(kind, height, area, xs, zs) {
  const tall = height > 9
  let style = kind === KIND_RESIDENTIAL ? (tall ? 2 : 0) : kind === KIND_COMMERCIAL ? 1 : kind === 0 ? (area > 400 ? 1 : 0) : 2
  if (area < 35) style = -1
  let doorEdge = -1
  let longest = 0
  for (let i = 0, n = xs.length; i < n; i++) {
    const len = Math.hypot(xs[(i + 1) % n] - xs[i], zs[(i + 1) % n] - zs[i])
    if (len > longest) {
      longest = len
      doorEdge = i
    }
  }
  return { style, doorEdge }
}

// A building measured from lidar: walls up to the eave of the roof part they
// belong to, a flat cap at the lowest eave closing the footprint, and each
// part's own roof (with plain walls from the cap up to its eave where it
// stands taller).
function addMeasured(b, rec, xs, zs, area, parts, wallColor, h) {
  const [baseY, height, minHeight, kind, , , , , roofHex] = rec
  const n = xs.length
  const pitched = parts.some((p) => p.ridge - p.eave > 0.05)
  const roofColor = roofHex != null ? hexToLinear(roofHex) : pick(pitched ? LINEAR.roofPitched : LINEAR.roofFlat, h >>> 3)
  const cap = Math.min(...parts.map((p) => p.eave))
  const bottom = minHeight > 0 ? baseY + minHeight : baseY - FOUNDATION
  const { style, doorEdge } = facadeStyle(kind, height, area, xs, zs)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const mx = (xs[i] + xs[j]) / 2
    const mz = (zs[i] + zs[j]) / 2
    let top = Infinity
    for (const p of parts) if (partDistance(p, mx, mz) < 0.6) top = Math.min(top, p.eave)
    if (top === Infinity) top = cap
    const out = [-(zs[j] - zs[i]), 0, xs[j] - xs[i]]
    const len = Math.hypot(xs[j] - xs[i], zs[j] - zs[i])
    const st = style < 0 ? -1 : style + (i === doorEdge ? 10 : 0)
    const v0 = bottom - baseY
    b.quad(
      [xs[i], bottom, zs[i]], [xs[j], bottom, zs[j]], [xs[j], baseY + top, zs[j]], [xs[i], baseY + top, zs[i]], wallColor, out,
      [0, v0, len, st], [len, v0, len, st], [len, top, len, st], [0, top, len, st]
    )
  }
  const contour = []
  for (let i = 0; i < n; i++) contour.push(new Vector2(xs[i], -zs[i]))
  for (const [p, q, r] of ShapeUtils.triangulateShape(contour, [])) {
    b.tri([xs[p], baseY + cap, zs[p]], [xs[q], baseY + cap, zs[q]], [xs[r], baseY + cap, zs[r]], roofColor, [0, 1, 0])
  }
  for (const p of parts) {
    const vx = -p.az
    const vz = p.ax
    const L = p.L - 0.05
    const W = p.W - 0.05
    const at = (u, v, y) => [p.cx + p.ax * u + vx * v, y, p.cz + p.az * u + vz * v]
    if (p.eave > cap + 0.2) {
      // Plain walls from the cap up to this part's eave, set in slightly so
      // they hide behind the outer walls where the two coincide.
      const y0 = baseY + cap
      const y1 = baseY + p.eave
      const sides = [[-L, -W, L, -W, [vx * -1, 0, vz * -1]], [L, -W, L, W, [p.ax, 0, p.az]], [L, W, -L, W, [vx, 0, vz]], [-L, W, -L, -W, [-p.ax, 0, -p.az]]]
      for (const [u0, v0, u1, v1, nrm] of sides) b.quad(at(u0, v0, y0), at(u1, v1, y0), at(u1, v1, y1), at(u0, v0, y1), wallColor, nrm)
      if (p.ridge - p.eave <= 0.05) b.quad(at(-L, -W, y1), at(L, -W, y1), at(L, W, y1), at(-L, W, y1), roofColor, [0, 1, 0])
    }
    if (p.ridge - p.eave > 0.05) addPartRoof(b, p, baseY, roofColor, wallColor)
  }
}

// Roof over one lidar-measured rectangle: a gable when the ridge runs its
// full length, otherwise hipped ends.
function addPartRoof(b, p, baseY, roofColor, wallColor) {
  const { cx, cz, ax, az, L, W, half, eave, ridge } = p
  const vx = -az
  const vz = ax
  const at = (u, v, y) => [cx + ax * u + vx * v, y, cz + az * u + vz * v]
  const up = [0, 1, 0]
  const top = baseY + ridge
  const low = baseY + eave
  const over = 0.35
  const slope = (ridge - eave) / Math.max(W, 0.5)
  const e = low - over * slope
  const Wo = W + over
  if (half >= L - 0.01) {
    const Lo = L + over
    const c00 = at(-Lo, -Wo, e), c10 = at(Lo, -Wo, e), c11 = at(Lo, Wo, e), c01 = at(-Lo, Wo, e)
    const r0 = at(-Lo, 0, top), r1 = at(Lo, 0, top)
    b.quad(c00, c10, r1, r0, roofColor, up)
    b.quad(c01, c11, r1, r0, roofColor, up)
    b.tri(at(-L, -W, low), at(-L, W, low), at(-L, 0, top), wallColor, [-ax, 0, -az])
    b.tri(at(L, -W, low), at(L, W, low), at(L, 0, top), wallColor, [ax, 0, az])
  } else {
    const Lo = L + over
    const c00 = at(-Lo, -Wo, e), c10 = at(Lo, -Wo, e), c11 = at(Lo, Wo, e), c01 = at(-Lo, Wo, e)
    const r0 = at(-half, 0, top), r1 = at(half, 0, top)
    b.quad(c00, c10, r1, r0, roofColor, up)
    b.quad(c01, c11, r1, r0, roofColor, up)
    b.tri(c00, c01, r0, roofColor, up)
    b.tri(c10, c11, r1, roofColor, up)
  }
}

function decodeParts(list) {
  const parts = []
  for (let k = 0; k + 8 < list.length; k += 9) {
    const ax = list[k + 2] / 1000
    const az = list[k + 3] / 1000
    const n = Math.hypot(ax, az) || 1
    parts.push({
      cx: list[k] / 10, cz: list[k + 1] / 10, ax: ax / n, az: az / n,
      L: list[k + 4] / 10, W: list[k + 5] / 10, half: list[k + 6] / 10,
      eave: list[k + 7] / 10, ridge: list[k + 8] / 10
    })
  }
  return parts
}

// Distance from (x, z) to a part's rectangle (0 inside).
function partDistance(p, x, z) {
  const du = (x - p.cx) * p.ax + (z - p.cz) * p.az
  const dv = -(x - p.cx) * p.az + (z - p.cz) * p.ax
  return Math.hypot(Math.max(Math.abs(du) - p.L, 0), Math.max(Math.abs(dv) - p.W, 0))
}

function buildTile(tile) {
  const b = new Builder()
  for (const rec of tile.b) {
    const [baseY, height, minHeight, kind, roofHint, , ring, facadeHex, roofHex, partList] = rec
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

    if (partList?.length) {
      addMeasured(b, rec, xs, zs, area, decodeParts(partList), wallColor, h)
      continue
    }

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

    const { style, doorEdge } = facadeStyle(kind, height, area, xs, zs)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const out = [-(zs[j] - zs[i]), 0, xs[j] - xs[i]]
      const len = Math.hypot(xs[j] - xs[i], zs[j] - zs[i])
      const st = style < 0 ? -1 : style + (i === doorEdge ? 10 : 0)
      const v0 = bottom - baseY
      const v1 = eave - baseY
      b.quad(
        [xs[i], bottom, zs[i]], [xs[j], bottom, zs[j]], [xs[j], eave, zs[j]], [xs[i], eave, zs[i]], wallColor, out,
        [0, v0, len, st], [len, v0, len, st], [len, v1, len, st], [0, v1, len, st]
      )
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
    colors: new Float32Array(b.col),
    facades: new Float32Array(b.fac)
  }
}

self.onmessage = (e) => {
  const { id, tile } = e.data
  try {
    const out = buildTile(tile)
    self.postMessage({ id, ...out, count: tile.b.length }, [out.positions.buffer, out.normals.buffer, out.colors.buffer, out.facades.buffer])
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) })
  }
}
