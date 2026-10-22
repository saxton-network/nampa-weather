// Camera modes: a "drone" orbit/pan camera (default) and a ground-level walk mode.
// Both keep the camera above the streamed terrain.

import { Euler, MathUtils, Vector3 } from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { geodeticToLocal, localToGeodetic } from './geo.js'

const DEG = Math.PI / 180
const EYE_HEIGHT = 1.7
const MIN_DRONE_AGL = 2.5
const geo = { lat: 0, lon: 0, height: 0 }
const tmp = new Vector3()

// Local-frame y of the ground directly below `p`, or null if not loaded yet.
function groundY(terrain, p, extra = 0) {
  localToGeodetic(p, geo)
  const h = terrain.heightAt(geo.lat, geo.lon)
  if (h == null) return null
  return geodeticToLocal(geo.lat, geo.lon, h + extra, tmp).y
}

export function groundHeightBelow(terrain, p) {
  localToGeodetic(p, geo)
  const h = terrain.heightAt(geo.lat, geo.lon)
  return h == null ? null : { ground: h, agl: geo.height - h, lat: geo.lat, lon: geo.lon, msl: geo.height }
}

export class DroneControls {
  constructor(camera, dom, terrain) {
    this.camera = camera
    this.terrain = terrain
    this.controls = new MapControls(camera, dom)
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.12,
      zoomToCursor: true,
      screenSpacePanning: false,
      minDistance: 4,
      maxDistance: 90000,
      maxPolarAngle: 89 * DEG
    })
  }

  set enabled(v) {
    this.controls.enabled = v
  }

  // heading: degrees clockwise from north; pitch: degrees, negative looks down.
  lookAt(target, { distance, heading, pitch }) {
    const h = heading * DEG
    const p = pitch * DEG
    const dir = new Vector3(Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p))
    this.controls.target.copy(target)
    this.camera.position.copy(target).addScaledVector(dir, -distance)
    this.camera.lookAt(target)
    this.controls.update()
  }

  update() {
    const { controls, camera } = this
    controls.update()
    // Keep the orbit target on the ground so rotating pivots around a real point.
    const gy = groundY(this.terrain, controls.target)
    if (gy != null) {
      const dy = (gy - controls.target.y) * 0.25
      if (Math.abs(dy) > 0.01) {
        controls.target.y += dy
        camera.position.y += dy
      }
    }
    const cy = groundY(this.terrain, camera.position, MIN_DRONE_AGL)
    if (cy != null && camera.position.y < cy) camera.position.y = cy
  }
}

export class WalkControls {
  constructor(camera, dom, terrain) {
    this.camera = camera
    this.dom = dom
    this.terrain = terrain
    this.enabled = false
    this.yaw = 0
    this.pitch = 0
    this.keys = new Set()
    this.touchMove = 0
    this.speed = 2.2
    this.runSpeed = 9
    this.dragging = null

    document.addEventListener('keydown', (e) => {
      if (this.enabled && !e.target.closest?.('input,select,textarea')) this.keys.add(e.code)
    })
    document.addEventListener('keyup', (e) => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())
    dom.addEventListener('click', () => {
      if (this.enabled && matchMedia('(pointer: fine)').matches) dom.requestPointerLock?.()
    })
    document.addEventListener('mousemove', (e) => {
      if (this.enabled && document.pointerLockElement === dom) this.look(e.movementX, e.movementY)
    })
    dom.addEventListener('pointerdown', (e) => {
      if (this.enabled && document.pointerLockElement !== dom) this.dragging = { x: e.clientX, y: e.clientY }
    })
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return
      this.look(e.clientX - this.dragging.x, e.clientY - this.dragging.y)
      this.dragging = { x: e.clientX, y: e.clientY }
    })
    window.addEventListener('pointerup', () => (this.dragging = null))
  }

  look(dx, dy) {
    this.yaw -= dx * 0.0025
    this.pitch = MathUtils.clamp(this.pitch - dy * 0.0025, -85 * DEG, 85 * DEG)
  }

  // Start walking at `p` (local frame), facing `heading` degrees from north.
  placeAt(p, heading) {
    this.camera.position.copy(p)
    this.yaw = -heading * DEG
    this.pitch = 0
    const gy = groundY(this.terrain, p, EYE_HEIGHT)
    if (gy != null) this.camera.position.y = gy
  }

  get heading() {
    return -this.yaw / DEG
  }

  exit() {
    if (document.pointerLockElement === this.dom) document.exitPointerLock()
    this.keys.clear()
  }

  update(dt) {
    if (!this.enabled) return
    const k = this.keys
    let fwd = this.touchMove
    let side = 0
    if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1
    if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1
    if (k.has('KeyD') || k.has('ArrowRight')) side += 1
    if (k.has('KeyA') || k.has('ArrowLeft')) side -= 1
    const run = k.has('ShiftLeft') || k.has('ShiftRight')
    const speed = (run ? this.runSpeed : this.speed) * dt
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    // yaw 0 faces north (-z); positive yaw turns left (counter-clockwise from above).
    this.camera.position.x += (-sin * fwd + cos * side) * speed
    this.camera.position.z += (-cos * fwd - sin * side) * speed
    const gy = groundY(this.terrain, this.camera.position, EYE_HEIGHT)
    if (gy != null) this.camera.position.y += (gy - this.camera.position.y) * Math.min(1, dt * 12)
    this.camera.quaternion.setFromEuler(new Euler(this.pitch, this.yaw, 0, 'YXZ'))
  }
}
