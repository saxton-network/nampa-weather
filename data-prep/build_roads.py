#!/usr/bin/env python3
"""Extract named roads from Overture Maps for street labels and "you are here".

Output: public/data/roads/index.json plus one <i>_<j>.json per 1 km tile (same
grid as the buildings), each holding:
  names:   the street names used in the tile
  anchors: label positions [x_dm, z_dm, y_dm, angle_deg10, name_index, rank]
  segs:    road centrelines [name_index, rank, kind, x0_dm, z0_dm, x1_dm, z1_dm, ...]
  lamps:   street lights [x_dm, z_dm, toward_road_x*100, toward_road_z*100]
x/z are decimetres from the tile origin; y is the local-frame height of the
road surface in decimetres; angle is the road direction in the x-z plane.
rank orders roads by importance (0 = motorway ... 5 = service). segs include
unnamed roads and paths (name_index -1) so the ground can draw every road;
kind is an index into KINDS below, which sets width and markings in the viewer.

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
# Order matters: the viewer's ground shader indexes this list (src/roads.js).
KINDS = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified",
         "living_street", "service", "driveway", "parking_aisle", "alley", "track", "pedestrian", "path"]
PATHS = {"footway", "cycleway", "path", "steps", "bridleway"}
# Street lights, placed the way city codes usually do: one at a corner of every
# intersection (two at opposite corners where an arterial is involved), one at
# each dead end, and mid-block lights only on long blocks, spaced by road type.
LIT = {"primary": 45, "secondary": 50, "tertiary": 60, "residential": 95, "living_street": 80}  # mid-block spacing (m)
WIDTH = {"motorway": 11.5, "trunk": 11.5, "primary": 14, "secondary": 12, "tertiary": 10, "residential": 8.5,
         "unclassified": 7, "living_street": 6, "service": 5}  # same as src/roads.js
ARTERIAL = {"primary", "secondary", "trunk"}
END_MARGIN = 30  # m kept clear of mid-block lights at each end (the corner light covers it)
MIN_LABEL_LENGTH = 30  # m; shorter named segments get no label of their own
LABEL_SPACING = 200  # m between labels along long segments


def road_kind(row):
    cls, sub = row["class"], row.get("subclass")
    if cls in PATHS:
        return None if sub == "sidewalk" else KINDS.index("path")
    if cls == "service" and sub in ("driveway", "parking_aisle", "alley"):
        return KINDS.index(sub)
    if cls in KINDS:
        return KINDS.index(cls)
    if cls == "unknown":
        return KINDS.index("unclassified")
    return None


def is_tunnel(row):
    return any("is_tunnel" in (f.get("values") or []) for f in row.get("road_flags") or [])


def road_name(row):
    name = (row.get("names") or {}).get("primary")
    if name:
        return name.strip()
    for route in row.get("routes") or []:
        if route.get("name"):
            return route["name"].strip()
    return None


def point_at(x, z, cum, s):
    """Position and unit direction at distance s along a polyline."""
    s = min(max(s, 0.0), cum[-1])
    q = min(int(np.searchsorted(cum, s, side="right")) - 1, len(cum) - 2)
    seg = cum[q + 1] - cum[q]
    f = (s - cum[q]) / seg if seg > 0 else 0
    dx, dz = x[q + 1] - x[q], z[q + 1] - z[q]
    n = math.hypot(dx, dz) or 1
    return x[q] + dx * f, z[q] + dz * f, dx / n, dz / n


def built_up_cells():
    """100 m cells (local frame) with at least three buildings in or next to them."""
    counts = {}
    bdir = os.path.join(ROOT, "public", "data", "buildings")
    for f in os.listdir(bdir):
        if not f.endswith(".json") or f == "index.json":
            continue
        t = json.load(open(os.path.join(bdir, f)))
        for rec in t["b"]:
            ring = rec[6]
            cx = t["i"] * t["size"] + sum(ring[0::2]) / len(ring[0::2]) / 10
            cz = t["j"] * t["size"] + sum(ring[1::2]) / len(ring[1::2]) / 10
            key = (int(cx // 100), int(cz // 100))
            counts[key] = counts.get(key, 0) + 1
    cells = set()
    for (i, j) in counts:
        if sum(counts.get((i + di, j + dj), 0) for di in (-1, 0, 1) for dj in (-1, 0, 1)) >= 3:
            cells.add((i, j))
    return cells


_BUILT = None


def developed(x, z):
    """True in built-up areas: rural crossroads stay dark."""
    global _BUILT
    if _BUILT is None:
        _BUILT = built_up_cells()
    return (int(x // 100), int(z // 100)) in _BUILT


def place_lamps(network):
    """Street-light positions [x, z, toward_road_x, toward_road_z] in local metres."""
    nodes = {}  # connector id -> {"p": (x, z), "arms": [(class, dir_x, dir_z)]}
    for cls, x, z, cum, connectors in network:
        for c in connectors:
            s = (c.get("at") or 0) * cum[-1]
            px, pz, dx, dz = point_at(x, z, cum, s)
            node = nodes.setdefault(c["connector_id"], {"p": (px, pz), "arms": []})
            if s > 0.5:
                node["arms"].append((cls, -dx, -dz))  # back along the road
            if s < cum[-1] - 0.5:
                node["arms"].append((cls, dx, dz))  # onward along the road
    out = []
    grid = {}  # 12 m cells, so no two lights end up closer than that

    def add(x, z, tx, tz):
        ci, cj = int(x // 12), int(z // 12)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for a, b in grid.get((ci + di, cj + dj), ()):
                    if (x - a) ** 2 + (z - b) ** 2 < 12 ** 2:
                        return
        grid.setdefault((ci, cj), []).append((x, z))
        out.append((x, z, tx, tz))

    junction = {}
    for cid, node in nodes.items():
        arms = node["arms"]
        lit = [a for a in arms if a[0] in LIT]
        if not lit:
            continue
        px, pz = node["p"]
        if len(arms) >= 3:
            junction[cid] = True
            # Corner between the two widest roads, set back from both kerbs.
            a, b = sorted(arms, key=lambda a: -WIDTH[a[0]])[:2]
            bx, bz = a[1] + b[1], a[2] + b[2]
            if math.hypot(bx, bz) < 0.3:  # roads nearly opposite: go to the side
                bx, bz = -a[2], a[1]
            n = math.hypot(bx, bz)
            bx, bz = bx / n, bz / n
            off = (WIDTH[a[0]] / 2 + 1.5) * 1.41
            add(px + bx * off, pz + bz * off, -bx, -bz)
            if any(arm[0] in ARTERIAL for arm in arms):
                add(px - bx * off, pz - bz * off, bx, bz)
        elif len(arms) == 1 and lit[0][0] in ("residential", "living_street"):
            # Dead end: a light beside the end of the street.
            cls, dx, dz = lit[0]
            off = WIDTH[cls] / 2 + 1.5
            add(px - dz * off, pz + dx * off, dz, -dx)

    for cls, x, z, cum, connectors in network:
        spacing = LIT.get(cls)
        if not spacing:
            continue
        # Break the road at intersections; place mid-block lights on long pieces.
        stops = sorted({0.0, float(cum[-1])} | {(c.get("at") or 0) * float(cum[-1]) for c in connectors if junction.get(c["connector_id"])})
        side = 1 if hash(round(float(x[0]), 1)) % 2 else -1
        for s0, s1 in zip(stops, stops[1:]):
            usable = (s1 - s0) - 2 * END_MARGIN
            if usable < 0.6 * spacing:
                continue
            count = max(1, round(usable / spacing))
            for k in range(count):
                s = s0 + END_MARGIN + usable * (k + 0.5) / count
                px, pz, dx, dz = point_at(x, z, cum, s)
                off = WIDTH[cls] / 2 + 1.2
                # Right-hand normal is (-dz, dx); alternate sides along the road.
                nx, nz = -dz * side, dx * side
                add(px + nx * off, pz + nz * off, -nx, -nz)
                side = -side
    return out


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
    rows = dataset.to_table(columns=["class", "subclass", "names", "routes", "road_flags", "connectors", "geometry"], filter=filt).to_pylist()
    print(f"overture {OVERTURE_RELEASE}: {len(rows)} road segments ({time.time() - t0:.0f}s)", flush=True)

    tiles = {}

    def tile_for(x, z):
        i, j = math.floor(x / size), math.floor(z / size)
        t = tiles.get((i, j))
        if t is None:
            t = tiles[(i, j)] = {"names": [], "index": {}, "anchors": [], "segs": [], "lamps": []}
        return i, j, t

    def name_index(t, name):
        k = t["index"].get(name)
        if k is None:
            k = t["index"][name] = len(t["names"])
            t["names"].append(name)
        return k

    kept = 0
    network = []  # (class, x, z, cumulative length, connectors) for street lights
    for r in rows:
        kind = road_kind(r)
        if kind is None or is_tunnel(r):
            continue
        rank = RANK.get(r["class"], 5)
        name = road_name(r) if r["class"] in RANK else None
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
            # Public streets only: alleys, driveways and parking aisles don't make intersections.
            if r["class"] in WIDTH and r["class"] != "service":
                network.append((r["class"], x, z, np.concatenate([[0], np.cumsum(seglen)]), r.get("connectors") or []))
            mid = len(x) // 2
            i, j, t = tile_for(float(x[mid]), float(z[mid]))
            ox, oz = i * size, j * size
            k = name_index(t, name) if name else -1
            coords = np.column_stack([np.round((x - ox) * 10), np.round((z - oz) * 10)]).astype(int).ravel().tolist()
            t["segs"].append([k, rank, kind] + coords)

            if not name or total < MIN_LABEL_LENGTH:
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

    lamps = [l for l in place_lamps(network) if developed(l[0], l[1])]
    for lx, lz, dx, dz in lamps:
        i, j, t = tile_for(lx, lz)
        t["lamps"].append([round((lx - i * size) * 10), round((lz - j * size) * 10), round(dx * 100), round(dz * 100)])
    print(f"street lights: {len(lamps)}", flush=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    for f in os.listdir(OUT_DIR):
        if f.endswith(".json"):
            os.remove(os.path.join(OUT_DIR, f))
    index = []
    for (i, j), t in sorted(tiles.items()):
        with open(os.path.join(OUT_DIR, f"{i}_{j}.json"), "w") as f:
            json.dump({"i": i, "j": j, "size": size, "names": t["names"], "anchors": t["anchors"], "segs": t["segs"], "lamps": t["lamps"]},
                      f, separators=(",", ":"))
        index.append([i, j, len(t["anchors"])])
    with open(os.path.join(OUT_DIR, "index.json"), "w") as f:
        json.dump({
            "source": f"Overture Maps Foundation transportation, release {OVERTURE_RELEASE}",
            "attribution": "Streets © OpenStreetMap contributors, Overture Maps Foundation",
            "tileSize": size,
            "kinds": KINDS,
            "tiles": index,
        }, f, separators=(",", ":"))
    anchors = sum(n for *_, n in index)
    print(f"wrote {kept} road segments, {anchors} label anchors in {len(index)} tiles ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    sys.exit(main())
