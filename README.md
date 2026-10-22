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
| Ground | Generated. Ground types are classified from USDA NAIP aerial photos (public domain) and corrected with Overture water, land use and land cover | `public/tiles/landcover/`: one ground type per pixel (lawn, trees, dry scrub, dirt, asphalt, concrete, water, crops, plowed field, sand, pool) at about 0.9 m (z17) over Nampa, 7 m across the Treasure Valley, 38 m out to the mountains. A shader paints each type with procedural detail that stays sharp up close. The photos themselves are not shipped |
| Roads on the ground | Overture transportation (OpenStreetMap) | Every road, driveway, parking aisle, alley and path is painted into the ground at a width set by its type, with sidewalks, yellow centre lines and white edge and lane lines |
| Trees | Seeded wherever the photos show canopy | Low-poly round trees and conifers, about 8 m apart, kept off roads, buildings and water, in `public/data/trees/`. Drawn within about 1 km below 600 m altitude |
| Terrain | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium encoding, USGS 3DEP) | Snapshot saved in `public/tiles/elevation/`: about 3.5 m (z15) over Nampa, coarser beyond. Streamed as a quadtree with Earth curvature built in |
| Buildings | [Overture Maps](https://overturemaps.org/) buildings, release 2026-10-21.0 | 77,803 buildings, pre-cut into 1 km tiles in `public/data/buildings/`, meshed in a Web Worker. Houses get gable or hip roofs |
| Street names | Overture Maps transportation (from OpenStreetMap) | 12,070 named road segments in `public/data/roads/`. Labels follow the roads in drone mode, stand at sign height in walk mode, and are hidden when a building blocks the view |
| ALPR cameras | OpenStreetMap nodes tagged `surveillance:type=ALPR`, mapped by the [DeFlock](https://deflock.org) community | 253 cameras across the Treasure Valley in `public/data/cameras.json`, refreshed on every deploy and daily. Each camera gets a pole, a head per direction it faces and a translucent ground wedge showing what it points at, coloured by brand. Clickable pins cluster when zoomed out |
| Facades | Generated from each building's Overture type and height | Walls get windows, doors and shopfronts from the building's type and height, drawn by a shader so they cost no geometry |
| Shadows | Sun shadow map | Buildings and trees cast shadows on the ground, walls and each other within a box around the view |
| Sky and light | [`@takram/three-atmosphere`](https://github.com/takram-design-engineering/three-geospatial) | Physically based sky and aerial haze, with the sun fixed at a mid-July late afternoon (`snapshot.sunTime` in `src/region.json`) for long shadows and warm light |
| Engine | three.js 0.186 + postprocessing | Logarithmic depth buffer, SMAA |

**The scene is a frozen snapshot with its own look.** Nothing photographic is
shown: the ground, roads and trees are generated from what the aerial photos
and map data say is there. Ground maps, terrain, buildings, streets and trees
are all saved in the site itself, and the lighting never changes, so a
visitor's browser makes no requests to outside servers. Only the camera
locations are refreshed, at build time.

![A Nampa neighbourhood: generated ground, trees and houses](docs/screenshots/neighborhood.jpg)

## Using it

- **Drone mode (default):** drag to pan, right-drag (or two fingers) to rotate, scroll to zoom toward the cursor.
- **Walk mode:** press **V** or click *Walk*. Click to capture the mouse, then WASD or the arrow keys to walk, Shift to run and Space to jump; buildings are solid. Esc releases the mouse. On touch screens, drag to look and hold ▲ ▼ to walk.
- **Plate-reader cameras:** click a pin for its brand, facing direction(s), mount, operator and last edit, with *Fly to*, *Look from here* (walk mode at the pole, facing where the camera looks) and a link to the OpenStreetMap node. Numbered pins are clusters; click one to zoom in. Press **C** to show or hide the overlay. The top pill shows the nearest camera's distance and direction.
- **Compass** (top right): the red needle points north and the readout shows which way you are facing. Click it or press **N** to turn and face north.
- **Street names:** press **L** or use the checkbox to show or hide them. The pill at the top shows the street you are on (walk mode) or the one under the view's centre (drone mode).
- **Debug panel:** press **`** or click *Debug*. It shows FPS, camera position, tile counts, draw calls and errors. A screenshot of this panel is the most useful thing to send when something looks wrong.

URL parameters, handy for sharing a view:

| Parameter | Meaning |
|---|---|
| `view` | Camera preset: `overview`, `downtown`, `neighborhood`, `street`, `mountains` |
| `quality` | `low` or `high` (default is `low` on touch devices) |
| `exposure` | Tone-mapping exposure (default 10) |
| `labels` | `0` hides street names |
| `cameras` | `0` hides the plate-reader cameras |
| `at` | `lat,lon[,distance,heading,pitch]`: open a drone view of any spot, e.g. `at=43.5797,-116.5622,150,45,-25` |
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
python3 -I data-prep/build_snapshot.py    # elevation + NAIP photos (photos stay in data-prep/.cache)
python3 -I data-prep/build_landcover.py   # public/tiles/landcover/, public/data/trees/, coverage.json
```

`build_snapshot.py` exports NAIP from the USGS image service in blocks of up
to 3,840 px (splitting a block when the service times out) and cuts them into
tiles in `data-prep/.cache/naip-tiles/`, and re-encodes the AWS elevation tiles
as lossless WebP in `public/tiles/elevation/` (heights rounded to 1/8 m). Which
zooms cover which area is set by `snapshot` in `src/region.json`. A full run can
take an hour when the USGS service is busy, and can be restarted where it stopped.

`build_landcover.py` sorts every photo pixel into a ground type by colour and
local texture, using Overture land cover to tell town from fields and natural
ground, burns in Overture water, canals, pools, farmland and golf features,
fills shadows from their surroundings, and clears photographed asphalt along
roads the viewer paints itself. It also seeds the trees. It writes
`public/tiles/coverage.json`, which tells the viewer which tiles exist.

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

- **The ground types are automatic guesses.** The classifier reads colour and texture only, so some roofs, shadows and dry lawns land in the wrong type, and ground-type edges are only as fine as the 0.9 m photos. Roads, which come from map data, are exact.
- **No collisions in walk mode.** You can walk through buildings.
- **No shadows.** Buildings and trees cast none yet.
- **Building heights are mostly machine-learning estimates** from Overture/Microsoft, and the roof shapes are guesses for houses.
- **The ground is a snapshot.** It reflects whenever NAIP last flew Idaho, and new construction since then is missing. Rerun the two snapshot scripts to refresh it.
- **The camera map is crowd-sourced.** Cameras that nobody has mapped are missing, and the wedges are a fixed 30 m long and 40° wide, an approximation of what a plate reader covers.
- **Mobile is untested on real hardware.** Touch devices default to `quality=low` (fewer tiles, lower pixel ratio).

## Credits

Ground generated from USDA NAIP via USGS The National Map (public domain) ·
Terrain: USGS 3DEP via AWS Terrain Tiles ·
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
