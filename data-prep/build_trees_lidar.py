#!/usr/bin/env python3
"""Place trees where they really are, from the 2018 USGS 3DEP lidar survey.

The ID_SouthernID_21_2018 point cloud (Entwine EPT on the usgs-lidar-public
bucket, Web Mercator) covers Nampa at several points per square metre. This
script reduces it to a canopy height model on the z17 Web Mercator pixel grid
(about 0.87 m, the same grid as the ground-type tiles):

  top    highest non-noise return per pixel
  ground lowest ground-classified return per pixel, gaps filled from coarser levels
  height top - ground, with building footprints (Overture, +2 px) removed

Tree tops are local maxima of that height (window grows with height), kept
only where enough canopy surrounds them, which drops power lines and poles.
Each tree gets its measured height, a crown radius measured from the canopy
(capped by the distance to its neighbours), and a conifer flag for tall,
narrow crowns.

Outputs
  public/data/trees/<i>_<j>.bin  per 1 km tile of the building grid, 12-byte records:
      int16 x_dm, int16 z_dm (from the tile origin), float32 base_y,
      uint8 height (0.2 m units), uint8 crown radius (0.1 m units),
      uint8 flags (1 = conifer), uint8 seed
  public/data/trees/index.json
  data-prep/.cache/chm/17/<x>/<y>.png  canopy height per z17 tile (0.2 m units),
      used by build_landcover.py to correct its ground types

Run: python3 -I data-prep/build_trees_lidar.py   (needs laspy and lazrs)
"""

import io
import json
import math
import os
import struct
import sys
import time
import urllib.request
from concurrent.futures import ProcessPoolExecutor

import warnings

import numpy as np
import laspy
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (CACHE_DIR, ELEV_ZOOM, OVERTURE_BUCKET, OVERTURE_RELEASE, REGION, ROOT, Elevation,
                    parse_wkb, to_local)

EPT = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/ID_SouthernID_21_2018"
TREES = os.path.join(ROOT, "public", "data", "trees")
CHM_DIR = os.path.join(CACHE_DIR, "chm")
Z = 17
N = 2 ** Z
HALF = 20037508.342789244
PX = 2 * HALF / N / 256  # metres (Mercator) per pixel
Z_BASE = 600.0  # heights are stored as uint16 decimetres above this
NO_GROUND = 65535
CHUNK = 2048  # pixels, a multiple of 256 so chunks align with z17 tiles
HALO = 64


def fetch(url, timeout=120):
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 * 2 ** attempt)


# --- grid ------------------------------------------------------------------------

def grid():
    bb = REGION["buildingBbox"]
    if os.environ.get("TREES_BBOX"):  # "west,south,east,north" for test runs
        bb = dict(zip(("west", "south", "east", "north"), map(float, os.environ["TREES_BBOX"].split(","))))
    x0 = math.floor((bb["west"] + 180) / 360 * N) * 256
    x1 = math.ceil((bb["east"] + 180) / 360 * N) * 256
    y0 = math.floor((1 - math.asinh(math.tan(math.radians(bb["north"]))) / math.pi) / 2 * N) * 256
    y1 = math.ceil((1 - math.asinh(math.tan(math.radians(bb["south"]))) / math.pi) / 2 * N) * 256
    return x0, y0, x1 - x0, y1 - y0  # global z17 pixel origin and size


GX, GY, GW, GH = grid()


def px_to_mercator(gx, gy):
    return gx * PX - HALF, HALF - gy * PX


# --- EPT ---------------------------------------------------------------------------

def ept_nodes():
    info = json.loads(fetch(f"{EPT}/ept.json"))
    b = info["bounds"]
    qx0, qy1 = px_to_mercator(GX, GY)
    qx1, qy0 = px_to_mercator(GX + GW, GY + GH)
    hier = {}

    def load(key):
        h = json.loads(fetch(f"{EPT}/ept-hierarchy/{'-'.join(map(str, key))}.json"))
        hier.update({tuple(map(int, k.split("-"))): v for k, v in h.items()})

    load((0, 0, 0, 0))
    todo, nodes = [(0, 0, 0, 0)], []
    while todo:
        k = todo.pop()
        if k not in hier:
            continue
        if hier[k] == -1:
            load(k)
        d, x, y, z = k
        s = (b[3] - b[0]) / 2 ** d
        nx0, ny0 = b[0] + x * s, b[1] + y * s
        if nx0 + s < qx0 or nx0 > qx1 or ny0 + s < qy0 or ny0 > qy1:
            continue
        if hier[k] > 0:
            nodes.append((k, hier[k]))
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    todo.append((d + 1, 2 * x + dx, 2 * y + dy, 2 * z + dz))
    return nodes


def reduce_node(key):
    """Download one EPT node and reduce it to per-pixel top and ground (uint16 dm)."""
    las = laspy.read(io.BytesIO(fetch(f"{EPT}/ept-data/{'-'.join(map(str, key))}.laz")))
    x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
    cls = np.asarray(las.classification)
    ix = np.floor((x + HALF) / PX).astype(np.int64) - GX
    iy = np.floor((HALF - y) / PX).astype(np.int64) - GY
    keep = (ix >= 0) & (ix < GW) & (iy >= 0) & (iy < GH) & (cls != 7) & (cls != 18)
    if not keep.any():
        return None
    ix, iy, z, cls = ix[keep], iy[keep], z[keep], cls[keep]
    zq = np.clip((z - Z_BASE) * 10, 1, 65534).astype(np.uint16)
    x0, y0 = int(ix.min()), int(iy.min())
    w, h = int(ix.max()) - x0 + 1, int(iy.max()) - y0 + 1
    top = np.zeros((h, w), np.uint16)
    np.maximum.at(top, (iy - y0, ix - x0), zq)
    ground = np.full((h, w), NO_GROUND, np.uint16)
    g = cls == 2
    if g.any():
        np.minimum.at(ground, (iy[g] - y0, ix[g] - x0), zq[g])
    return x0, y0, top, ground, len(z)


# --- raster helpers --------------------------------------------------------------

def max_filter(a, r):
    """Square maximum filter of radius r (separable, edges padded with -inf)."""
    p = np.pad(a, r, constant_values=-np.inf)
    rows = p[:, : p.shape[1] - 2 * r].copy()
    for k in range(1, 2 * r + 1):
        np.maximum(rows, p[:, k: k + p.shape[1] - 2 * r], out=rows)
    out = rows[: rows.shape[0] - 2 * r].copy()
    for k in range(1, 2 * r + 1):
        np.maximum(out, rows[k: k + rows.shape[0] - 2 * r], out=out)
    return out


def box_sum(a, r):
    p = np.pad(a, r + 1)
    c = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k])[: a.shape[0], : a.shape[1]]


def fill_ground(g):
    """Fill NaN holes in a ground raster from successively coarser averages."""
    levels = [g]
    while min(levels[-1].shape) > 8:
        a = levels[-1]
        h, w = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
        b = a[:h, :w].reshape(h // 2, 2, w // 2, 2)
        with np.errstate(invalid="ignore"):
            levels.append(np.nanmean(b, axis=(1, 3)))
    for k in range(len(levels) - 2, -1, -1):
        fine, coarse = levels[k], levels[k + 1]
        up = np.repeat(np.repeat(coarse, 2, 0), 2, 1)
        up = np.pad(up, ((0, fine.shape[0] - up.shape[0]), (0, fine.shape[1] - up.shape[1])), mode="edge")
        levels[k] = np.where(np.isnan(fine), up, fine)
    return levels[0]


def load_buildings():
    bb = REGION["buildingBbox"]
    s3 = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    d = ds.dataset(f"{OVERTURE_BUCKET}/{OVERTURE_RELEASE}/theme=buildings/type=building/", filesystem=s3, format="parquet")
    f = ((pc.field("bbox", "xmax") > bb["west"]) & (pc.field("bbox", "xmin") < bb["east"])
         & (pc.field("bbox", "ymax") > bb["south"]) & (pc.field("bbox", "ymin") < bb["north"]))
    polys = []
    for r in d.to_table(columns=["geometry"], filter=f).to_pylist():
        for rings in parse_wkb(r["geometry"]):
            p = np.array(rings[0]).reshape(-1, 2)
            gx = (p[:, 0] + 180) / 360 * N * 256 - GX
            gy = (1 - np.arcsinh(np.tan(np.radians(p[:, 1]))) / math.pi) / 2 * N * 256 - GY
            polys.append(np.column_stack([gx, gy]))
    bbx = np.array([[p[:, 0].min(), p[:, 0].max(), p[:, 1].min(), p[:, 1].max()] for p in polys])
    return polys, bbx


def building_mask(polys, bbx, x0, y0, w, h):
    img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(img)
    hit = np.nonzero((bbx[:, 1] >= x0) & (bbx[:, 0] <= x0 + w) & (bbx[:, 3] >= y0) & (bbx[:, 2] <= y0 + h))[0]
    for k in hit:
        p = polys[k] - (x0, y0)
        draw.polygon([tuple(v) for v in p.tolist()], fill=255, outline=255)
    m = np.asarray(img) > 0
    return max_filter(m.astype(np.float32), 2) > 0  # 2 px margin around walls


# --- detection --------------------------------------------------------------------

def detect(chm, inner):
    """Tree tops in a height raster: (row, col, height, crown_radius_px)."""
    support = box_sum((chm > 2.0).astype(np.float32), 2)
    m2, m3, m4 = max_filter(chm, 2), max_filter(chm, 3), max_filter(chm, 4)
    peak = np.where(chm < 6, chm >= m2, np.where(chm < 12, chm >= m3, chm >= m4))
    cand = peak & (chm >= 3.0) & (support >= 10) & inner
    ys, xs = np.nonzero(cand)
    hs = chm[ys, xs]
    order = np.argsort(-hs)
    # Greedy suppression of plateau duplicates within 2.5 px.
    taken = {}
    tops = []
    for k in order:
        y, x, hgt = int(ys[k]), int(xs[k]), float(hs[k])
        cy, cx = y // 3, x // 3
        if any(
            (y - ty) ** 2 + (x - tx) ** 2 < 6.25
            for dy in (-1, 0, 1)
            for dx in (-1, 0, 1)
            for ty, tx in taken.get((cy + dy, cx + dx), ())
        ):
            continue
        taken.setdefault((cy, cx), []).append((y, x))
        tops.append([y, x, hgt])
    if not tops:
        return []
    # Crown radius: area of canopy above half the top's height near it,
    # capped at 0.6x the distance to the nearest other top (grid lookup).
    cells = {}
    for k, (y, x, _) in enumerate(tops):
        cells.setdefault((y // 12, x // 12), []).append(k)
    out = []
    for k, (y, x, hgt) in enumerate(tops):
        y, x = int(y), int(x)
        r = 10
        win = chm[max(0, y - r): y + r + 1, max(0, x - r): x + r + 1]
        yy, xx = np.mgrid[max(0, y - r) - y: min(chm.shape[0], y + r + 1) - y, max(0, x - r) - x: min(chm.shape[1], x + r + 1) - x]
        area = np.count_nonzero((win > hgt * 0.5) & (yy * yy + xx * xx <= r * r))
        rad = math.sqrt(area / math.pi)
        nn = 99.0
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for j in cells.get((y // 12 + dy, x // 12 + dx), ()):
                    if j != k:
                        nn = min(nn, math.hypot(tops[j][0] - y, tops[j][1] - x))
        out.append((y, x, hgt, max(1.0, min(rad, 0.6 * nn + 1.0))))
    return out


def main():
    warnings.filterwarnings("ignore", category=RuntimeWarning)  # all-NaN blocks in fill_ground
    t0 = time.time()
    print(f"grid {GW}x{GH} px at z17 from ({GX}, {GY})", flush=True)
    nodes = ept_nodes()
    total = sum(c for _, c in nodes)
    print(f"lidar: {len(nodes)} EPT nodes, {total / 1e6:.0f} M points ({time.time() - t0:.0f}s)", flush=True)

    top = np.zeros((GH, GW), np.uint16)
    ground = np.full((GH, GW), NO_GROUND, np.uint16)
    done = 0
    with ProcessPoolExecutor(4) as pool:
        for k, res in enumerate(pool.map(reduce_node, [k for k, _ in nodes], chunksize=8), 1):
            if res is not None:
                x0, y0, t, g, n = res
                h, w = t.shape
                np.maximum(top[y0:y0 + h, x0:x0 + w], t, out=top[y0:y0 + h, x0:x0 + w])
                np.minimum(ground[y0:y0 + h, x0:x0 + w], g, out=ground[y0:y0 + h, x0:x0 + w])
                done += n
            if k % 1000 == 0:
                print(f"  {k}/{len(nodes)} nodes, {done / 1e6:.0f} M points ({time.time() - t0:.0f}s)", flush=True)
    print(f"reduced {done / 1e6:.0f} M points ({time.time() - t0:.0f}s)", flush=True)

    polys, bbx = load_buildings()
    print(f"buildings: {len(polys)} footprints", flush=True)
    found = []
    for cy in range(0, GH, CHUNK):
        for cx in range(0, GW, CHUNK):
            x0, y0 = max(cx - HALO, 0), max(cy - HALO, 0)
            x1, y1 = min(cx + CHUNK + HALO, GW), min(cy + CHUNK + HALO, GH)
            t = top[y0:y1, x0:x1].astype(np.float32)
            g = ground[y0:y1, x0:x1].astype(np.float32)
            g[g == NO_GROUND] = np.nan
            if np.isnan(g).all():
                continue
            g = fill_ground(g)
            chm = np.where(t > 0, (t - g) / 10, 0).clip(0, 50).astype(np.float32)
            # Save canopy height per z17 tile for the ground classifier.
            for ty in range(cy, min(cy + CHUNK, GH), 256):
                for tx in range(cx, min(cx + CHUNK, GW), 256):
                    tile = chm[ty - y0: ty - y0 + 256, tx - x0: tx - x0 + 256]
                    if tile.shape != (256, 256) or not (t[ty - y0: ty - y0 + 256, tx - x0: tx - x0 + 256] > 0).any():
                        continue
                    path = os.path.join(CHM_DIR, "17", str((GX + tx) // 256), f"{(GY + ty) // 256}.png")
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    Image.fromarray(np.clip(tile * 5, 0, 255).astype(np.uint8), "L").save(path, optimize=True)
            bm = building_mask(polys, bbx, x0, y0, x1 - x0, y1 - y0)
            veg = np.where(bm, 0, chm)
            inner = np.zeros(veg.shape, bool)
            inner[cy - y0: cy - y0 + CHUNK, cx - x0: cx - x0 + CHUNK] = True
            for y, x, hgt, rad in detect(veg, inner):
                found.append((GX + x0 + x + 0.5, GY + y0 + y + 0.5, hgt, rad * PX * math.cos(math.radians(43.58))))
            print(f"  chunk {cx // CHUNK},{cy // CHUNK}: {len(found)} trees so far ({time.time() - t0:.0f}s)", flush=True)

    # Place trees in the viewer's frame, on the same terrain the viewer streams.
    elev = Elevation(REGION["buildingBbox"], ELEV_ZOOM)
    size = REGION["buildingTileSize"]
    rng = np.random.default_rng(2018)
    tiles = {}
    for gx, gy, hgt, rad in found:
        lon = gx / 256 / N * 360 - 180
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy / 256 / N))))
        base = elev.sample(lat, lon)
        x, yl, z = to_local(np.array(lat), np.array(lon), np.array(base))
        x, yl, z = float(x), float(yl), float(z)
        i, j = math.floor(x / size), math.floor(z / size)
        conifer = 1 if hgt > 6 and hgt / (2 * rad) > 1.6 else 0
        tiles.setdefault((i, j), []).append((
            round((x - i * size) * 10), round((z - j * size) * 10), yl,
            min(255, round(hgt * 5)), min(255, round(rad * 10)), conifer, int(rng.integers(0, 256)),
        ))
    os.makedirs(TREES, exist_ok=True)
    for f in os.listdir(TREES):
        os.remove(os.path.join(TREES, f))
    for (i, j), recs in tiles.items():
        with open(os.path.join(TREES, f"{i}_{j}.bin"), "wb") as f:
            for r in recs:
                f.write(struct.pack("<hhfBBBB", *r))
    with open(os.path.join(TREES, "index.json"), "w") as f:
        json.dump({
            "source": "USGS 3DEP lidar ID_SouthernID_21_2018 (public domain), building footprints from Overture Maps",
            "tileSize": size,
            "record": "int16 x_dm, int16 z_dm, float32 base_y, uint8 height (0.2 m), uint8 crown radius (0.1 m), uint8 flags (1 conifer), uint8 seed",
            "tiles": sorted([i, j, len(r)] for (i, j), r in tiles.items()),
        }, f, separators=(",", ":"))
    hs = np.array([t[2] for t in found])
    print(f"done: {len(found)} trees in {len(tiles)} tiles; height p10/p50/p90 "
          f"{np.percentile(hs, [10, 50, 90]).round(1).tolist()} m ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    sys.exit(main())
