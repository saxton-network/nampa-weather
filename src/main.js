import './style.css'
import { PerspectiveCamera, Scene, Timer, Vector3, WebGLRenderer } from 'three'
import { Buildings } from './buildings.js'
import { DroneControls, WalkControls, groundHeightBelow } from './controls.js'
import { geodeticToLocal } from './geo.js'
import region from './region.json'
import { Sky } from './sky.js'
import { IMAGERY_PROVIDERS, TERRAIN_CREDIT, Terrain } from './terrain.js'
import { atLocalHours, localHours } from './time.js'
import { UI } from './ui.js'

const params = new URLSearchParams(location.search)
const coarse = matchMedia('(pointer: coarse)').matches
const lowQuality = params.get('quality') === 'low' || (params.get('quality') !== 'high' && coarse)

// Camera presets: drone views orbit a ground point; walk views stand on it.
const PRESETS = {
  overview: { label: 'Overview of Nampa', lat: 43.579, lon: -116.563, distance: 2600, heading: 20, pitch: -28 },
  downtown: { label: 'Downtown (drone)', lat: 43.5797, lon: -116.5622, distance: 160, heading: 45, pitch: -22 },
  neighborhood: { label: 'Neighborhood (drone)', lat: 43.5475, lon: -116.5815, distance: 90, heading: 200, pitch: -25 },
  street: { label: 'Downtown (walk)',lat: 43.5787, lon: -116.5637, heading: 45, walk: true },
  mountains: { label: 'Toward the Boise front', lat: 43.579, lon: -116.563, distance: 9000, heading: 60, pitch: -9 }
}

const renderer = new WebGLRenderer({
  antialias: false,
  depth: true,
  stencil: false,
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance'
})
renderer.setPixelRatio(Math.min(devicePixelRatio, lowQuality ? 1.25 : 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMappingExposure = Number(params.get('exposure') ?? 10)
renderer.info.autoReset = false
document.body.append(renderer.domElement)

const scene = new Scene()
const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 400000)

let imageryKey = IMAGERY_PROVIDERS[params.get('imagery')] ? params.get('imagery') : 'esri'
const makeTerrain = () =>
  new Terrain(renderer, {
    provider: imageryKey,
    sseThreshold: lowQuality ? 1.6 : 1.0,
    maxTiles: lowQuality ? 350 : 700
  })
let terrain = makeTerrain()
scene.add(terrain.group)
const buildings = new Buildings()
scene.add(buildings.group)
const sky = new Sky(renderer, scene, camera)

const drone = new DroneControls(camera, renderer.domElement, terrain)
const walk = new WalkControls(camera, renderer.domElement, terrain)
let mode = 'drone'

// --- time of day ------------------------------------------------------------
let date = params.get('t') ? new Date(params.get('t')) : new Date()
if (Number.isNaN(date.getTime())) date = new Date()
let followNow = !params.get('t')

const ui = new UI({
  presets: PRESETS,
  imagery: { options: IMAGERY_PROVIDERS, current: imageryKey },
  onMode: setMode,
  onPreset: (k) => applyPreset(PRESETS[k]),
  onTime: (hours) => {
    followNow = false
    date = atLocalHours(date, hours)
    ui.setTime(date)
  },
  onNow: () => {
    followNow = true
    date = new Date()
    ui.setTime(date, localHours(date))
  },
  onImagery: (key) => {
    imageryKey = key
    scene.remove(terrain.group)
    for (const r of terrain.roots) terrain.disposeTile(r)
    terrain = makeTerrain()
    drone.terrain = walk.terrain = terrain
    scene.add(terrain.group)
    updateCredits()
  },
  onTouchMove: (dir) => (walk.touchMove = dir)
})
ui.setTime(date, localHours(date))

function updateCredits() {
  ui.setCredits([
    IMAGERY_PROVIDERS[imageryKey].credit,
    TERRAIN_CREDIT,
    buildings.attribution ?? 'Buildings © Overture Maps Foundation, © OpenStreetMap contributors'
  ])
}
updateCredits()
buildings.ready.then(updateCredits)

// --- camera modes -----------------------------------------------------------
function groundPoint(lat, lon) {
  const h = terrain.heightAt(lat, lon) ?? 770
  return geodeticToLocal(lat, lon, h)
}

function setMode(next, { at, heading } = {}) {
  if (next === 'walk') {
    const p = at ?? drone.controls.target.clone()
    const dir = new Vector3().subVectors(drone.controls.target, camera.position)
    const h = heading ?? (Math.atan2(dir.x, -dir.z) * 180) / Math.PI
    drone.enabled = false
    walk.enabled = true
    walk.placeAt(p, h)
    camera.near = 0.3
  } else {
    walk.exit()
    walk.enabled = false
    const target = camera.position.clone()
    if (mode === 'walk') {
      drone.enabled = true
      drone.lookAt(target, { distance: 60, heading: walk.heading, pitch: -25 })
    }
    drone.enabled = true
  }
  mode = next
  ui.setMode(mode)
}

function applyPreset(p) {
  const target = groundPoint(p.lat, p.lon)
  if (p.walk) {
    if (mode !== 'walk') {
      drone.lookAt(target, { distance: 30, heading: p.heading, pitch: -20 })
    }
    setMode('walk', { at: target, heading: p.heading })
  } else {
    if (mode === 'walk') setMode('drone')
    drone.lookAt(target, p)
  }
}

applyPreset(PRESETS[params.get('view')] ?? PRESETS.overview)
setMode(mode)

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  sky.setSize(innerWidth, innerHeight)
})
sky.setSize(innerWidth, innerHeight)
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input,select,textarea')) return
  if (e.code === 'KeyV') setMode(mode === 'walk' ? 'drone' : 'walk')
})

// --- main loop --------------------------------------------------------------
const timer = new Timer()
const fps = { frames: 0, last: performance.now(), value: 0, ms: 0 }
let idleFrames = 0
// Exposed for tools/screenshot.mjs and for poking at things from the console.
window.__nampa = { ready: false, camera, terrain: () => terrain, buildings, sky }

function frame(timestamp) {
  timer.update(timestamp)
  const dt = Math.min(timer.getDelta(), 0.1)
  renderer.info.reset()
  const t0 = performance.now()
  if (followNow) date = new Date()
  sky.setDate(date)

  if (mode === 'walk') walk.update(dt)
  else drone.update()

  const below = groundHeightBelow(terrain, camera.position)
  const agl = below?.agl ?? 500
  // Near plane scales with altitude; the log depth buffer covers the rest.
  camera.near = mode === 'walk' ? 0.3 : Math.min(Math.max(agl / 20, 0.5), 50)
  camera.updateProjectionMatrix()

  terrain.update(camera)
  buildings.update(camera.position, agl)
  sky.render(dt)

  const busy = terrain.loading + terrain.needed.size + buildings.loading
  idleFrames = busy === 0 && sky.ready ? idleFrames + 1 : 0
  window.__nampa.ready = idleFrames > 30

  fps.frames++
  fps.ms = fps.ms * 0.9 + (performance.now() - t0) * 0.1
  const now = performance.now()
  if (now - fps.last > 500) {
    fps.value = (fps.frames * 1000) / (now - fps.last)
    fps.frames = 0
    fps.last = now
    if (followNow) ui.setTime(date, localHours(date))
    const ts = terrain.stats
    const bs = buildings.stats
    const info = renderer.info.render
    ui.setDebug([
      `fps ${fps.value.toFixed(0)}   cpu ${fps.ms.toFixed(1)} ms   ${lowQuality ? 'low' : 'high'} quality`,
      `mode ${mode}`,
      below
        ? `cam ${below.lat.toFixed(5)}, ${below.lon.toFixed(5)}   ${below.msl.toFixed(0)} m MSL   ${below.agl.toFixed(1)} m AGL`
        : 'cam (terrain not loaded)',
      `sun elevation ${sky.sunElevation.toFixed(1)}°   exposure ${renderer.toneMappingExposure}`,
      `terrain tiles ${ts.visible} shown / ${ts.loaded} loaded / ${ts.loading} loading / ${ts.queued} queued / ${ts.failed} failed`,
      `buildings ${bs.buildings} in ${bs.tiles} tiles (${bs.loading} loading)`,
      `draw calls ${info.calls}   triangles ${(info.triangles / 1e6).toFixed(2)} M`,
      `sky ${sky.ready ? 'ready' : sky.error ? `error: ${sky.error}` : 'computing…'}`,
      terrain.lastError ? `last tile error: ${terrain.lastError}` : '',
      buildings.lastError ? `last building error: ${buildings.lastError}` : ''
    ].filter(Boolean))
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
