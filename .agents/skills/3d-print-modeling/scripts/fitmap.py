#!/usr/bin/env python3
"""fitmap.py — pairwise FIT / FRICTION map for an assembled model (GLB with named parts).

For every pair of parts whose AABBs come within `--near` mm, sample the smaller part's
surface and take signed distances into the other. Emits fit_report.json:

    [{"a": "ring_gear", "b": "planet_a",
      "mm": 0.18,            # + = min clearance, − = press/interference depth
      "press": false,
      "at": [x, y, z],       # the closest-approach sample point
      "patch": [[x,y,z,d]]}] # every sample within --patch mm of the other part, with its
                             # own clearance — a point cloud tracing the SHAPE of the
                             # contact area (a rib line, a bore ring, gear-flank stripes)

The companion viewer (viewer_glb.html) renders fit_report.json as a "Fits" panel: rows
sorted tightest-first plus color-coded 3D contact patches (red press / amber <0.15 /
yellow <0.4 / green free), click a row to isolate one pair.

WHY THIS EXISTS (each clause a real shipped failure):
 - Boolean "no overlap" proves parts don't collide, NOT that they aren't PRESSED: a ring
   gear passed every interference check while its planets sat at 0.00° backlash (seized).
   Only a clearance MEASUREMENT distinguishes a free fit from a bind.
 - Pair enumeration is automatic, so it checks pairs you didn't think to check: its first
   run on a real assembly caught 3 defects hand-picked boolean checks had missed (a motor
   nose boss pressing into a gear hub, a gearbox axle pin stabbing a planet, a cage arc
   buried in the OTHER housing half — nobody had booleaned against the lid).
 - Designed press fits show up as PRESS rows — assert them, and treat any OTHER press row
   as a bug (like assembly_check.py's --allow whitelist).

Usage:
    python3 fitmap.py assembly.glb [-o fit_report.json] [--near 2.5] [--patch 0.6]
                      [--samples 2600] [--skip door battery] [--far 2.0]

COST (finnish-doors, 2026-07-22): on a ~30–40 node assembly this gate is often ~99% of
total build wall time (~280–320 s of signed_distance; booleans ~1 s). Keep it OUT of the
watch loop (SKIP_FITS=1 / make watch). Content-hash cache the result keyed by the *posed*
assembly fingerprint — never by fit_report.json content (float noise forces perpetual
misses). Clear trimesh caches every pair; gc.collect every ~20 pairs, not every pair.
See skill references/assembly-verification.md and csg-robustness.md ("Iteration speed").
"""
import argparse

# Split-piece -> parent-object aliases (see assembly_check.py SPLIT_ALIAS).
SPLIT_ALIAS = {}, json, sys
import numpy as np
import trimesh


def placed_meshes(path, skip=()):
    """name -> world-transformed mesh, from a GLB scene (or a single mesh file)."""
    loaded = trimesh.load(path)
    out = {}
    if isinstance(loaded, trimesh.Scene):
        for node in loaded.graph.nodes_geometry:
            T, gname = loaded.graph[node]
            name = node if node else gname
            if any(k in name.lower() for k in skip):
                continue
            m = loaded.geometry[gname].copy()
            m.apply_transform(T)
            out[name] = m
    else:
        out[path] = loaded
    return out


def fit_map(meshes, near=2.5, patch_band=0.6, samples=2600, far=2.0, seed=0, max_patch=260,
            designed=()):
    """designed: iterable of frozenset({a, b}) name pairs whose press is INTENDED (whitelist)."""
    designed = set(designed)
    names = sorted(meshes)
    rows = []
    rng = np.random.default_rng(seed)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = meshes[names[i]], meshes[names[j]]
            lo = np.maximum(a.bounds[0], b.bounds[0])
            hi = np.minimum(a.bounds[1], b.bounds[1])
            if np.any(lo - hi > near):
                continue                                   # AABBs further apart than `near`
            small, big = (a, b) if a.area <= b.area else (b, a)
            try:
                pts, _ = trimesh.sample.sample_surface(small, samples)
                d = trimesh.proximity.signed_distance(big, pts)   # >0 = inside `big`
            except Exception as e:
                print("  ! %s <-> %s failed: %s" % (names[i], names[j], e), file=sys.stderr)
                continue
            k = int(np.argmax(d))
            if d[k] < -far:
                continue                                   # nothing meaningfully close
            vol = 0.0
            if d[k] > 0.005:
                # BOOLEAN-CONFIRM presses: the sampler can glitch at sharp corners (a real case
                # reported PRESS 0.09 on a centered blade); the intersection volume is the truth
                try:
                    iv = trimesh.boolean.intersection([a, b])
                    vol = float(iv.volume) if iv is not None and len(iv.faces) else 0.0
                except Exception:
                    vol = -1.0                             # unknown — keep the press flag
            sel = np.where(d > -patch_band)[0]
            if len(sel) > max_patch:
                sel = rng.choice(sel, max_patch, replace=False)
            rows.append(dict(
                a=names[i], b=names[j],
                mm=round(float(-d[k]), 3),
                press=bool(d[k] > 0.005 and vol != 0.0),
                vol=round(vol, 2),
                designed=frozenset((SPLIT_ALIAS.get(names[i], names[i]),
                                    SPLIT_ALIAS.get(names[j], names[j]))) in designed
                         or SPLIT_ALIAS.get(names[i], names[i])
                         == SPLIT_ALIAS.get(names[j], names[j]),
                at=[round(float(x), 2) for x in pts[k]],
                patch=[[round(float(pts[q][0]), 2), round(float(pts[q][1]), 2),
                        round(float(pts[q][2]), 2), round(float(-d[q]), 3)] for q in sel]))
    rows.sort(key=lambda r: (-1e3 - r["mm"]) if r["press"] else r["mm"])
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("model", help="assembly GLB (named parts) or a mesh file")
    ap.add_argument("-o", "--out", default="fit_report.json")
    ap.add_argument("--near", type=float, default=2.5, help="AABB gap that counts as 'close' (mm)")
    ap.add_argument("--patch", type=float, default=0.6, help="patch band: samples within this of the other part (mm)")
    ap.add_argument("--samples", type=int, default=2600, help="surface samples per pair")
    ap.add_argument("--far", type=float, default=2.0, help="drop pairs whose closest approach exceeds this (mm)")
    ap.add_argument("--skip", nargs="*", default=[], help="substring name filters to exclude (context parts)")
    ap.add_argument("--allow", nargs="*", default=[], metavar="A:B",
                    help="pairs ALLOWED to touch/press (designed seats + press fits); anything else that touches fails")
    args = ap.parse_args()

    meshes = placed_meshes(args.model, skip=[s.lower() for s in args.skip])
    designed = {frozenset(p.split(":", 1)) for p in args.allow}
    rows = fit_map(meshes, near=args.near, patch_band=args.patch,
                   samples=args.samples, far=args.far, designed=designed)
    json.dump(rows, open(args.out, "w"), indent=1)
    # CONTACT AUDIT: every pair that TOUCHES (min clearance <= 0.005, or a confirmed press) must be
    # on the --allow whitelist. "Red only where it should be": an unexpected contact is how real fit
    # bugs announce themselves (four found this way on one assembly in one day).
    touching = [r for r in rows if r["press"] or r["mm"] <= 0.005]
    bad = [r for r in touching if not r["designed"]]
    print("wrote %s: %d close pairs, %d touching (%d designed)" % (
        args.out, len(rows), len(touching), len(touching) - len(bad)))
    for r in touching:
        kind = ("PRESS %.2f (boolean %.2f mm^3)" % (-r["mm"], r["vol"])) if r["press"] else "touching"
        print("  %s%s  %s <-> %s at %s" % ("ok " if r["designed"] else "!! ",
              kind, r["a"], r["b"], r["at"]))
    if bad:
        print("!! CONTACT AUDIT FAILED: fix the geometry, or --allow a:b only for designed seats/presses")
    return 1 if bad else 0    # nonzero exit for any UNLISTED touching/press pair


if __name__ == "__main__":
    sys.exit(main())
