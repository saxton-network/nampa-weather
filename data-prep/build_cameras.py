#!/usr/bin/env python3
"""Fetch publicly mapped ALPR (license plate reader) cameras for the region.

Source: the nationwide camera feed behind DeFlock's map (maps.deflock.org),
which is built from OpenStreetMap nodes tagged surveillance:type=ALPR.
Data © OpenStreetMap contributors, ODbL 1.0.

Writes public/data/cameras.json. Uses only the Python standard library so the
GitHub Pages workflow can run it before every build; if the download fails it
exits non-zero and leaves the committed snapshot in place.

Run: python3 -I data-prep/build_cameras.py   (from the repository root)
"""

import gzip
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGION = json.load(open(os.path.join(ROOT, "src", "region.json")))
OUT = os.path.join(ROOT, "public", "data", "cameras.json")
FEED = os.environ.get("CAMERA_FEED_URL", "https://data.dontgetflocked.com/cameras.geojson.gz")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "nampa-weather-viewer (github.com/saxton-network/nampa-weather)"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            break
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    # The file is named .gz but is sometimes served already decoded.
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return json.loads(data)


def main():
    t0 = time.time()
    feed = fetch(FEED)
    bb = REGION["cameraBbox"]
    cameras = []
    for f in feed.get("features", []):
        g = f.get("geometry") or {}
        p = f.get("properties") or {}
        if g.get("type") != "Point" or p.get("osmType") != "node":
            continue
        lon, lat = g["coordinates"][:2]
        if not (bb["west"] <= lon <= bb["east"] and bb["south"] <= lat <= bb["north"]):
            continue
        dirs = p.get("directions") or ([p["direction"]] if p.get("direction") is not None else [])
        cameras.append({
            "id": p["osmId"],
            "lat": round(lat, 7),
            "lon": round(lon, 7),
            "brand": p.get("brand"),
            "operator": p.get("operator"),
            "mount": p.get("mountType"),
            "zone": p.get("surveillanceZone"),
            "directions": [round(float(d), 1) for d in dirs],
            "edited": p.get("osmTimestamp"),
        })
    if not cameras:
        print("feed returned no cameras for the region; keeping the existing snapshot", file=sys.stderr)
        return 1
    cameras.sort(key=lambda c: c["id"])
    out = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": FEED,
        "attribution": "ALPR locations © OpenStreetMap contributors, mapped by the DeFlock community",
        "license": "ODbL-1.0",
        "cameras": cameras,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {len(cameras)} cameras ({time.time() - t0:.0f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
