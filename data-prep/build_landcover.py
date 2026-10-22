#!/usr/bin/env python3
"""Turn the NAIP photo snapshot into ground-type maps the viewer paints itself.

For every imagery tile in the snapshot, each pixel is sorted into a ground type
(lawn, trees, dry scrub, dirt, asphalt, concrete, water, crops, ...) from its
colour and local texture, then corrected with Overture map data: water bodies
and canals, swimming pools, farmland, golf greens and bunkers. A 3x3 majority
filter removes speckle. The result is one 8-bit PNG per tile in
public/tiles/landcover/ (values are the class ids below); the photos themselves
stay in data-prep/.cache/ and are not shipped.

Where the lidar canopy heights from build_trees_lidar.py are cached, they
correct the tree class: green ground under real canopy becomes trees, and
"trees" with nothing standing on them become lawn. (Trees themselves are
placed by build_trees_lidar.py.)

Run: python3 -I data-prep/build_landcover.py   (after build_snapshot.py, and
     after build_trees_lidar.py for the canopy correction)
"""

import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (CACHE_DIR, OVERTURE_BUCKET, OVERTURE_RELEASE, REGION, ROOT,
                    parse_wkb, parse_wkb_lines)

PHOTOS = os.environ.get("NAIP_TILES", os.path.join(CACHE_DIR, "naip-tiles"))
OUT = os.path.join(ROOT, "public", "tiles", "landcover")
CHM = os.path.join(CACHE_DIR, "chm", "17")  # lidar canopy height, 0.2 m units
CHM_META = os.path.join(CACHE_DIR, "chm-meta", "17")  # lidar + Meta canopy where lidar has gaps

UNKNOWN, LAWN, TREES_C, SCRUB, DIRT, ASPHALT, CONCRETE, WATER, CROP, PLOWED, SAND, POOL = range(12)
NCLASS = 12
ROADS = 100  # burn-only marker: corridors the viewer paints roads into
NO_TREES = 101  # burn-only marker: building footprints (never canopy)
SHADOW = 255  # temporary marker for pixels too dark to classify

# Road corridor widths (m) by Overture class: the drawn road plus some margin.
ROAD_CORRIDOR = {"motorway": 18, "trunk": 18, "primary": 22, "secondary": 20, "tertiary": 18, "residential": 16,
                 "unclassified": 12, "living_street": 12, "service": 8}

# Land-cover hints (Overture land_cover, from ESA WorldCover): where pavement is
# plausible, where fields are, and where to expect natural ground instead.
NATURAL, URBAN, CROPLAND, FOREST = 0, 1, 2, 3
PRIOR = {"urban": URBAN, "crop": CROPLAND, "forest": FOREST}

WATER_LINE_WIDTH = {"canal": 6, "drain": 2.5, "ditch": 2, "stream": 3, "river": 18}


# --- Overture vectors -----------------------------------------------------------

def overture(kind, bbox, cols):
    s3 = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    d = ds.dataset(f"{OVERTURE_BUCKET}/{OVERTURE_RELEASE}/theme=base/type={kind}/", filesystem=s3, format="parquet")
    f = ((pc.field("bbox", "xmax") > bbox["west"]) & (pc.field("bbox", "xmin") < bbox["east"])
         & (pc.field("bbox", "ymax") > bbox["south"]) & (pc.field("bbox", "ymin") < bbox["north"]))
    return d.to_table(columns=cols + ["bbox"], filter=f).to_pylist()


def load_vectors():
    """Polygons and lines to burn in, as (class, kind, coords, width_m, bbox)."""
    area = REGION["snapshot"]["imagery"][1]["bbox"]  # treasure-valley tier
    items = []

    def add(cls, geom_bytes, width=None):
        if width is None:
            for rings in parse_wkb(geom_bytes):
                pts = np.array(rings[0]).reshape(-1, 2)
                items.append((cls, "poly", pts, 0))
        else:
            for line in parse_wkb_lines(geom_bytes):
                items.append((cls, "line", np.array(line).reshape(-1, 2), width))

    for r in overture("land_use", area, ["subtype", "class", "geometry"]):
        c = r["class"]
        cls = {"farmland": CROP, "orchard": CROP, "vineyard": CROP, "green": LAWN, "fairway": LAWN, "tee": LAWN,
               "bunker": SAND}.get(c)
        if cls is not None and r["geometry"][1 if r["geometry"][0] == 1 else 4] in (3, 6):
            add(cls, r["geometry"])
    for r in overture("water", area, ["subtype", "class", "geometry"]):
        gtype = r["geometry"][1 if r["geometry"][0] == 1 else 4]
        cls = POOL if r["class"] == "swimming_pool" else WATER
        if gtype in (3, 6):
            add(cls, r["geometry"])
        elif gtype in (2, 5):
            add(cls, r["geometry"], WATER_LINE_WIDTH.get(r["class"], WATER_LINE_WIDTH.get(r["subtype"], 3)))
    # Land-cover hints cover the whole snapshot, not just the Treasure Valley.
    priors = []
    from build_snapshot import root_bbox
    for r in overture("land_cover", root_bbox(), ["subtype", "geometry"]):
        code = PRIOR.get(r["subtype"])
        if code is None:
            continue
        for rings in parse_wkb(r["geometry"]):
            priors.append((code, np.array(rings[0]).reshape(-1, 2)))
    pbb = np.array([[p[:, 0].min(), p[:, 0].max(), p[:, 1].min(), p[:, 1].max()] for _, p in priors])
    s3 = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    seg = ds.dataset(f"{OVERTURE_BUCKET}/{OVERTURE_RELEASE}/theme=transportation/type=segment/", filesystem=s3, format="parquet")
    f = ((pc.field("subtype") == "road") & (pc.field("bbox", "xmax") > area["west"]) & (pc.field("bbox", "xmin") < area["east"])
         & (pc.field("bbox", "ymax") > area["south"]) & (pc.field("bbox", "ymin") < area["north"]))
    for r in seg.to_table(columns=["class", "geometry"], filter=f).to_pylist():
        width = ROAD_CORRIDOR.get(r["class"])
        if width:
            add(ROADS, r["geometry"], width)
    nampa = REGION["snapshot"]["imagery"][2]["bbox"]
    bld = ds.dataset(f"{OVERTURE_BUCKET}/{OVERTURE_RELEASE}/theme=buildings/type=building/", filesystem=s3, format="parquet")
    f = ((pc.field("bbox", "xmax") > nampa["west"]) & (pc.field("bbox", "xmin") < nampa["east"])
         & (pc.field("bbox", "ymax") > nampa["south"]) & (pc.field("bbox", "ymin") < nampa["north"]))
    for r in bld.to_table(columns=["geometry"], filter=f).to_pylist():
        add(NO_TREES, r["geometry"])
    # Burn order: farmland first, then golf, road corridors, then water and pools on top.
    order = {CROP: 0, LAWN: 1, SAND: 2, ROADS: 3, NO_TREES: 3, WATER: 4, POOL: 5}
    items.sort(key=lambda t: order[t[0]])
    bb = np.array([[p[:, 0].min(), p[:, 0].max(), p[:, 1].min(), p[:, 1].max()] for _, _, p, _ in items])
    return items, bb, priors, pbb


# --- classification ---------------------------------------------------------------

def box(a, r):
    """Mean over a (2r+1)^2 window with edge clamping."""
    p = np.pad(a, r + 1, mode="edge")
    c = p.cumsum(0).cumsum(1)
    k = 2 * r + 1
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return s[: a.shape[0], : a.shape[1]] / (k * k)


def classify(rgb, prior):
    R, G, B = (rgb[..., i].astype(np.float32) / 255 for i in range(3))
    S = R + G + B + 1e-4
    L = S / 3
    exg = (2 * G - R - B) / S
    chroma = np.maximum(np.maximum(R, G), B) - np.minimum(np.minimum(R, G), B)
    tex = np.sqrt(np.maximum(box(L * L, 2) - box(L, 2) ** 2, 0))
    veg = (exg > 0.045) | ((G > R + 0.01) & (G > B + 0.02) & (chroma > 0.05))
    vegshare = box(veg.astype(np.float32), 4)
    urban = prior == URBAN
    natural = (prior == NATURAL) | (prior == FOREST)

    # Bare ground: smooth is dirt, rough is scrub.
    out = np.where((tex > 0.04) & (exg > -0.03), SCRUB, DIRT).astype(np.uint8)
    # Pavement only where land cover says urban; elsewhere pale ground is dirt.
    grey = (chroma < 0.075) & ((R - B) < 0.035) & ~veg & urban
    out[grey & (L >= 0.17) & (L < 0.36)] = ASPHALT
    out[grey & (L >= 0.36)] = CONCRETE
    lush = veg & (exg > 0.06)
    out[veg] = np.where(natural[veg] & ~lush[veg], SCRUB, LAWN)
    canopy = veg & ((L < 0.2) | (tex > 0.06))
    canopy &= ~natural | (prior == FOREST) | (lush & (L < 0.2))
    out[canopy] = TREES_C
    # Shadows (buildings, trees): under canopy if the surroundings are green,
    # otherwise take whatever ground type surrounds them.
    dark = (L < 0.17) & (chroma < 0.08)
    out[dark & (vegshare > 0.35)] = TREES_C
    out[dark & (vegshare <= 0.35)] = SHADOW
    crop = prior == CROPLAND
    out[crop & veg] = CROP
    # Only brown, darker soil reads as a worked field; pale fallow ground stays dirt.
    brown = (L < 0.42) & ((R - B) > 0.06)
    out[crop & ~veg & brown & (out != ASPHALT) & (out != CONCRETE)] = PLOWED
    out[(B > G + 0.02) & (B > R + 0.04) & (L < 0.35) & ~veg] = WATER
    return out, veg


def prior_map(z, x, y, priors, pbb):
    w, e, s, n = tile_bounds(z, x, y)
    img = Image.new("L", (256, 256), NATURAL)
    hit = np.nonzero((pbb[:, 1] >= w) & (pbb[:, 0] <= e) & (pbb[:, 3] >= s) & (pbb[:, 2] <= n))[0]
    draw = ImageDraw.Draw(img)
    scale = 2 ** z
    for k in hit:
        code, pts = priors[k]
        px = ((pts[:, 0] + 180) / 360 * scale - x) * 256
        py = ((1 - np.arcsinh(np.tan(np.radians(pts[:, 1]))) / math.pi) / 2 * scale - y) * 256
        if len(px) >= 3:
            draw.polygon(list(zip(px.tolist(), py.tolist())), fill=code)
    return np.asarray(img)


def majority(cls):
    counts = np.stack([box((cls == k).astype(np.float32), 1) for k in range(NCLASS)])
    return counts.argmax(0).astype(np.uint8)


def fill_shadows(cls):
    """Replace SHADOW pixels with the most common ground type around them."""
    hole = cls == SHADOW
    if not hole.any():
        return cls
    for r in (4, 10, 24):
        counts = np.stack([box((cls == k).astype(np.float32), r) for k in range(NCLASS)])
        best = counts.argmax(0)
        found = counts.max(0) > 0
        cls = np.where(hole & found, best, cls)
        hole = cls == SHADOW
        if not hole.any():
            break
    return np.where(hole, CONCRETE, cls)


def tile_bounds(z, x, y):
    n = 2 ** z
    lon = lambda v: v / n * 360 - 180
    lat = lambda v: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * v / n))))
    return lon(x), lon(x + 1), lat(y + 1), lat(y)


def burn(cls, veg, z, x, y, items, bb):
    """Applies map features; returns (classes, mask of where no tree may stand)."""
    w, e, s, n = tile_bounds(z, x, y)
    hit = np.nonzero((bb[:, 1] >= w) & (bb[:, 0] <= e) & (bb[:, 3] >= s) & (bb[:, 2] <= n))[0]
    nogo = np.zeros(cls.shape, bool)
    if not len(hit):
        return cls, nogo
    scale = 2 ** z
    mpp = 156543.03392 * math.cos(math.radians((s + n) / 2)) / scale
    layers = {}
    for k in hit:
        c, kind, pts, width = items[k]
        if c == NO_TREES and z < 15:
            continue  # only used to mask the canopy correction close up
        img = layers.get(c)
        if img is None:
            img = layers[c] = Image.new("L", (256, 256), 0)
        lon, lat = pts[:, 0], pts[:, 1]
        px = ((lon + 180) / 360 * scale - x) * 256
        py = ((1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * scale - y) * 256
        xy = list(zip(px.tolist(), py.tolist()))
        draw = ImageDraw.Draw(img)
        if kind == "poly":
            if len(xy) >= 3:
                draw.polygon(xy, fill=255)
        else:
            draw.line(xy, fill=255, width=max(1, round(width / mpp)))
    for c in sorted(layers, key=lambda c: {CROP: 0, LAWN: 1, SAND: 2, ROADS: 3, NO_TREES: 3, WATER: 4, POOL: 5}[c]):
        m = np.asarray(layers[c]) > 127
        if c in (ROADS, NO_TREES, WATER, POOL):
            nogo |= m
        if c == NO_TREES:
            continue
        if c == ROADS:
            # The viewer draws these roads sharply; photographed asphalt and
            # shadows along them become plain concrete (curbs, sidewalks).
            cls = np.where(m & np.isin(cls, (ASPHALT, SHADOW)), CONCRETE, cls)
        elif c == CROP:
            cls = np.where(m & ~np.isin(cls, (ASPHALT, CONCRETE)), np.where(veg, CROP, PLOWED), cls)
        elif c == LAWN:
            cls = np.where(m & veg, LAWN, cls)
        else:
            cls = np.where(m, c, cls)
    return cls, nogo


# --- per-tile worker -------------------------------------------------------------

_items = _bb = _priors = _pbb = None


def canopy_share(z, x, y):
    """Share of each pixel covered by >2.5 m lidar canopy, or None without lidar."""
    k = 2 ** (17 - z)
    full = np.zeros((256 * k, 256 * k), np.float32)
    found = False
    for dx in range(k):
        for dy in range(k):
            path = os.path.join(CHM_META, str(x * k + dx), f"{y * k + dy}.png")
            if not os.path.exists(path):
                path = os.path.join(CHM, str(x * k + dx), f"{y * k + dy}.png")
            if os.path.exists(path):
                found = True
                full[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = np.asarray(Image.open(path)) > 12
    if not found:
        return None
    share = full.reshape(256, k, 256, k).mean(axis=(1, 3))
    return box(share, 1)


def apply_canopy(cls, nogo, z, x, y):
    share = canopy_share(z, x, y)
    if share is None:
        return cls
    green = np.isin(cls, (LAWN, SCRUB, CROP, UNKNOWN, DIRT))
    cls = np.where((cls == TREES_C) & (share < 0.15), LAWN, cls)
    return np.where(green & (share > 0.5) & ~nogo, TREES_C, cls)


def init(items, bb, priors, pbb):
    global _items, _bb, _priors, _pbb
    _items, _bb, _priors, _pbb = items, bb, priors, pbb


def process(job):
    z, x, y = job
    src = os.path.join(PHOTOS, str(z), str(x), f"{y}.webp")
    dst = os.path.join(OUT, str(z), str(x), f"{y}.png")
    if not os.path.exists(src):
        return None
    rgb = np.asarray(Image.open(src).convert("RGB"))
    cls, veg = classify(rgb, prior_map(z, x, y, _priors, _pbb))
    cls, nogo = burn(cls, veg, z, x, y, _items, _bb)
    cls = fill_shadows(cls)
    if z >= 15:
        cls = apply_canopy(cls, nogo, z, x, y)
        cls = majority(cls)
    cls = cls.astype(np.uint8)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    Image.fromarray(cls, "L").save(dst, optimize=True)
    return True


def main():
    t0 = time.time()
    from build_snapshot import tiers
    cov_path = os.path.join(ROOT, "public", "tiles", "coverage.json")
    ranges = {str(z): rng for z, rng, _ in tiers("imagery")}
    jobs = [(int(z), x, y) for z, (x0, x1, y0, y1) in ranges.items() for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    items, bb, priors, pbb = load_vectors()
    print(f"landcover: {len(jobs)} tiles, {len(items)} map features, {len(priors)} land-cover hints ({time.time() - t0:.0f}s)", flush=True)
    missing = 0
    with ProcessPoolExecutor(4, initializer=init, initargs=(items, bb, priors, pbb)) as pool:
        for k, res in enumerate(pool.map(process, jobs, chunksize=32), 1):
            if res is None and not os.path.exists(os.path.join(OUT, str(jobs[k - 1][0]), str(jobs[k - 1][1]), f"{jobs[k - 1][2]}.png")):
                missing += 1
            if k % 2000 == 0:
                print(f"  {k}/{len(jobs)} ({time.time() - t0:.0f}s)", flush=True)
    if missing:
        print(f"warning: {missing} tiles had no photo to classify", flush=True)

    coverage = {
        "landcover": ranges,
        "elevation": {str(z): rng for z, rng, _ in tiers("elevation")},
        "groundCredit": "Ground and trees generated from USDA NAIP and USGS 3DEP lidar (public domain), Meta/WRI canopy height (CC BY 4.0) and Overture Maps / OpenStreetMap",
        "elevationCredit": "Terrain: USGS 3DEP via AWS Terrain Tiles",
    }
    with open(cov_path, "w") as f:
        json.dump(coverage, f, indent=1)
    print(f"done: {len(jobs)} ground tiles ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    sys.exit(main())
