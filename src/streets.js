// Street name labels and "which street am I on" lookup.
//
// Labels are HTML elements placed over the canvas each frame: anchors from
// data-prep/build_roads.py are projected to the screen, sorted by road rank
// and distance, and placed greedily so they never overlap. In drone mode they
// follow the road direction; in walk mode they float upright at sign height.

import { Vector3 } from 'three'

const BASE = import.meta.env.BASE_URL
const MAX_LABELS = 45
const SAME_NAME_SPACING = 240 // px between two labels of the same street
const FONT = ['600 13px', '600 13px', '600 12px', '600 12px', '500 11.5px', '500 11px']
const CHAR_WIDTH = [7.4, 7.4, 6.9, 6.9, 6.4, 6.1]

const WORDS = {
  Avenue: 'Ave', Street: 'St', Road: 'Rd', Boulevard: 'Blvd', Drive: 'Dr', Lane: 'Ln', Court: 'Ct',
  Place: 'Pl', Parkway: 'Pkwy', Highway: 'Hwy', Circle: 'Cir', Terrace: 'Ter', Trail: 'Trl',
  North: 'N', South: 'S', East: 'E', West: 'W', Northeast: 'NE', Northwest: 'NW', Southeast: 'SE', Southwest: 'SW'
}

export function shortName(name) {
  const m = /^Interstate (\d+)/.exec(name)
  if (m) return `I-${m[1]}`
  return name.replace(/\b[A-Z][a-z]+\b/g, (w) => WORDS[w] ?? w)
}

const v = new Vector3()
const w = new Vector3()

export class Streets {
  constructor(container) {
    this.tiles = new Map() // "i_j" -> tile json, or 'loading' / 'failed'
    this.index = null
    this.loading = 0
    this.layer = document.createElement('div')
    this.layer.className = 'labels'
    container.prepend(this.layer)
    this.pool = []
    for (let k = 0; k < MAX_LABELS; k++) {
      const el = document.createElement('div')
      el.className = 'label'
      el.hidden = true
      this.layer.append(el)
      this.pool.push(el)
    }
    this.ready = fetch(`${BASE}data/roads/index.json`)
      .then((r) => r.json())
      .then((index) => {
        this.index = index
        this.attribution = index.attribution
        this.indexed = new Set(index.tiles.map(([i, j]) => `${i}_${j}`))
      })
      .catch((err) => {
        this.lastError = `roads index: ${err.message}`
      })
  }

  set visible(on) {
    this.layer.hidden = !on
  }

  get visible() {
    return !this.layer.hidden
  }

  async load(key) {
    this.tiles.set(key, 'loading')
    this.loading++
    try {
      const r = await fetch(`${BASE}data/roads/${key}.json`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const t = await r.json()
      t.short = t.names.map(shortName)
      if (this.tiles.get(key) === 'loading') this.tiles.set(key, t)
    } catch (err) {
      this.tiles.set(key, 'failed')
      this.lastError = `roads ${key}: ${err.message}`
    } finally {
      this.loading--
    }
  }

  // Loads tiles within `radius` of the camera and drops far ones.
  stream(camPos, radius) {
    if (!this.index) return
    const size = this.index.tileSize
    const wanted = []
    for (const [i, j] of this.index.tiles) {
      const d = Math.hypot((i + 0.5) * size - camPos.x, (j + 0.5) * size - camPos.z) - size * 0.7
      const key = `${i}_${j}`
      if (d < radius && !this.tiles.has(key)) wanted.push([d, key])
      else if (d > radius + 2000 && this.tiles.has(key) && this.tiles.get(key) !== 'loading') this.tiles.delete(key)
    }
    wanted.sort((a, b) => a[0] - b[0])
    for (const [, key] of wanted) {
      if (this.loading >= 4) break
      this.load(key)
    }
  }

  update(camera, { mode, agl, width, height, occluded }) {
    const walk = mode === 'walk'
    const maxDist = walk ? 260 : Math.min(Math.max(agl * 9, 450), 6000)
    camera.updateMatrixWorld()
    const cam = camera.position
    this.stream(cam, maxDist + 600)
    if (!this.visible) return

    const now = performance.now()
    const candidates = []
    for (const t of this.tiles.values()) {
      if (typeof t !== 'object') continue
      const ox = t.i * t.size
      const oz = t.j * t.size
      for (const a of t.anchors) {
        const x = ox + a[0] / 10
        const z = oz + a[1] / 10
        const y = a[2] / 10 + (walk ? 3.2 : 0.6)
        const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z)
        if (d > maxDist) continue
        v.set(x, y, z).project(camera)
        if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue
        // At street level, hide labels whose line of sight crosses a building.
        // The answer is cached per anchor for a moment; it is the costly part.
        if (walk && occluded) {
          a.vis ??= { t: 0, hidden: false }
          if (now - a.vis.t > 300) {
            a.vis.t = now
            a.vis.hidden = occluded(cam.x, cam.z, x, z)
          }
          if (a.vis.hidden) continue
        }
        candidates.push({ a, t, x, y, z, d, sx: ((v.x + 1) / 2) * width, sy: ((1 - v.y) / 2) * height })
      }
    }
    candidates.sort((p, q) => p.a[5] - q.a[5] || p.d - q.d)

    const placed = []
    const byName = new Map()
    let n = 0
    for (const c of candidates) {
      if (n >= MAX_LABELS) break
      const rank = c.a[5]
      const text = c.t.short[c.a[4]]
      let angle = 0
      if (!walk) {
        const rad = (c.a[3] / 10) * (Math.PI / 180)
        w.set(c.x + Math.cos(rad) * 8, c.y, c.z + Math.sin(rad) * 8).project(camera)
        angle = Math.atan2(((1 - w.y) / 2) * height - c.sy, ((w.x + 1) / 2) * width - c.sx)
        if (angle > Math.PI / 2) angle -= Math.PI
        if (angle < -Math.PI / 2) angle += Math.PI
        if (Math.abs(angle) > (62 * Math.PI) / 180) angle = 0
      }
      const lw = text.length * CHAR_WIDTH[rank] + 10
      const lh = 18
      const bw = Math.abs(lw * Math.cos(angle)) + Math.abs(lh * Math.sin(angle))
      const bh = Math.abs(lw * Math.sin(angle)) + Math.abs(lh * Math.cos(angle))
      const box = [c.sx - bw / 2, c.sy - bh / 2, c.sx + bw / 2, c.sy + bh / 2]
      if (box[0] < 0 || box[2] > width || box[1] < 0 || box[3] > height) continue
      if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue
      const same = byName.get(text)
      if (same?.some(([px, py]) => Math.hypot(px - c.sx, py - c.sy) < SAME_NAME_SPACING)) continue
      placed.push(box)
      if (same) same.push([c.sx, c.sy])
      else byName.set(text, [[c.sx, c.sy]])

      const el = this.pool[n++]
      if (el.textContent !== text) el.textContent = text
      el.style.font = `${FONT[rank]} system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`
      el.style.transform = `translate(${c.sx.toFixed(1)}px, ${c.sy.toFixed(1)}px) translate(-50%, -50%) rotate(${angle.toFixed(3)}rad)`
      el.style.opacity = String(Math.min(1, 1.6 * (1 - c.d / maxDist)).toFixed(2))
      el.classList.toggle('major', rank <= 1)
      el.hidden = false
    }
    for (let k = n; k < this.pool.length; k++) this.pool[k].hidden = true
    this.shown = n
  }

  // Nearest named street to local point p within maxDist metres, or null.
  nearest(p, maxDist = 60) {
    if (!this.index) return null
    const size = this.index.tileSize
    const ci = Math.floor(p.x / size)
    const cj = Math.floor(p.z / size)
    let best = null
    let bestD = maxDist
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const t = this.tiles.get(`${i}_${j}`)
        if (typeof t !== 'object') continue
        const px = (p.x - t.i * t.size) * 10
        const pz = (p.z - t.j * t.size) * 10
        for (const s of t.segs) {
          for (let k = 2; k < s.length - 2; k += 2) {
            const x0 = s[k], z0 = s[k + 1], x1 = s[k + 2], z1 = s[k + 3]
            const dx = x1 - x0
            const dz = z1 - z0
            const len2 = dx * dx + dz * dz
            const f = len2 ? Math.min(Math.max(((px - x0) * dx + (pz - z0) * dz) / len2, 0), 1) : 0
            const d = Math.hypot(px - (x0 + f * dx), pz - (z0 + f * dz)) / 10
            if (d < bestD) {
              bestD = d
              best = { name: t.names[s[0]], short: t.short[s[0]], distance: d, rank: s[1] }
            }
          }
        }
      }
    }
    return best
  }
}
