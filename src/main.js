import './style.css'
import { PerspectiveCamera, Scene, Timer, Vector3, WebGLRenderer } from 'three'
import { Buildings } from './buildings.js'
import { BRANDS, Cameras, cardinal, describeCamera } from './cameras.js'
import { DroneControls, WalkControls, cameraHeading, groundHeightBelow } from './controls.js'
import { geodeticToLocal } from './geo.js'
import region from './region.json'
import { Sky } from './sky.js'
import { RoadTiles } from './roads.js'
import { Streets } from './streets.js'
import { Terrain } from './terrain.js'
import { Trees } from './trees.js'
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

const roads = new RoadTiles()
const terrain = new Terrain(renderer, {
  roads,
  sseThreshold: lowQuality ? 1.6 : 1.0,
  maxTiles: lowQuality ? 350 : 700
})
scene.add(terrain.group)
const buildings = new Buildings()
scene.add(buildings.group)
const trees = new Trees()
scene.add(trees.group)
const sky = new Sky(renderer, scene, camera)

const drone = new DroneControls(camera, renderer.domElement, terrain)
const walk = new WalkControls(camera, renderer.domElement, terrain)
let mode = 'drone'

// The scene is a frozen snapshot: one fixed sun position, close to when the
// summer aerial imagery was flown, so the lighting matches its shadows.
const SUN_TIME = new Date(region.snapshot.sunTime)
sky.setDate(SUN_TIME)

const ui = new UI({
  presets: PRESETS,
  legend: BRANDS.map((b) => ({ label: b.label.replace(' Solutions', ''), color: `#${b.color.toString(16).padStart(6, '0')}` })),
  onMode: setMode,
  onPreset: (k) => applyPreset(PRESETS[k]),
  onTouchMove: (dir) => (walk.touchMove = dir),
  onFaceNorth: () => (mode === 'walk' ? walk.faceNorth() : drone.faceNorth()),
  onLabels: (on) => (streets.visible = on),
  onCameras: (on) => (cameras.visible = on)
})
const streets = new Streets(ui.root, roads)
if (params.get('labels') === '0') {
  streets.visible = false
  ui.labelsBox.checked = false
}

// --- plate-reader cameras ---------------------------------------------------
const cameras = new Cameras(ui.root, terrain)
scene.add(cameras.group)
if (params.get('cameras') === '0') {
  cameras.visible = false
  ui.camerasBox.checked = false
}

const formatDistance = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`)

function cameraPoint(cam) {
  return cam.placedZoom >= 0 ? cam.position.clone() : groundPoint(cam.lat, cam.lon)
}

function flyToCamera(cam) {
  if (mode === 'walk') setMode('drone')
  const look = (cam.directions[0] ?? 0) + 140
  drone.lookAt(cameraPoint(cam), { distance: 55, heading: look, pitch: -32 })
  cameras.select(cam)
}

function standAtCamera(cam) {
  setMode('walk', { at: cameraPoint(cam), heading: cam.directions[0] ?? 0 })
  cameras.select(cam)
}

cameras.onSelect = (cam) => {
  if (!cam) return ui.hideCard()
  const info = describeCamera(cam)
  const p = cameraPoint(cam)
  const from = mode === 'walk' ? camera.position : drone.controls.target
  const dx = p.x - from.x
  const dz = p.z - from.z
  const d = Math.hypot(dx, dz)
  if (d > 15) info.rows.push(['Distance', `${formatDistance(d)} ${cardinal((Math.atan2(dx, -dz) * 180) / Math.PI)} of the view`])
  if (cameras.meta?.generated) {
    info.rows.push(['Data as of', new Date(cameras.meta.generated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })])
  }
  ui.showCard(info, [
    ['Fly to', () => flyToCamera(cam)],
    ['Look from here', () => standAtCamera(cam)],
    ['OpenStreetMap', `https://www.openstreetmap.org/node/${cam.id}`, 'link']
  ])
}
ui.onCardClose = () => cameras.select(null)
cameras.onCluster = (hit) => {
  if (mode === 'walk') setMode('drone')
  const c = new Vector3()
  for (const m of hit.members) c.add(cameraPoint(m))
  c.divideScalar(hit.members.length)
  const dist = Math.max(camera.position.distanceTo(drone.controls.target) / 3, 250)
  const dir = new Vector3().subVectors(drone.controls.target, camera.position)
  const heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI
  drone.lookAt(c, { distance: dist, heading, pitch: -45 })
}
cameras.ready.then(() => {
  ui.setCameraCount(String(cameras.list.length))
  const wanted = cameras.byId(params.get('camera'))
  if (wanted) flyToCamera(wanted)
})

const MAP_DATA_CREDIT = 'Streets and buildings © OpenStreetMap contributors, Overture Maps Foundation, Microsoft, Esri Community Maps'
const CAMERA_CREDIT = 'ALPR locations © OpenStreetMap contributors via DeFlock'

function updateCredits() {
  ui.setCredits([...(terrain.credits ?? []), MAP_DATA_CREDIT, CAMERA_CREDIT])
}
updateCredits()
terrain.ready.then(updateCredits)

// --- camera modes -----------------------------------------------------------
function groundPoint(lat, lon) {
  const h = terrain.heightAt(lat, lon) ?? 770
  return geodeticToLocal(lat, lon, h)
}

function setMode(next, { at, heading } = {}) {
  if (next === mode && !at) return
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

// ?at=lat,lon[,distance,heading,pitch] opens a drone view of any spot.
const at = params.get('at')?.split(',').map(Number)
const atView = at?.length >= 2 && at.every(Number.isFinite)
  ? { lat: at[0], lon: at[1], distance: at[2] ?? 150, heading: at[3] ?? 0, pitch: at[4] ?? -30 }
  : null
applyPreset(atView ?? PRESETS[params.get('view')] ?? PRESETS.overview)
ui.setMode(mode)

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

const occludedByBuildings = (x0, z0, x1, z1) => buildings.blocks(x0, z0, x1, z1)

// --- main loop --------------------------------------------------------------
const timer = new Timer()
const fps = { frames: 0, last: performance.now(), value: 0, ms: 0 }
let idleFrames = 0
let lastHere = 0
// Exposed for tools/screenshot.mjs and for poking at things from the console.
window.__nampa = { ready: false, camera, terrain: () => terrain, buildings, streets, cameras, trees, sky }

function frame(timestamp) {
  timer.update(timestamp)
  const dt = Math.min(timer.getDelta(), 0.1)
  renderer.info.reset()
  const t0 = performance.now()

  if (mode === 'walk') walk.update(dt)
  else drone.update(dt)

  const below = groundHeightBelow(terrain, camera.position)
  const agl = below?.agl ?? 500
  // Near plane scales with altitude; the log depth buffer covers the rest.
  camera.near = mode === 'walk' ? 0.3 : Math.min(Math.max(agl / 20, 0.5), 50)
  camera.updateProjectionMatrix()

  terrain.update(camera)
  buildings.update(camera.position, agl)
  trees.update(camera.position, agl)
  sky.render(dt)
  streets.update(camera, { mode, agl, width: innerWidth, height: innerHeight, occluded: occludedByBuildings })
  cameras.update(camera, { mode, agl, width: innerWidth, height: innerHeight })
  ui.setHeading(cameraHeading(camera))
  if (t0 - lastHere > 250) {
    lastHere = t0
    const walking = mode === 'walk'
    const at = walking ? camera.position : drone.controls.target
    const street = walking || agl < 1500 ? streets.nearest(at, walking ? 40 : 60) : null
    const near = cameras.visible ? cameras.nearest(at) : null
    const camText = !near || near.distance > 20000
      ? null
      : near.distance < 15
        ? 'plate reader here'
        : `nearest plate reader ${formatDistance(near.distance)} ${cardinal(near.bearing)}`
    ui.setHere(street, walking ? 'On' : 'Near', camText)
  }

  const busy = terrain.loading + terrain.needed.size + buildings.loading + streets.loading + trees.loading + (cameras.visible ? cameras.pending : 0)
  idleFrames = busy === 0 && sky.ready ? idleFrames + 1 : 0
  window.__nampa.ready = idleFrames > 30

  fps.frames++
  fps.ms = fps.ms * 0.9 + (performance.now() - t0) * 0.1
  const now = performance.now()
  if (now - fps.last > 500) {
    fps.value = (fps.frames * 1000) / (now - fps.last)
    fps.frames = 0
    fps.last = now
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
      `buildings ${bs.buildings} in ${bs.tiles} tiles (${bs.loading} loading)   trees ${trees.count}`,
      `cameras ${cameras.list.length} loaded, ${cameras.list.filter((c) => c.placedZoom >= 0).length} placed, ${cameras.shown ?? 0} pins`,
      `street labels ${streets.shown ?? 0} shown, ${[...streets.tiles.values()].filter((t) => typeof t === 'object').length} tiles loaded`,
      `draw calls ${info.calls}   triangles ${(info.triangles / 1e6).toFixed(2)} M`,
      `sky ${sky.ready ? 'ready' : sky.error ? `error: ${sky.error}` : 'computing…'}`,
      terrain.lastError ? `last tile error: ${terrain.lastError}` : '',
      buildings.lastError ? `last building error: ${buildings.lastError}` : '',
      streets.lastError ? `last street error: ${streets.lastError}` : '',
      cameras.lastError ? `last camera error: ${cameras.lastError}` : '',
      trees.lastError ? `last tree error: ${trees.lastError}` : ''
    ].filter(Boolean))
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
