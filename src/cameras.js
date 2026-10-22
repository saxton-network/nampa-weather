// Publicly mapped ALPR (license plate reader) cameras: 3D poles with a ground
// wedge for each direction they face, plus clickable screen pins that cluster
// when zoomed out. Data: public/data/cameras.json (data-prep/build_cameras.py).

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3
} from 'three'
import { geodeticToLocal } from './geo.js'

const BASE = import.meta.env.BASE_URL
const DEG = Math.PI / 180
const WEDGE_RADIUS = 30 // m; roughly the stretch of road a plate reader covers
const WEDGE_HALF_ANGLE = 20 * DEG
const WEDGE_SEGMENTS = 10
const MAX_PINS = 80
const MODEL_RANGE = 1500 // m; beyond this only the pin is drawn
const CLUSTER_PX = 30

export const BRANDS = [
  { match: /flock/i, label: 'Flock Safety', color: 0xff5138 },
  { match: /motorola|vigilant/i, label: 'Motorola Solutions', color: 0xb27cff },
  { match: /axon/i, label: 'Axon', color: 0xffcf3a },
  { match: /./, label: 'Other / unknown', color: 0x37c8ff }
]
const brandOf = (name) => BRANDS.find((b) => b.match.test(name ?? '')) ?? BRANDS[3]
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`

const MOUNT_HEIGHT = { street_lamp: 7, traffic_signals: 5.5, pole: 4.2 }
const MOUNT_LABEL = {
  street_lamp: 'street light',
  traffic_signals: 'traffic signal',
  pole: 'its own pole',
  pole_or_traffic_signal: 'pole or traffic signal'
}
const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
export const cardinal = (deg) => CARDINALS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]

// Slightly larger than life so the cameras read from drone height.
const poleGeometry = new CylinderGeometry(0.12, 0.15, 1, 8).translate(0, 0.5, 0)
const headGeometry = new BoxGeometry(0.34, 0.3, 0.6)
const panelGeometry = new BoxGeometry(0.75, 0.04, 0.55)
const poleMaterial = new MeshBasicMaterial({ color: 0x8b8e92 })
const headMaterial = new MeshBasicMaterial({ color: 0x1b1d20 })
const panelMaterial = new MeshBasicMaterial({ color: 0x1c2b4d })

const v = new Vector3()

export class Cameras {
  constructor(container, terrain) {
    this.terrain = terrain
    this.group = new Group()
    this.group.name = 'cameras'
    this.list = []
    this.selected = null
    this.onSelect = null
    this.onCluster = null
    this.layer = document.createElement('div')
    this.layer.className = 'pins'
    container.prepend(this.layer)
    this.pins = []
    for (let k = 0; k < MAX_PINS; k++) {
      const el = document.createElement('button')
      el.className = 'pin'
      el.hidden = true
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        const hit = el._hit
        if (!hit) return
        if (hit.count > 1) this.onCluster?.(hit)
        else this.select(hit.cam)
      })
      this.layer.append(el)
      this.pins.push(el)
    }
    this.wedgeMaterials = new Map()
    this.ready = fetch(`${BASE}data/cameras.json`)
      .then((r) => r.json())
      .then((data) => {
        this.meta = data
        for (const c of data.cameras) this.add(c)
      })
      .catch((err) => {
        this.lastError = `cameras: ${err.message}`
      })
  }

  set visible(on) {
    this.group.visible = on
    this.layer.hidden = !on
    if (!on) this.select(null)
  }

  get visible() {
    return this.group.visible
  }

  wedgeMaterial(color, selected) {
    const key = `${color}-${selected}`
    let m = this.wedgeMaterials.get(key)
    if (!m) {
      m = new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: selected ? 0.6 : 0.33,
        depthWrite: false,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2
      })
      this.wedgeMaterials.set(key, m)
    }
    return m
  }

  add(data) {
    const brand = brandOf(data.brand)
    const height = MOUNT_HEIGHT[data.mount] ?? 4.5
    const cam = { ...data, brand: brand, brandName: data.brand, height, placedZoom: -1, position: new Vector3() }
    const g = new Group()
    g.visible = false
    const pole = new Mesh(poleGeometry, poleMaterial)
    pole.scale.y = height
    g.add(pole)
    const dirs = data.directions.length ? data.directions : [null]
    for (const d of dirs) {
      const head = new Mesh(headGeometry, headMaterial)
      const a = (d ?? 0) * DEG
      head.position.set(Math.sin(a) * 0.4, height - 0.4, -Math.cos(a) * 0.4)
      head.rotation.set(-10 * DEG, -a, 0, 'YXZ')
      g.add(head)
    }
    if (brand === BRANDS[0]) {
      const panel = new Mesh(panelGeometry, panelMaterial)
      panel.position.set(0, height + 0.15, 0)
      panel.rotation.x = 30 * DEG // tilted toward the southern sky
      g.add(panel)
    }
    cam.model = g
    cam.wedges = data.directions.map((d) => {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array((WEDGE_SEGMENTS + 2) * 3), 3))
      const idx = []
      for (let k = 0; k < WEDGE_SEGMENTS; k++) idx.push(0, k + 1, k + 2)
      geometry.setIndex(idx)
      const mesh = new Mesh(geometry, this.wedgeMaterial(brand.color, false))
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.userData.direction = d
      this.group.add(mesh)
      return mesh
    })
    this.group.add(g)
    this.list.push(cam)
  }

  // Sits the camera and its wedges on the most detailed terrain loaded so far.
  place(cam, ground) {
    geodeticToLocal(cam.lat, cam.lon, ground.height, cam.position)
    cam.model.position.copy(cam.position)
    cam.model.updateMatrixWorld(true)
    for (const w of cam.wedges) {
      const pos = w.geometry.attributes.position
      const a0 = w.userData.direction * DEG
      // Sample the ground under each wedge vertex, offset slightly in metres.
      const mPerDegLat = 111132
      const mPerDegLon = 111320 * Math.cos(cam.lat * DEG)
      for (let k = 0; k <= WEDGE_SEGMENTS + 1; k++) {
        let lat = cam.lat
        let lon = cam.lon
        if (k > 0) {
          const a = a0 - WEDGE_HALF_ANGLE + ((k - 1) / WEDGE_SEGMENTS) * 2 * WEDGE_HALF_ANGLE
          lat += (Math.cos(a) * WEDGE_RADIUS) / mPerDegLat
          lon += (Math.sin(a) * WEDGE_RADIUS) / mPerDegLon
        }
        const h = this.terrain.heightAt(lat, lon) ?? ground.height
        geodeticToLocal(lat, lon, h + 0.3, v).toArray(pos.array, k * 3)
      }
      pos.needsUpdate = true
      w.geometry.computeBoundingSphere()
    }
    cam.placedZoom = ground.zoom
  }

  select(cam) {
    if (this.selected) {
      for (const w of this.selected.wedges) w.material = this.wedgeMaterial(this.selected.brand.color, false)
    }
    this.selected = cam
    if (cam) for (const w of cam.wedges) w.material = this.wedgeMaterial(cam.brand.color, true)
    this.onSelect?.(cam)
  }

  byId(id) {
    return this.list.find((c) => String(c.id) === String(id)) ?? null
  }

  get pending() {
    return this.list.filter((c) => c.placedZoom < 0).length
  }

  // Nearest camera to local point p: { cam, distance, bearing } or null.
  nearest(p) {
    let best = null
    for (const cam of this.list) {
      const pos = cam.placedZoom >= 0 ? cam.position : geodeticToLocal(cam.lat, cam.lon, 0, v)
      const dx = pos.x - p.x
      const dz = pos.z - p.z
      const d = Math.hypot(dx, dz)
      if (!best || d < best.distance) best = { cam, distance: d, bearing: ((Math.atan2(dx, -dz) / DEG) + 360) % 360 }
    }
    return best
  }

  update(camera, { mode, agl, width, height }) {
    if (!this.list.length) return
    const cam = camera.position
    const walk = mode === 'walk'

    // Place every camera on whatever terrain is loaded, then refine nearby
    // ones as finer tiles arrive. The nearest-first order is refreshed now and then.
    this.frame = (this.frame ?? 0) + 1
    if (!this.order || this.frame % 60 === 0) {
      this.order = this.list
        .map((c) => [c, geodeticToLocal(c.lat, c.lon, 0, v).distanceTo(cam)])
        .sort((a, b) => a[1] - b[1])
        .map(([c]) => c)
    }
    // Each camera is several meshes; only draw the ones close enough to see.
    if (this.frame % 10 === 0) {
      // From high up the models are sub-pixel; the pins carry them.
      const range = agl > 800 ? 0 : MODEL_RANGE
      for (const c of this.list) {
        const show = c.placedZoom >= 0 && c.position.distanceTo(cam) < range
        c.model.visible = show
        for (const w of c.wedges) w.visible = show
      }
    }
    if (this.frame % 3 === 0) {
      let budget = 40
      for (const c of this.order) {
        if (budget <= 0) break
        const g = this.terrain.groundAt(c.lat, c.lon)
        if (g && g.zoom > c.placedZoom) {
          this.place(c, g)
          budget--
        }
      }
    }
    if (!this.visible) return

    // Screen pins, clustered greedily nearest-first.
    camera.updateMatrixWorld()
    // Near the ground only nearby pins matter; from high up, the whole valley.
    const maxDist = walk ? 400 : Math.min(Math.max(agl * 40, 400), 25000)
    const hits = []
    for (const c of this.list) {
      if (c.placedZoom < 0) continue
      const d = c.position.distanceTo(cam)
      if (d > maxDist) continue
      v.copy(c.position)
      v.y += c.height + (walk ? 1.2 : 2)
      v.project(camera)
      if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1.02 || Math.abs(v.y) > 1.02) continue
      hits.push({ cam: c, d, x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height })
    }
    hits.sort((a, b) => a.d - b.d)
    const placed = []
    for (const h of hits) {
      const near = placed.find((p) => Math.hypot(p.x - h.x, p.y - h.y) < CLUSTER_PX)
      if (near) {
        near.count++
        near.members.push(h.cam)
      } else if (placed.length < MAX_PINS) {
        placed.push({ ...h, count: 1, members: [h.cam] })
      }
    }
    let n = 0
    for (const p of placed) {
      const el = this.pins[n++]
      el._hit = p
      const color = css(p.count > 1 ? 0xffffff : p.cam.brand.color)
      const label = p.count > 1 ? String(p.count) : ''
      if (el.dataset.label !== label) {
        el.dataset.label = label
        el.textContent = label
      }
      el.style.setProperty('--pin', color)
      el.classList.toggle('cluster', p.count > 1)
      el.classList.toggle('selected', p.count === 1 && p.cam === this.selected)
      el.title = p.count > 1 ? `${p.count} cameras. Click to zoom in.` : `${p.cam.brandName ?? 'Unknown brand'} ALPR camera`
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`
      el.hidden = false
    }
    for (let k = n; k < this.pins.length; k++) {
      this.pins[k].hidden = true
      this.pins[k]._hit = null
    }
    this.shown = n
  }
}

export function describeCamera(cam) {
  const dirs = cam.directions.map((d) => `${cardinal(d)} (${Math.round(d)}°)`).join(', ')
  const rows = [
    ['Faces', dirs || 'unknown'],
    ['Mounted on', MOUNT_LABEL[cam.mount] ?? 'not recorded'],
    ['Watching', cam.zone ? cam.zone.replace(/[,;_]/g, (m) => (m === '_' ? ' ' : ', ')) : 'not recorded'],
    ['Operator', cam.operator ?? 'not recorded'],
    ['Last edited', cam.edited ? new Date(cam.edited).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'unknown']
  ]
  return { title: `${cam.brandName ?? 'Unknown brand'} plate reader`, color: css(cam.brand.color), rows }
}
