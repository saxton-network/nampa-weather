# Nampa 3D viewer

A browser 3D view of Nampa, Idaho, with real terrain, imagery, buildings and
street names, plus an overlay of the publicly mapped automated license plate
reader (ALPR) cameras in the Treasure Valley, such as Flock Safety's.
It is a static site: everything runs in the browser, with no server code.

**Live:** https://saxton-network.github.io/nampa-weather/

The repository name dates from the original plan, a simulated local-weather
overlay. That plan is parked; the camera overlay replaced it.

## What's in it

| Piece | Source | Notes |
|---|---|---|
| Terrain | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium PNG, USGS 3DEP in the US) | Streamed quadtree, elevation to z15 (about 3.5 m), with Earth curvature built in |
| Imagery | Esri World Imagery (default, to z19, about 0.2 m) or USGS National Map / NAIP (to z16) | Switchable in the panel |
| Buildings | [Overture Maps](https://overturemaps.org/) buildings, release 2026-10-21.0 | 77,803 buildings, pre-cut into 1 km tiles in `public/data/buildings/`, meshed in a Web Worker. Houses get gable or hip roofs |
| Street names | Overture Maps transportation (from OpenStreetMap) | 12,070 named road segments in `public/data/roads/`. Labels follow the roads in drone mode, stand at sign height in walk mode, and are hidden when a building blocks the view |
| ALPR cameras | OpenStreetMap nodes tagged `surveillance:type=ALPR`, mapped by the [DeFlock](https://deflock.org) community | 253 cameras across the Treasure Valley in `public/data/cameras.json`, refreshed on every deploy and daily. Each camera gets a pole, a head per direction it faces and a translucent ground wedge showing what it points at, coloured by brand. Clickable pins cluster when zoomed out |
| Sky and light | [`@takram/three-atmosphere`](https://github.com/takram-design-engineering/three-geospatial) | Physically based sky, sun and moon for the real date and time, plus aerial haze |
| Engine | three.js 0.186 + postprocessing | Logarithmic depth buffer, SMAA |

The heavy data (terrain and imagery) streams from public tile servers. Only the
building tiles (7.3 MB) and street tiles (2.2 MB) are shipped with the site.

![Plate-reader cameras over Nampa](docs/screenshots/cameras-overview.jpg)

## Using it

- **Drone mode (default):** drag to pan, right-drag (or two fingers) to rotate, scroll to zoom toward the cursor.
- **Walk mode:** press **V** or click *Walk*. Click to capture the mouse, use WASD or the arrow keys to walk, and hold Shift to run. Esc releases the mouse. On touch screens, drag to look and hold ▲ ▼ to walk.
- **Plate-reader cameras:** click a pin for its brand, facing direction(s), mount, operator and last edit, with *Fly to*, *Look from here* (walk mode at the pole, facing where the camera looks) and a link to the OpenStreetMap node. Numbered pins are clusters; click one to zoom in. Press **C** to show or hide the overlay. The top pill shows the nearest camera's distance and direction.
- **Compass** (top right): the red needle points north and the readout shows which way you are facing. Click it or press **N** to turn and face north.
- **Street names:** press **L** or use the checkbox to show or hide them. The pill at the top shows the street you are on (walk mode) or the one under the view's centre (drone mode).
- **Time slider:** sets the time of day in Boise time. *Now* returns to real time.
- **Debug panel:** press **`** or click *Debug*. It shows FPS, camera position, tile counts, draw calls and errors. A screenshot of this panel is the most useful thing to send when something looks wrong.

URL parameters, handy for sharing a view:

| Parameter | Meaning |
|---|---|
| `view` | Camera preset: `overview`, `downtown`, `neighborhood`, `street`, `mountains` |
| `t` | Time as ISO 8601, e.g. `t=2026-10-22T19:30:00Z` |
| `imagery` | `esri` or `usgs` |
| `quality` | `low` or `high` (default is `low` on touch devices) |
| `exposure` | Tone-mapping exposure (default 10) |
| `labels` | `0` hides street names |
| `cameras` | `0` hides the plate-reader cameras |
| `camera` | An OpenStreetMap node id: fly to that camera and open its card |
| `debug` | Open the debug panel |

## Running locally

Needs [Node.js](https://nodejs.org/) 20 or newer.

```sh
npm install
npm run dev        # http://localhost:5173 with live reload
npm run build      # static site in dist/, deployable to any web server
```

`dist/` uses relative paths, so it works from a subfolder or its own subdomain.

## Rebuilding the map data

```sh
python3 -I data-prep/build_buildings.py   # public/data/buildings/
python3 -I data-prep/build_roads.py       # public/data/roads/
python3 -I data-prep/build_cameras.py     # public/data/cameras.json
```

`build_cameras.py` uses only the standard library. It reads the nationwide feed
behind [DeFlock's map](https://maps.deflock.org) (built from OpenStreetMap) and
keeps the cameras inside `cameraBbox` in `src/region.json`.

These need Python 3 with `pyarrow`, `numpy` and `Pillow`. They read Overture
GeoParquet anonymously from S3 and sample ground height from the same terrain
tiles the viewer uses (cached in `data-prep/.cache/`). Shared geodesy and
terrain code lives in `data-prep/common.py`. The area and
origin are set in `src/region.json`. Set `OVERTURE_RELEASE` to use a newer
Overture release.

## Screenshots without a GPU

`tools/screenshot.mjs` renders preset views in headless Chromium with software
WebGL. Frame rates there mean nothing; use it to check that the scene renders.

```sh
npm run build && npx vite preview --port 4173 &
node tools/screenshot.mjs screenshots overview downtown street
```

## Known limits

- **Eye level is blurry.** Aerial imagery is about 0.2–0.3 m per pixel, so the ground smears when seen from 1.7 m. Procedural ground detail and lidar trees are Phase 5.
- **No collisions in walk mode.** You can walk through buildings.
- **No shadows.** The imagery has its own baked-in shadows; buildings cast none yet.
- **Building heights are mostly machine-learning estimates** from Overture/Microsoft, and the roof shapes are guesses for houses.
- **Esri imagery terms.** The public Esri endpoint is used for this personal, non-commercial project. For anything beyond that, switch to an ArcGIS Location Platform key or the USGS imagery.
- **The camera map is crowd-sourced.** Cameras that nobody has mapped are missing, and the wedges are a fixed 30 m long and 40° wide, an approximation of what a plate reader covers.
- **Mobile is untested on real hardware.** Touch devices default to `quality=low` (fewer tiles, lower pixel ratio).

## Credits

Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community ·
USGS The National Map / USDA NAIP · Terrain: AWS Terrain Tiles (USGS 3DEP, Mapzen) ·
Buildings © Overture Maps Foundation, © OpenStreetMap contributors, Microsoft, Esri Community Maps ·
ALPR locations © OpenStreetMap contributors, mapped by the DeFlock community ·
Atmosphere: takram three-geospatial (MIT).

**Data license.** The camera locations are OpenStreetMap data (ODbL 1.0).
The building and street tiles in `public/data/` are derived from
Overture Maps data. They are redistributed under the same terms:
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) for parts derived from
OpenStreetMap and [CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/) for the rest.

## Hosting

`.github/workflows/deploy-pages.yml` builds the site and publishes it to GitHub
Pages on every push to `main` and once a day. Each build first refreshes the
camera locations; if that download fails, the committed snapshot is used.
GitHub pauses scheduled runs in a repository with no activity for 60 days;
re-enable it from the Actions tab if that happens. In the repository, set Settings → Pages →
Source to **GitHub Actions** once.
