"""Per-building detail from the 2018 lidar and the NAIP photos.

Used by build_buildings.py for buildings near the plate-reader cameras. It
needs the caches written by build_trees_lidar.py (canopy height per z17 tile,
which includes roofs) and build_snapshot.py (NAIP photo tiles).

For each footprint it:
  - lines the footprint up with the lidar if it is off by up to ~2.5 m
    (machine-traced footprints often are),
  - splits right-angled footprints (L, T and U shapes) into rectangles and
    fits each one a flat, gabled or hipped roof with its real eave and ridge
    height, ignoring trees that overhang it,
  - takes the roof colour from the photo.
"""

import math
import os
import warnings

import numpy as np
from PIL import Image, ImageDraw

from common import CACHE_DIR

Z = 17
N = 2 ** Z
CHM_DIR = os.path.join(CACHE_DIR, "chm", str(Z))
PHOTO_DIR = os.path.join(CACHE_DIR, "naip-tiles", str(Z))

MAX_PARTS = 4
SHIFT = 3  # px searched each way when lining footprints up (~0.87 m each)


def lonlat_to_px(lon, lat):
    gx = (np.asarray(lon) + 180) / 360 * N * 256
    gy = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * N * 256
    return gx, gy


class TileCache:
    """z17 tiles of one kind, stitched into windows."""

    def __init__(self, root, ext, load, channels):
        self.root, self.ext, self.load, self.channels = root, ext, load, channels
        self.tiles = {}

    def tile(self, tx, ty):
        key = (tx, ty)
        if key not in self.tiles:
            path = os.path.join(self.root, str(tx), f"{ty}.{self.ext}")
            self.tiles[key] = self.load(path) if os.path.exists(path) else None
            if len(self.tiles) > 4000:
                self.tiles.pop(next(iter(self.tiles)))
        return self.tiles[key]

    def window(self, x0, y0, w, h):
        shape = (h, w, self.channels) if self.channels > 1 else (h, w)
        out = np.full(shape, np.nan, np.float32)
        for ty in range(y0 // 256, (y0 + h - 1) // 256 + 1):
            for tx in range(x0 // 256, (x0 + w - 1) // 256 + 1):
                t = self.tile(tx, ty)
                if t is None:
                    continue
                ax, ay = max(x0, tx * 256), max(y0, ty * 256)
                bx, by = min(x0 + w, tx * 256 + 256), min(y0 + h, ty * 256 + 256)
                out[ay - y0:by - y0, ax - x0:bx - x0] = t[ay - ty * 256:by - ty * 256, ax - tx * 256:bx - tx * 256]
        return out


CHM = TileCache(CHM_DIR, "png", lambda p: np.asarray(Image.open(p), np.float32) / 5, 1)
PHOTO = TileCache(PHOTO_DIR, "webp", lambda p: np.asarray(Image.open(p).convert("RGB"), np.float32), 3)


def have_caches():
    return os.path.isdir(CHM_DIR) and os.path.isdir(PHOTO_DIR)


def erode(m):
    p = np.pad(m, 1)
    out = m.copy()
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            out &= p[dy:dy + m.shape[0], dx:dx + m.shape[1]]
    return out


def raster(poly_px, w, h):
    """Mask of pixels mostly inside the polygon (3x supersampled)."""
    img = Image.new("L", (w * 3, h * 3), 0)
    ImageDraw.Draw(img).polygon([(x * 3, y * 3) for x, y in poly_px], fill=1)
    a = np.asarray(img, np.float32).reshape(h, 3, w, 3).mean(axis=(1, 3))
    return a >= 0.5


def roof_hex(rgb):
    """Photo colour (sRGB 0-255) to a roof albedo hex for the viewer. The
    photos are brighter and hazier than the scene's albedo palette, so the
    colour is darkened and given back some saturation."""
    lin = (np.asarray(rgb, float) / 255) ** 2.2
    grey = lin.mean()
    lin = np.clip(grey + (lin - grey) * 1.35, 0, None) * 0.42
    srgb = np.clip(lin ** (1 / 2.2) * 255, 0, 255).round().astype(int)
    return int(srgb[0]) << 16 | int(srgb[1]) << 8 | int(srgb[2])


# --- footprint geometry (local metres) ----------------------------------------------

def oriented_box(x, z):
    best = None
    n = len(x)
    for k in range(n):
        dx, dz = x[(k + 1) % n] - x[k], z[(k + 1) % n] - z[k]
        ln = math.hypot(dx, dz)
        if ln < 0.5:
            continue
        ux, uz = dx / ln, dz / ln
        u = x * ux + z * uz
        v = -x * uz + z * ux
        area = (u.max() - u.min()) * (v.max() - v.min())
        if best is None or area < best[0]:
            best = (area, ux, uz)
    return best


def simplify(u, v, tol=1.0):
    """Drops very short edges and nearly straight vertices."""
    pts = list(zip(u.tolist(), v.tolist()))
    changed = True
    while changed and len(pts) > 4:
        changed = False
        for k in range(len(pts)):
            a, b, c = pts[k - 1], pts[k], pts[(k + 1) % len(pts)]
            ab = math.hypot(b[0] - a[0], b[1] - a[1])
            cross = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
            ac = math.hypot(c[0] - a[0], c[1] - a[1]) or 1
            if ab < tol or cross / ac < 0.4:
                pts.pop(k)
                changed = True
                break
    return np.array(pts)


def inside(pts, qu, qv):
    """Even-odd point in polygon for arrays of query points."""
    res = np.zeros(qu.shape, bool)
    n = len(pts)
    for k in range(n):
        (au, av), (bu, bv) = pts[k], pts[(k + 1) % n]
        cond = (av > qv) != (bv > qv)
        with np.errstate(divide="ignore", invalid="ignore"):
            xu = au + (qv - av) * (bu - au) / (bv - av)
        res ^= cond & (qu < xu)
    return res


def cluster(vals, tol=0.6):
    vals = sorted(vals)
    groups = [[vals[0]]]
    for v in vals[1:]:
        if v - groups[-1][-1] < tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def rect_parts(u, v):
    """Splits a right-angled footprint (in its box frame) into up to four
    overlapping rectangles covering it; None if it isn't right-angled."""
    pts = simplify(u, v)
    if len(pts) < 4:
        return None
    for k in range(len(pts)):
        du, dv = pts[(k + 1) % len(pts)] - pts[k]
        ang = math.degrees(math.atan2(abs(dv), abs(du)))
        if min(ang, 90 - ang) > 12:
            return None
    us, vs = cluster(pts[:, 0].tolist(), 1.0), cluster(pts[:, 1].tolist(), 1.0)
    if len(us) < 2 or len(vs) < 2 or len(us) * len(vs) > 144:
        return None
    cu = np.array([(us[i] + us[i + 1]) / 2 for i in range(len(us) - 1)])
    cv = np.array([(vs[j] + vs[j + 1]) / 2 for j in range(len(vs) - 1)])
    gu, gv = np.meshgrid(cu, cv, indexing="ij")
    cell_in = inside(pts, gu, gv)
    du = np.diff(us)
    dv = np.diff(vs)
    area = np.outer(du, dv)
    nu, nv = cell_in.shape
    rects = []
    for i0 in range(nu):
        for i1 in range(i0, nu):
            for j0 in range(nv):
                for j1 in range(j0, nv):
                    if cell_in[i0:i1 + 1, j0:j1 + 1].all():
                        rects.append((i0, i1, j0, j1))
    if not rects:
        return None
    total = area[cell_in].sum()
    covered = np.zeros_like(cell_in)
    parts = []
    while len(parts) < MAX_PARTS:
        best, gain = None, 0
        for r in rects:
            i0, i1, j0, j1 = r
            g = (area[i0:i1 + 1, j0:j1 + 1] * ~covered[i0:i1 + 1, j0:j1 + 1]).sum()
            if g > gain + 1e-6:
                best, gain = r, g
        if best is None or gain < 0.06 * total:
            break
        i0, i1, j0, j1 = best
        covered[i0:i1 + 1, j0:j1 + 1] = True
        parts.append((us[i0], us[i1 + 1], vs[j0], vs[j1 + 1]))
    return parts


# --- roof fitting -----------------------------------------------------------------

def fit_part(pu, pv, h, hl, hw, house=False):
    """Best roof for a rectangle of half-size (hl, hw) centred on (0, 0) from
    lidar heights h at (pu, pv). Returns (ridge_along_u, ridge_half, eave,
    ridge) with ridge_half the half-length of the ridge (hl or hw for a gable,
    shorter for hipped ends), or None. Flat roofs have ridge == eave.
    Houses are nearly always pitched, so for them a pitched roof wins unless
    flat fits clearly better."""
    med = np.median(h)
    ok = (h < med + 2.5) & (h > 1.0)  # drop trees standing over the roof
    if ok.sum() < 5:
        return None
    pu, pv, h = pu[ok], pv[ok], h[ok]
    du = np.clip(hl - np.abs(pu), 0, None)
    dv = np.clip(hw - np.abs(pv), 0, None)
    # Distance up the roof from the eave: min(across, k * along). k is the
    # end slope relative to the side slope; infinite k is a gable.
    models = [(True, None, 0.0)]
    for along_u, across, along, L, W in ((True, dv, du, hl, hw), (False, du, dv, hw, hl)):
        for k in (math.inf, 3.0, 1.5, 1.0):
            if k == 1.0 and not along_u:
                continue  # same as the other orientation
            d = across if k == math.inf else np.minimum(across, k * along)
            half = L if k == math.inf else max(L - W / k, 0.0)
            models.append((along_u, d, half))
    best = None
    flat_mae = None
    for along_u, d, half in models:
        keep = np.ones(h.shape, bool)
        for _ in range(3):
            if keep.sum() < 4:
                break
            if d is None:
                e, s = float(np.median(h[keep])), 0.0
            else:
                a = np.column_stack([np.ones(keep.sum()), d[keep]])
                (e, s), *_ = np.linalg.lstsq(a, h[keep], rcond=None)
            res = h - (e + (0 if d is None else s * d))
            keep = (res < 0.8) & (res > -1.2)
        if keep.sum() < 4:
            continue
        mae = float(np.abs(res[keep]).mean()) + 0.6 * (1 - keep.mean())
        if d is None:
            flat_mae = mae
            best = (mae, True, 0.0, e, e)
            continue
        rise = s * float(d.max()) if len(d) else 0
        if flat_mae is None or not (0.1 < s < 1.5 and rise > 0.6 and mae < flat_mae * (1.1 if house else 0.8)):
            continue
        if mae < best[0]:
            best = (mae, along_u, half, e, e + rise)
    if best is None:
        return None
    _, along_u, half, e, r = best
    return along_u, half, e, r


def roof_height(part, px, pz):
    """Height of a part's roof at local points (nan outside the part)."""
    cx, cz, ax, az, L, W, half, eave, ridge = part
    pu = (px - cx) * ax + (pz - cz) * az
    pv = -(px - cx) * az + (pz - cz) * ax
    inside = (np.abs(pu) <= L) & (np.abs(pv) <= W)
    if ridge - eave < 0.05:
        h = np.full(px.shape, eave)
    else:
        s = (ridge - eave) / W
        d = np.minimum(W - np.abs(pv), (L - np.abs(pu)) * (W / max(L - half, 1e-6)) if half < L - 1e-6 else np.inf)
        h = eave + s * np.clip(d, 0, None)
    return np.where(inside, h, np.nan)


def fit_parts(rects, ux, uz, pu_all, pv_all, hs, house=False):
    """Fits a roof to each rectangle (on the pixels only it covers, where it
    has enough) and scores the combined roof over the whole footprint."""
    parts = []
    covers = [(pu_all >= u0) & (pu_all <= u1) & (pv_all >= v0) & (pv_all <= v1) for (u0, u1, v0, v1) in rects]
    count = np.sum(covers, axis=0)
    for (u0, u1, v0, v1), cov in zip(rects, covers):
        hl, hw = (u1 - u0) / 2, (v1 - v0) / 2
        if min(hl, hw) < 1.2:
            continue
        cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
        pu, pv = pu_all - cu, pv_all - cv
        core = cov & (np.abs(pu) < hl - 0.3) & (np.abs(pv) < hw - 0.3)
        sel = core & (count == 1) if (core & (count == 1)).sum() >= 15 else core
        if sel.sum() < 5:
            continue
        fit = fit_part(pu[sel], pv[sel], hs[sel], hl, hw, house)
        if fit is None:
            continue
        along_u, half, eave, ridge = fit
        # Part frame with its u axis along the ridge.
        ax, az = (ux, uz) if along_u else (-uz, ux)
        L, W = (hl, hw) if along_u else (hw, hl)
        cxl, czl = cu * ux - cv * uz, cu * uz + cv * ux
        eave = max(eave, 2.2)
        parts.append((cxl, czl, ax, az, L, W, half, eave, max(ridge, eave)))
    if not parts:
        return None, None
    lx = pu_all * ux - pv_all * uz
    lz = pu_all * uz + pv_all * ux
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        pred = np.nanmax(np.stack([roof_height(p, lx, lz) for p in parts]), axis=0)
    res = hs - pred
    ok = ~np.isnan(res) & (res < 0.8) & (res > -1.2)
    score = (np.abs(res[ok]).mean() if ok.any() else 9) + 0.8 * (1 - ok.mean()) + 0.03 * len(parts)
    if house and all(p[8] - p[7] < 0.05 for p in parts):
        score += 0.15
    return parts, score


# --- per building -----------------------------------------------------------------

def refine(lat, lon, x, z, house=False):
    """lat/lon/x/z: footprint ring (degrees, local metres). Returns a dict
    with shift (dx, dz metres), height, parts and roof_rgb, or None."""
    gx, gy = lonlat_to_px(lon, lat)
    # Affine local metres -> global pixels (exact enough over one building).
    a = np.column_stack([x, z, np.ones_like(x)])
    mx, *_ = np.linalg.lstsq(a, gx, rcond=None)
    my, *_ = np.linalg.lstsq(a, gy, rcond=None)
    J = np.array([[mx[0], mx[1]], [my[0], my[1]]])
    Jinv = np.linalg.inv(J)
    pad = SHIFT + 3
    x0, y0 = int(math.floor(gx.min())) - pad, int(math.floor(gy.min())) - pad
    w, h = int(math.ceil(gx.max())) + pad - x0, int(math.ceil(gy.max())) + pad - y0
    if w * h > 400 * 400:
        return None
    chm = CHM.window(x0, y0, w, h)
    has_lidar = not np.isnan(chm).all()
    chm = np.nan_to_num(chm, nan=0.0)
    foot = raster(list(zip((gx - x0).tolist(), (gy - y0).tolist())), w, h)
    if foot.sum() < 6:
        return None
    lid = chm > 2.0
    base_iou = (foot & lid).sum() / max((foot | lid).sum(), 1)

    # Line the footprint up with the lidar.
    best = (base_iou, 0, 0)
    for dy in range(-SHIFT, SHIFT + 1) if has_lidar else ():
        for dx in range(-SHIFT, SHIFT + 1):
            if not dx and not dy:
                continue
            f = np.roll(np.roll(foot, dy, 0), dx, 1)
            iou = (f & lid).sum() / max((f | lid).sum(), 1)
            if iou > best[0]:
                best = (iou, dx, dy)
    shift_px = (0, 0)
    if best[0] > 0.5 and best[0] - base_iou > 0.08:
        shift_px = best[1:]
        foot = np.roll(np.roll(foot, shift_px[1], 0), shift_px[0], 1)
    sx, sz = Jinv @ np.array(shift_px, float)

    inner = erode(foot) if erode(foot).sum() >= 6 else foot
    ys, xs = np.nonzero(inner)
    hs = chm[ys, xs]
    out = {"shift": (float(sx), float(sz))}

    # Roof colour: the photo inside the footprint, away from its edges and
    # from anything green (trees over the roof).
    photo = PHOTO.window(x0, y0, w, h)
    core = erode(inner) if erode(inner).sum() >= 8 else inner
    cy, cx = np.nonzero(core)
    rgb = photo[cy, cx]
    rgb = rgb[~np.isnan(rgb).any(axis=1)]
    if len(rgb):
        green = (rgb[:, 1] > rgb[:, 0] * 1.06) & (rgb[:, 1] > rgb[:, 2] * 1.06)
        if (~green).sum() >= 4:
            rgb = rgb[~green]
        out["roof_rgb"] = np.median(rgb, axis=0)

    if not has_lidar or len(hs) < 6 or np.median(hs) < 1.5:
        return out  # not in the 2018 lidar (newer, or demolished): keep the map's height

    # Pixel centres in local metres; they sit inside the shifted footprint.
    loc = (Jinv @ np.vstack([xs + x0 + 0.5 - mx[2], ys + y0 + 0.5 - my[2]])).T
    lx, lz = loc[:, 0], loc[:, 1]
    xr, zr = x + sx, z + sz
    box = oriented_box(xr, zr)
    if box is None:
        return out
    _, ux, uz = box
    u = xr * ux + zr * uz
    v = -xr * uz + zr * ux
    pu_all = lx * ux + lz * uz
    pv_all = -lx * uz + lz * ux
    area = abs(0.5 * np.sum(xr * np.roll(zr, -1) - np.roll(xr, -1) * zr))
    box_area = (u.max() - u.min()) * (v.max() - v.min())
    rect = area / box_area
    whole = [(u.min(), u.max(), v.min(), v.max())]
    options = []
    if rect > 0.7:
        options.append(whole)
    if rect < 0.92:
        split = rect_parts(u, v)
        if split and len(split) > 1:
            options.append(split)
    best = None
    for rects in options:
        parts, score = fit_parts(rects, ux, uz, pu_all, pv_all, hs, house and area < 450)
        if parts and (best is None or score < best[1]):
            best = (parts, score)
    if best is None:
        # Irregular footprint: one flat roof at the lidar height.
        e = float(np.median(hs[hs > 1.5])) if (hs > 1.5).sum() >= 4 else float(np.median(hs))
        out["height"] = max(e, 2.2)
        return out
    parts = best[0]
    out["parts"] = parts
    out["height"] = max(p[8] for p in parts)
    return out
