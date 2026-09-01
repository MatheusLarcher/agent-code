#!/usr/bin/env python3
"""Pre-export assembly gate: pairwise interference + clearance audit of a multi-part
assembly, plus an optional motion sweep. Run this BEFORE every Bambu export and before
declaring any assembly "done". Watertight checks and multi-angle renders have repeatedly
passed on assemblies that could not physically be assembled (bayonet lugs bigger than
their notches, bearings buried in sealed pockets, gears interpenetrating their housing);
this script is the numeric gate those bugs slipped through.

    python3 assembly_check.py web/assembly.glb
    python3 assembly_check.py web/assembly.glb --clearance 0.4
    python3 assembly_check.py web/assembly.glb --allow worm:worm_wheel --allow pin:ear
    python3 assembly_check.py web/assembly.glb --sweep cradle=X:-45:45:7 --pivot 0,80,62

Checks, per part pair:
  OVERLAP    boolean intersection volume > 0 (parts interpenetrate). FAILS the gate
             unless the pair is whitelisted via --allow a:b (meshing gear teeth and
             designed press-fit interference are the legitimate cases; everything
             else is a print-blocker).
  TIGHT      minimum surface-to-surface distance below --clearance (default 0.3 mm).
             Reported, not fatal: FDM parts that close to each other will fuse or bind
             unless they are meant to touch.

--sweep NAME=AXIS:START:END:STEPS rotates part NAME about global AXIS (X/Y/Z) through
[START,END] degrees in STEPS steps (pivot from --pivot x,y,z, default the part centroid)
and re-runs the overlap check at every step against all other parts. This is how the
"tilt only reaches -11 deg before colliding" class of bug is caught in CAD instead of
in plastic.

Exit code 1 on any non-whitelisted overlap, so a Makefile can gate on it:
    check: build
\t python3 src/assembly_check.py web/assembly.glb

What this does NOT check (still needs eyes + the checklist in
references/assembly-verification.md): insertion paths (a bearing can be clear of its
pocket yet unreachable through the opening), torque paths (a plain bore freewheels even
with perfect clearance), and fastener reach. Verify those with section renders and
design-invariant checks.
"""
import argparse

# When big prints are SPLIT for speed (e.g. head_back -> head_back_frame_L/_R +
# head_back_panel_L/_R), map each piece to its parent object here so existing
# whitelist pairs keep working and sibling seam contact is allowed.
SPLIT_ALIAS = {}
import itertools
import sys
import numpy as np
import trimesh


def load_parts(path):
    """name -> world-transformed Trimesh (same-name nodes merged)."""
    loaded = trimesh.load(path)
    if isinstance(loaded, trimesh.Trimesh):
        return {"part": loaded}
    parts = {}
    for node in loaded.graph.nodes_geometry:
        T, gname = loaded.graph[node]
        m = loaded.geometry[gname].copy()
        m.apply_transform(T)
        key = node or gname
        if key in parts:
            parts[key] = trimesh.util.concatenate([parts[key], m])
        else:
            parts[key] = m
    return parts


def overlap_volume(a, b):
    """Intersection volume in mm^3, or None if boolean failed (non-volume input)."""
    try:
        inter = trimesh.boolean.intersection([a, b], engine="manifold")
        if inter is None or inter.is_empty:
            return 0.0
        return abs(inter.volume)
    except Exception:
        return None


def min_distance(a, b, n=800):
    """Approx min surface-to-surface distance via sampled points (unsigned)."""
    pts, _ = trimesh.sample.sample_surface(a, n)
    d = trimesh.proximity.ProximityQuery(b).on_surface(pts)[1]
    return float(d.min())


def bbox_gap(a, b):
    """Cheap lower bound on the gap between two AABBs (0 if they overlap)."""
    lo = np.maximum(a.bounds[0], b.bounds[0])
    hi = np.minimum(a.bounds[1], b.bounds[1])
    gap = np.maximum(lo - hi, 0)
    return float(np.linalg.norm(gap))


def audit(parts, clearance, allow, label=""):
    failures, warnings = [], []
    names = sorted(parts)
    for na, nb in itertools.combinations(names, 2):
        a, b = parts[na], parts[nb]
        if bbox_gap(a, b) > clearance:
            continue
        vol = overlap_volume(a, b)
        # print-speed sub-splits: pieces of one object alias to the parent for the
        # whitelist lookup, and same-parent pieces may touch (their designed seam).
        na, nb = SPLIT_ALIAS.get(na, na), SPLIT_ALIAS.get(nb, nb)
        if na == nb:
            continue
        pair = frozenset((na, nb))
        if vol is None:
            warnings.append(f"  ?  {na} vs {nb}: boolean failed (non-volume mesh), "
                            f"fix watertightness and re-run")
            continue
        if vol > 1e-3:
            line = f"{na} vs {nb}: OVERLAP {vol:.2f} mm^3{label}"
            if pair in allow:
                warnings.append(f"  ~  {line} (whitelisted)")
            else:
                failures.append(f"  X  {line}")
            continue
        d = min_distance(a, b)
        if d < clearance:
            warnings.append(f"  !  {na} vs {nb}: TIGHT {d:.2f} mm (< {clearance}){label}")
    return failures, warnings


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("model", help="assembly GLB/STL (named parts)")
    ap.add_argument("--clearance", type=float, default=0.3,
                    help="warn when parts are closer than this many mm (default 0.3)")
    ap.add_argument("--allow", action="append", default=[], metavar="A:B",
                    help="whitelist an intentionally-interfering pair (repeatable)")
    ap.add_argument("--sweep", metavar="NAME=AXIS:START:END:STEPS",
                    help="rotate NAME about AXIS through [START,END] deg and re-check")
    ap.add_argument("--pivot", metavar="X,Y,Z",
                    help="sweep pivot point (default: swept part centroid)")
    args = ap.parse_args()

    parts = load_parts(args.model)
    print(f"{len(parts)} parts: {', '.join(sorted(parts))}\n")
    allow = {frozenset(p.split(":", 1)) for p in args.allow}

    failures, warnings = audit(parts, args.clearance, allow)

    if args.sweep:
        name, spec = args.sweep.split("=", 1)
        axis_s, start, end, steps = spec.split(":")
        if name not in parts:
            sys.exit(f"--sweep part '{name}' not in model")
        axis = {"X": [1, 0, 0], "Y": [0, 1, 0], "Z": [0, 0, 1]}[axis_s.upper()]
        pivot = (np.array([float(v) for v in args.pivot.split(",")])
                 if args.pivot else parts[name].centroid)
        for ang in np.linspace(float(start), float(end), int(steps)):
            R = trimesh.transformations.rotation_matrix(np.radians(ang), axis, pivot)
            swept = dict(parts)
            swept[name] = parts[name].copy()
            swept[name].apply_transform(R)
            f2, w2 = audit({k: v for k, v in swept.items()},
                           args.clearance, allow, label=f" @ {name} {ang:+.0f} deg")
            # only report pairs involving the swept part; static pairs were done above
            def moving(x):
                return f"{name} vs " in x or f" vs {name}:" in x
            failures += [x for x in f2 if moving(x)]
            warnings += [x for x in w2 if moving(x)]

    for w in warnings:
        print(w)
    for f in failures:
        print(f)
    if failures:
        print(f"\nGATE FAILED: {len(failures)} interference(s). Do not export/print.")
        sys.exit(1)
    print(f"\nGATE PASSED ({len(warnings)} warning(s)). "
          f"Still verify insertion paths + torque paths by eye/section.")


if __name__ == "__main__":
    main()
