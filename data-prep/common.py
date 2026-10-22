"""Shared helpers for the data-prep scripts: region config, the viewer's local
frame (same math as src/geo.js), terrain sampling and WKB parsing."""

import json
import math
import os
import struct
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGION = json.load(open(os.path.join(ROOT, "src", "region.json")))
CACHE_DIR = os.path.join(ROOT, "data-prep", ".cache")
OVERTURE_RELEASE = os.environ.get("OVERTURE_RELEASE", "2026-10-21.0")
OVERTURE_BUCKET = "overturemaps-us-west-2/release"
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


def parse_wkb_lines(buf):
    """LineString / MultiLineString WKB -> list of flat (x0, y0, x1, y1, ...) tuples."""

    def read(off):
        bo = "<" if buf[off] == 1 else ">"
        (gtype,) = struct.unpack_from(bo + "I", buf, off + 1)
        off += 5
        gtype &= 0xFFFF
        if gtype == 2:
            (npts,) = struct.unpack_from(bo + "I", buf, off)
            off += 4
            pts = struct.unpack_from(bo + f"{npts * 2}d", buf, off)
            return [pts], off + npts * 16
        if gtype == 5:
            (nlines,) = struct.unpack_from(bo + "I", buf, off)
            off += 4
            lines = []
            for _ in range(nlines):
                part, off = read(off)
                lines.extend(part)
            return lines, off
        return [], off

    return read(0)[0]
