#!/usr/bin/env python3
"""Extract named roads from Overture Maps for street labels and "you are here".

Output: public/data/roads/index.json plus one <i>_<j>.json per 1 km tile (same
grid as the buildings), each holding:
  names:   the street names used in the tile
  anchors: label positions [x_dm, z_dm, y_dm, angle_deg10, name_index, rank]
  segs:    road centrelines [name_index, rank, x0_dm, z0_dm, x1_dm, z1_dm, ...]
x/z are decimetres from the tile origin; y is the local-frame height of the
road surface in decimetres; angle is the road direction in the x-z plane.
rank orders roads by importance (0 = motorway ... 5 = service).

Run: python3 -I data-prep/build_roads.py   (from the repository root)
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
from common import OVERTURE_BUCKET, OVERTURE_RELEASE, REGION, ROOT, ELEV_ZOOM, Elevation, parse_wkb_lines, to_local

OUT_DIR = os.path.join(ROOT, "public", "data", "roads")
RANK = {
    "motorway": 0, "trunk": 0,
    "primary": 1,
    "secondary": 2,
    "tertiary": 3,
    "residential": 4, "unclassified": 4, "living_street": 4, "unknown": 4,
    "service": 5, "pedestrian": 5, "track": 5,
}
MIN_LABEL_LENGTH = 30  # m; shorter named segments get no label of their own
LABEL_SPACING = 200  # m between labels along long segments


def road_name(row):
    name = (row.get("names") or {}).get("primary")
    if name:
        return name.strip()
    for route in row.get("routes") or []:
        if route.get("name"):
            return route["name"].strip()
    return None


def main():
    t0 = time.time()
    bbox = REGION["buildingBbox"]
    size = REGION["buildingTileSize"]
    elev = Elevation(bbox, ELEV_ZOOM)

    s3 = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    dataset = ds.dataset(
        f"{OVERTURE_BUCKET}/{OVERTURE_RELEASE}/theme=transportation/type=segment/",
        filesystem=s3,
        format="parquet",
    )
    filt = (
        (pc.field("subtype") == "road")
        & (pc.field("bbox", "xmax") > bbox["west"]) & (pc.field("bbox", "xmin") < bbox["east"])
        & (pc.field("bbox", "ymax") > bbox["south"]) & (pc.field("bbox", "ymin") < bbox["north"])
    )
    rows = dataset.to_table(columns=["class", "names", "routes", "geometry"], filter=filt).to_pylist()
    print(f"overture {OVERTURE_RELEASE}: {len(rows)} road segments ({time.time() - t0:.0f}s)", flush=True)

    tiles = {}

    def tile_for(x, z):
        i, j = math.floor(x / size), math.floor(z / size)
        t = tiles.get((i, j))
        if t is None:
            t = tiles[(i, j)] = {"names": [], "index": {}, "anchors": [], "segs": []}
        return i, j, t

    def name_index(t, name):
        k = t["index"].get(name)
        if k is None:
            k = t["index"][name] = len(t["names"])
            t["names"].append(name)
        return k

    kept = 0
    for r in rows:
        rank = RANK.get(r["class"])
        name = road_name(r)
        if rank is None or not name:
            continue
        for line in parse_wkb_lines(r["geometry"]):
            pts = np.array(line).reshape(-1, 2)
            if len(pts) < 2:
                continue
            lon, lat = pts[:, 0], pts[:, 1]
            x, _, z = to_local(lat, lon, np.zeros_like(lat))
            seglen = np.hypot(np.diff(x), np.diff(z))
            total = float(seglen.sum())
            if total < 1:
                continue
            kept += 1
            mid = len(x) // 2
            i, j, t = tile_for(float(x[mid]), float(z[mid]))
            ox, oz = i * size, j * size
            k = name_index(t, name)
            coords = np.column_stack([np.round((x - ox) * 10), np.round((z - oz) * 10)]).astype(int).ravel().tolist()
            t["segs"].append([k, rank] + coords)

            if total < MIN_LABEL_LENGTH:
                continue
            n = max(1, round(total / LABEL_SPACING))
            cum = np.concatenate([[0], np.cumsum(seglen)])
            for a in range(n):
                s = (a + 0.5) * total / n
                q = min(int(np.searchsorted(cum, s, side="right")) - 1, len(seglen) - 1)
                f = (s - cum[q]) / seglen[q] if seglen[q] > 0 else 0
                ax = x[q] + (x[q + 1] - x[q]) * f
                az = z[q] + (z[q + 1] - z[q]) * f
                alat = lat[q] + (lat[q + 1] - lat[q]) * f
                alon = lon[q] + (lon[q + 1] - lon[q]) * f
                _, ay, _ = to_local(np.array(alat), np.array(alon), np.array(elev.sample(alat, alon)))
                angle = math.degrees(math.atan2(z[q + 1] - z[q], x[q + 1] - x[q]))
                ai, aj, at = tile_for(float(ax), float(az))
                at["anchors"].append([
                    round((ax - ai * size) * 10), round((az - aj * size) * 10), round(float(ay) * 10),
                    round(angle * 10), name_index(at, name), rank,
                ])

    os.makedirs(OUT_DIR, exist_ok=True)
    for f in os.listdir(OUT_DIR):
        if f.endswith(".json"):
            os.remove(os.path.join(OUT_DIR, f))
    index = []
    for (i, j), t in sorted(tiles.items()):
        with open(os.path.join(OUT_DIR, f"{i}_{j}.json"), "w") as f:
            json.dump({"i": i, "j": j, "size": size, "names": t["names"], "anchors": t["anchors"], "segs": t["segs"]},
                      f, separators=(",", ":"))
        index.append([i, j, len(t["anchors"])])
    with open(os.path.join(OUT_DIR, "index.json"), "w") as f:
        json.dump({
            "source": f"Overture Maps Foundation transportation, release {OVERTURE_RELEASE}",
            "attribution": "Streets © OpenStreetMap contributors, Overture Maps Foundation",
            "tileSize": size,
            "tiles": index,
        }, f, separators=(",", ":"))
    anchors = sum(n for *_, n in index)
    print(f"wrote {kept} named segments, {anchors} label anchors in {len(index)} tiles ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    sys.exit(main())
