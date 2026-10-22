#!/usr/bin/env python3
"""Extract Overture Maps buildings for the region and write compact JSON tiles.

Each building is placed on terrain sampled from the same AWS Terrain Tiles
(terrarium, z15) the viewer streams, so footprints line up with the ground mesh.

Output: public/data/buildings/index.json plus one <i>_<j>.json per tile, where
tile (i, j) covers local east x in [i*size, (i+1)*size) and local z in
[j*size, (j+1)*size) (local z points south, matching the viewer's frame).

Run: python3 -I data-prep/build_buildings.py   (from the repository root)
Needs: pyarrow, numpy, Pillow. Downloads ~25 MB of terrain tiles and reads
Overture GeoParquet anonymously from S3.
"""

import json
import math
import os
import sys
import time

import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OVERTURE_BUCKET, OVERTURE_RELEASE, REGION, ROOT, ELEV_ZOOM, Elevation, parse_wkb, to_local

OUT_DIR = os.path.join(ROOT, "public", "data", "buildings")


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
        f"{OVERTURE_BUCKET}/{OVERTURE_RELEASE}/theme=buildings/type=building/",
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
