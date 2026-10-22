#!/usr/bin/env python3
"""Bake the imagery and elevation tiles the viewer needs into public/tiles/.

The site then serves everything itself; visitors' browsers make no requests to
outside tile servers.

  Imagery:   USDA NAIP via the USGS National Map image service (public domain),
             exported in large blocks and cut into 256 px Web Mercator tiles,
             saved as WebP (quality 80).
  Elevation: AWS Terrain Tiles (terrarium encoding, USGS 3DEP in the US),
             re-encoded as lossless WebP with heights rounded to 1/8 m.

Which zooms cover which area is set by region.json "snapshot". The script writes
public/tiles/coverage.json, which the viewer reads to know which tiles exist.
Downloads are cached in data-prep/.cache/, and existing tiles are skipped, so
an interrupted run can simply be restarted.

Run: python3 -I data-prep/build_snapshot.py   (from the repository root)
"""

import io
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import CACHE_DIR, REGION, ROOT, TERRAIN_URL, tile_xy

OUT = os.path.join(ROOT, "public", "tiles")
NAIP_URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
BLOCK = 15  # tiles per side per export request (service limit is 4000 px)
EARTH = 2 * math.pi * 6378137
WORKERS = 2


def fetch(url, timeout=600, attempts=5):
    req = urllib.request.Request(url, headers={"User-Agent": "nampa-weather-viewer (github.com/saxton-network/nampa-weather)"})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as err:
            if attempt == attempts - 1:
                raise
            print(f"  retry {attempt + 1}: {err}", flush=True)
            time.sleep(5 * 2 ** attempt)


def root_bbox():
    t = REGION["terrain"]
    z, r = t["rootZoom"], t["rootRadiusTiles"]
    cx, cy = (int(v) for v in tile_xy(REGION["origin"]["lat"], REGION["origin"]["lon"], z))
    lon = lambda x: x / 2 ** z * 360 - 180
    lat = lambda y: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2 ** z))))
    return {"west": lon(cx - r), "east": lon(cx + r + 1), "north": lat(cy - r), "south": lat(cy + r + 1)}


def tile_range(bbox, z):
    """Inclusive tile range [x0, x1, y0, y1] covering bbox at zoom z."""
    eps = 1e-9
    x0, y0 = tile_xy(bbox["north"] - eps, bbox["west"] + eps, z)
    x1, y1 = tile_xy(bbox["south"] + eps, bbox["east"] - eps, z)
    return [int(x0), int(x1), int(y0), int(y1)]


def tiers(kind):
    out = []
    for t in REGION["snapshot"][kind]:
        bbox = root_bbox() if t["bbox"] == "roots" else t["bbox"]
        for z in range(t["zooms"][0], t["zooms"][1] + 1):
            out.append((z, tile_range(bbox, z), t["name"]))
    return out


def tile_path(kind, z, x, y):
    return os.path.join(OUT, kind, str(z), str(x), f"{y}.webp")


# --- imagery -----------------------------------------------------------------

def export_block(z, bx, by, nx, ny):
    """One NAIP export covering tiles [bx, bx+nx) x [by, by+ny) at zoom z."""
    s = EARTH / 2 ** z
    x0 = -EARTH / 2 + bx * s
    y1 = EARTH / 2 - by * s
    cache = os.path.join(CACHE_DIR, "naip", f"{z}_{bx}_{by}_{nx}_{ny}.jpg")
    if not os.path.exists(cache):
        q = {
            "bbox": f"{x0},{y1 - ny * s},{x0 + nx * s},{y1}",
            "bboxSR": 3857,
            "imageSR": 3857,
            "size": f"{nx * 256},{ny * 256}",
            "format": "jpg",
            "compressionQuality": 92,
            "interpolation": "RSP_BilinearInterpolation",
            "renderingRule": json.dumps({"rasterFunction": "NaturalColor"}),
            "f": "image",
        }
        try:
            data = fetch(f"{NAIP_URL}?{urllib.parse.urlencode(q)}", attempts=3)
            if data[:2] != b"\xff\xd8":
                raise RuntimeError(f"not a JPEG: {data[:200]!r}")
        except Exception as err:
            # The service times out on some large mosaics; retry as quarters.
            if nx == 1 and ny == 1:
                raise
            print(f"  block z{z} {bx},{by} {nx}x{ny} failed ({err}); splitting", flush=True)
            hx, hy = (nx + 1) // 2, (ny + 1) // 2
            parts = [(bx, by, hx, hy), (bx + hx, by, nx - hx, hy), (bx, by + hy, hx, ny - hy), (bx + hx, by + hy, nx - hx, ny - hy)]
            return sum(export_block(z, px, py, pw, ph) for px, py, pw, ph in parts if pw > 0 and ph > 0)
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        with open(cache, "wb") as f:
            f.write(data)
    im = Image.open(cache).convert("RGB")
    written = 0
    for j in range(ny):
        for i in range(nx):
            path = tile_path("imagery", z, bx + i, by + j)
            if os.path.exists(path):
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            im.crop((i * 256, j * 256, i * 256 + 256, j * 256 + 256)).save(path, "WEBP", quality=80, method=6)
            written += 1
    return written


def build_imagery():
    jobs = []
    for z, (x0, x1, y0, y1), name in tiers("imagery"):
        for by in range(y0, y1 + 1, BLOCK):
            for bx in range(x0, x1 + 1, BLOCK):
                nx = min(BLOCK, x1 + 1 - bx)
                ny = min(BLOCK, y1 + 1 - by)
                done = all(os.path.exists(tile_path("imagery", z, bx + i, by + j)) for i in range(nx) for j in range(ny))
                if not done:
                    jobs.append((z, bx, by, nx, ny))
    print(f"imagery: {len(jobs)} blocks to export", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        for k, n in enumerate(pool.map(lambda j: export_block(*j), jobs), 1):
            if k % 5 == 0 or k == len(jobs):
                print(f"  {k}/{len(jobs)} blocks ({time.time() - t0:.0f}s)", flush=True)


# --- elevation ---------------------------------------------------------------

def elevation_tile(zxy):
    z, x, y = zxy
    path = tile_path("elevation", z, x, y)
    if os.path.exists(path):
        return
    cache = os.path.join(CACHE_DIR, f"terrarium_{z}_{x}_{y}.png")
    if not os.path.exists(cache):
        data = fetch(TERRAIN_URL.format(z=z, x=x, y=y), timeout=120)
        with open(cache, "wb") as f:
            f.write(data)
    a = np.asarray(Image.open(cache).convert("RGB")).copy()
    a[..., 2] &= 0xE0  # round the fractional metre to 1/8 m; compresses ~3x better
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(a).save(path, "WEBP", lossless=True, method=6)


def build_elevation():
    jobs = [(z, x, y) for z, (x0, x1, y0, y1), _ in tiers("elevation") for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    print(f"elevation: {len(jobs)} tiles", flush=True)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(elevation_tile, jobs))


def main():
    t0 = time.time()
    build_elevation()
    build_imagery()
    coverage = {"imagery": {}, "elevation": {}}
    for kind in coverage:
        for z, rng, _ in tiers(kind):
            coverage[kind][str(z)] = rng
    coverage["imageryCredit"] = "Imagery: USDA NAIP via USGS The National Map (public domain)"
    coverage["elevationCredit"] = "Terrain: USGS 3DEP via AWS Terrain Tiles"
    with open(os.path.join(OUT, "coverage.json"), "w") as f:
        json.dump(coverage, f, indent=1)
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(OUT) for f in fs)
    count = sum(len(fs) for _, _, fs in os.walk(OUT))
    print(f"done: {count} files, {size / 1e6:.0f} MB in public/tiles ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    sys.exit(main())
