#!/usr/bin/env python3
"""Extract Overture Maps buildings for the region and write compact JSON tiles.

Each building is placed on terrain sampled from the same AWS Terrain Tiles
(terrarium, z15) the viewer streams, so footprints line up with the ground mesh.

Output: public/data/buildings/index.json plus one <i>_<j>.json per tile, where
tile (i, j) covers local east x in [i*size, (i+1)*size) and local z in
[j*size, (j+1)*size) (local z points south, matching the viewer's frame).

Run: python3 -I data-prep/build_buildings.py   (from nampa-weather/)
Needs: pyarrow, numpy, Pillow. Downloads ~25 MB of terrain tiles and reads
Overture GeoParquet anonymously from S3.
"""

import io
import json
import math
import os
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGION = json.load(open(os.path.join(ROOT, "src", "region.json")))
OUT_DIR = os.path.join(ROOT, "public", "data", "buildings")
CACHE_DIR = os.path.join(ROOT, "data-prep", ".cache")
OVERTURE_RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-10-21.0")
TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ELEV_ZOOM = REGION["terrain"]["maxElevationZoom"]

# WGS84 and the local frame (x east, y up, z south), same math as src/geo.js.
A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)


def ecef(lat, lon, h):
    lat, lon = np.radians(lat), np.radians(lon)
    n = A / np.sqrt(1 - E2 * np.sin(lat) ** 2)
    return np.stack(
        [
            (n + h) * np.cos(lat) * np.cos(lon),
            (n + h) * np.cos(lat) * np.sin(lon),
            (n * (1 - E2) + h) * np.sin(lat),
        ],
        axis=-1,
    )


O = REGION["origin"]
ORIGIN = ecef(np.array(O["lat"]), np.array(O["lon"]), np.array(O["height"]))
_phi, _lam = math.radians(O["lat"]), math.radians(O["lon"])
EAST = np.array([-math.sin(_lam), math.cos(_lam), 0.0])
NORTH = np.array([-math.sin(_phi) * math.cos(_lam), -math.sin(_phi) * math.sin(_lam), math.cos(_phi)])
UP = np.array([math.cos(_phi) * math.cos(_lam), math.cos(_phi) * math.sin(_lam), math.sin(_phi)])


def to_local(lat, lon, h):
    d = ecef(lat, lon, h) - ORIGIN
    return d @ EAST, d @ UP, -(d @ NORTH)


# --- terrain sampling -------------------------------------------------------

def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch_terrain_tile(zxy):
    z, x, y = zxy
    path = os.path.join(CACHE_DIR, f"terrarium_{z}_{x}_{y}.png")
    if not os.path.exists(path):
        for attempt in range(4):
            try:
                with urllib.request.urlopen(TERRAIN_URL.format(z=z, x=x, y=y), timeout=60) as r:
                    data = r.read()
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        with open(path, "wb") as f:
            f.write(data)
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    return zxy, rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


class Elevation:
    def __init__(self, bbox, z):
        self.z = z
        x0, y0 = tile_xy(bbox["north"], bbox["west"], z)
        x1, y1 = tile_xy(bbox["south"], bbox["east"], z)
        self.tx0, self.ty0 = int(x0), int(y0)
        tiles = [(z, x, y) for x in range(self.tx0, int(x1) + 1) for y in range(self.ty0, int(y1) + 1)]
        os.makedirs(CACHE_DIR, exist_ok=True)
        print(f"terrain: {len(tiles)} z{z} tiles", flush=True)
        with ThreadPoolExecutor(8) as pool:
            got = dict(pool.map(fetch_terrain_tile, tiles))
        nx, ny = int(x1) - self.tx0 + 1, int(y1) - self.ty0 + 1
        self.grid = np.zeros((ny * 256, nx * 256))
        for (_, x, y), e in got.items():
            gx, gy = (x - self.tx0) * 256, (y - self.ty0) * 256
            self.grid[gy:gy + 256, gx:gx + 256] = e

    def sample(self, lat, lon):
        # Pixel centres sit at +0.5, matching the viewer's bilinear sampler.
        x, y = tile_xy(lat, lon, self.z)
        px = (x - self.tx0) * 256 - 0.5
        py = (y - self.ty0) * 256 - 0.5
        ix = min(max(int(math.floor(px)), 0), self.grid.shape[1] - 2)
        iy = min(max(int(math.floor(py)), 0), self.grid.shape[0] - 2)
        fx, fy = min(max(px - ix, 0), 1), min(max(py - iy, 0), 1)
        g = self.grid
        top = g[iy, ix] * (1 - fx) + g[iy, ix + 1] * fx
        bot = g[iy + 1, ix] * (1 - fx) + g[iy + 1, ix + 1] * fx
        return top * (1 - fy) + bot * fy


# --- WKB (Polygon / MultiPolygon, outer rings only) -------------------------

def parse_wkb(buf):
    def read(off):
        bo = "<" if buf[off] == 1 else ">"
        (gtype,) = struct.unpack_from(bo + "I", buf, off + 1)
        off += 5
        gtype &= 0xFFFF
        if gtype == 3:
            (nrings,) = struct.unpack_from(bo + "I", buf, off)
            off += 4
            rings = []
            for _ in range(nrings):
                (npts,) = struct.unpack_from(bo + "I", buf, off)
                off += 4
                pts = struct.unpack_from(bo + f"{npts * 2}d", buf, off)
                off += npts * 16
                rings.append(pts)
            return [rings], off
        if gtype == 6:
            (npoly,) = struct.unpack_from(bo + "I", buf, off)
            off += 4
            polys = []
            for _ in range(npoly):
                p, off = read(off)
                polys.extend(p)
            return polys, off
        return [], off

    return read(0)[0]


# --- attribute encoding -----------------------------------------------------

ROOF = {"flat": 0, "gabled": 1, "hipped": 2, "pyramidal": 3, "skillion": 4, "dome": 5, "gambrel": 1, "mansard": 2}
RESIDENTIAL = {"house", "residential", "detached", "semidetached_house", "apartments", "bungalow", "terrace", "garage", "garages", "shed", "carport"}
COMMERCIAL = {"commercial", "retail", "industrial", "warehouse", "office", "supermarket", "service", "manufacture", "factory"}


def kind_code(subtype, cls):
    for v in (cls, subtype):
        if v in RESIDENTIAL:
            return 1
        if v in COMMERCIAL:
            return 2
    if subtype in ("civic", "education", "religious", "medical", "transportation", "agricultural"):
        return 3
    return 0


def color_code(c):
    if not c or not isinstance(c, str):
        return None
    c = c.strip().lstrip("#")
    if len(c) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in c):
        return int(c, 16)
    return None


def main():
    t0 = time.time()
    bbox = REGION["buildingBbox"]
    size = REGION["buildingTileSize"]
    elev = Elevation(bbox, ELEV_ZOOM)

    s3 = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    dataset = ds.dataset(
        f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme=buildings/type=building/",
        filesystem=s3,
        format="parquet",
    )
    wanted = ["id", "geometry", "height", "min_height", "num_floors", "subtype", "class",
              "roof_shape", "roof_color", "facade_color", "is_underground"]
    cols = [c for c in wanted if c in dataset.schema.names]
    filt = (
        (pc.field("bbox", "xmin") > bbox["west"]) & (pc.field("bbox", "xmax") < bbox["east"])
        & (pc.field("bbox", "ymin") > bbox["south"]) & (pc.field("bbox", "ymax") < bbox["north"])
    )
    print(f"overture {OVERTURE_RELEASE}: reading {len(cols)} columns...", flush=True)
    table = dataset.to_table(columns=cols, filter=filt)
    rows = table.to_pylist()
    print(f"overture: {len(rows)} buildings in bbox ({time.time() - t0:.0f}s)", flush=True)

    tiles = {}
    skipped = 0
    for r in rows:
        if r.get("is_underground"):
            skipped += 1
            continue
        polys = parse_wkb(r["geometry"])
        if not polys:
            skipped += 1
            continue
        for rings in polys:
            outer = np.array(rings[0]).reshape(-1, 2)
            if len(outer) < 4:
                continue
            outer = outer[:-1]  # drop closing point
            lon, lat = outer[:, 0], outer[:, 1]
            clat, clon = float(lat.mean()), float(lon.mean())
            base = elev.sample(clat, clon)
            x, _, z = to_local(lat, lon, np.full_like(lat, base))
            _, cy, _ = to_local(np.array(clat), np.array(clon), np.array(base))
            # Signed area (x east, z south): make rings counter-clockwise in (x, -z).
            area = 0.5 * np.sum(x * np.roll(-z, -1) - np.roll(x, -1) * -z)
            if abs(area) < 4:
                skipped += 1
                continue
            if area < 0:
                x, z = x[::-1], z[::-1]
            cx, cz = float(x.mean()), float(z.mean())
            i, j = math.floor(cx / size), math.floor(cz / size)
            ox, oz = i * size, j * size

            h = r.get("height")
            floors = r.get("num_floors")
            est = 0
            if h is None or h <= 0:
                est = 1
                h = floors * 3.2 if floors else (4.5 if abs(area) < 300 else 6.0)
            minh = r.get("min_height") or 0.0
            roof = ROOF.get(r.get("roof_shape") or "", -1)
            ring = np.column_stack([np.round((x - ox) * 10), np.round((z - oz) * 10)]).astype(int).ravel().tolist()
            rec = [round(float(cy), 2), round(float(h), 1), round(float(minh), 1), kind_code(r.get("subtype"), r.get("class")), roof, est, ring]
            fc, rc = color_code(r.get("facade_color")), color_code(r.get("roof_color"))
            if fc is not None or rc is not None:
                rec += [fc, rc]
            tiles.setdefault((i, j), []).append(rec)

    os.makedirs(OUT_DIR, exist_ok=True)
    for f in os.listdir(OUT_DIR):
        if f.endswith(".json"):
            os.remove(os.path.join(OUT_DIR, f))
    index = []
    total = 0
    for (i, j), recs in sorted(tiles.items()):
        with open(os.path.join(OUT_DIR, f"{i}_{j}.json"), "w") as f:
            json.dump({"i": i, "j": j, "size": size, "b": recs}, f, separators=(",", ":"))
        index.append([i, j, len(recs)])
        total += len(recs)
    with open(os.path.join(OUT_DIR, "index.json"), "w") as f:
        json.dump({
            "source": f"Overture Maps Foundation buildings, release {OVERTURE_RELEASE}",
            "attribution": "© Overture Maps Foundation, © OpenStreetMap contributors, Microsoft, Esri Community Maps",
            "fields": ["baseY", "height", "minHeight", "kind", "roof", "heightEstimated", "ringDecimeters", "facadeColor?", "roofColor?"],
            "tileSize": size,
            "tiles": index,
        }, f, separators=(",", ":"))
    print(f"wrote {total} buildings in {len(index)} tiles, skipped {skipped} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    sys.exit(main())
