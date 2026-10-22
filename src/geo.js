// WGS84 geodesy and the viewer's local frame.
//
// The scene uses a local tangent frame centred on region.origin:
//   x = east, y = up, z = south (so north is -z, matching three.js conventions).
// Positions are exact ECEF offsets rotated into this frame, so Earth's curvature
// is built into the geometry. data-prep/build_buildings.py uses the same math.

import { Matrix4, Vector3 } from 'three'
import region from './region.json'

const A = 6378137.0
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const B = A * (1 - F)
const EP2 = (A * A - B * B) / (B * B)
const DEG = Math.PI / 180

export function geodeticToECEF(lat, lon, h, out = new Vector3()) {
  const phi = lat * DEG
  const lam = lon * DEG
  const sinPhi = Math.sin(phi)
  const n = A / Math.sqrt(1 - E2 * sinPhi * sinPhi)
  const cosPhi = Math.cos(phi)
  return out.set(
    (n + h) * cosPhi * Math.cos(lam),
    (n + h) * cosPhi * Math.sin(lam),
    (n * (1 - E2) + h) * sinPhi
  )
}

// Bowring's method; accurate to well under a millimetre near the surface.
export function ecefToGeodetic(p, out = { lat: 0, lon: 0, height: 0 }) {
  const { x, y, z } = p
  const r = Math.hypot(x, y)
  const theta = Math.atan2(z * A, r * B)
  const st = Math.sin(theta)
  const ct = Math.cos(theta)
  const phi = Math.atan2(z + EP2 * B * st * st * st, r - E2 * A * ct * ct * ct)
  const sinPhi = Math.sin(phi)
  const n = A / Math.sqrt(1 - E2 * sinPhi * sinPhi)
  out.lat = phi / DEG
  out.lon = Math.atan2(y, x) / DEG
  out.height = r / Math.cos(phi) - n
  return out
}

const o = region.origin
export const ORIGIN_ECEF = geodeticToECEF(o.lat, o.lon, o.height)
const phi0 = o.lat * DEG
const lam0 = o.lon * DEG
const EAST = new Vector3(-Math.sin(lam0), Math.cos(lam0), 0)
const NORTH = new Vector3(-Math.sin(phi0) * Math.cos(lam0), -Math.sin(phi0) * Math.sin(lam0), Math.cos(phi0))
const UP = new Vector3(Math.cos(phi0) * Math.cos(lam0), Math.cos(phi0) * Math.sin(lam0), Math.sin(phi0))
const SOUTH = NORTH.clone().negate()

// Local frame -> ECEF (used by the atmosphere so its ellipsoid sits under us).
export const WORLD_TO_ECEF = new Matrix4().makeBasis(EAST, UP, SOUTH).setPosition(ORIGIN_ECEF)

const tmp = new Vector3()
const tmp2 = new Vector3()

// Rotates an ECEF direction into the local frame (x east, y up, z south).
export function ecefDirToLocal(d, out = new Vector3()) {
  return out.set(d.dot(EAST), d.dot(UP), d.dot(SOUTH))
}

export function geodeticToLocal(lat, lon, h, out = new Vector3()) {
  geodeticToECEF(lat, lon, h, tmp).sub(ORIGIN_ECEF)
  return out.set(tmp.dot(EAST), tmp.dot(UP), -tmp.dot(NORTH))
}

export function localToGeodetic(v, out) {
  tmp2.copy(v).applyMatrix4(WORLD_TO_ECEF)
  return ecefToGeodetic(tmp2, out)
}

// Web Mercator tile helpers (XYZ scheme, y down from the north).
export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z
}

export function latToTileY(lat, z) {
  return ((1 - Math.asinh(Math.tan(lat * DEG)) / Math.PI) / 2) * 2 ** z
}

export function tileXToLon(x, z) {
  return (x / 2 ** z) * 360 - 180
}

export function tileYToLat(y, z) {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / DEG
}
