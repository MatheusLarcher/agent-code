#!/usr/bin/env python3
"""Wall-thickness and breach checking that is fast AND trustworthy.

Two modes:

  1) Shell self-thickness (thinnest wall anywhere in one part):
         python3 wallcheck.py shell.stl --min-wall 1.2
     Ray-based: samples the surface and measures material depth along the inward
     normal (trimesh.proximity.thickness). Reports the 1st percentile (robust
     against grazing rays) and the minimum.

  2) Breach check: parts packed INSIDE a shell must keep >= min-wall of material
     between themselves and the outside world:
         python3 wallcheck.py shell.stl cell.stl board.stl --min-wall 1.5
     Voxel distance-transform: the shell is voxelized and FILLED to its solid outer
     form (so it works for hollowed shells and clamshell halves alike), scipy EDT
     gives every voxel's distance to the outside, and each part's surface samples
     look up their depth. Accuracy ~ the voxel pitch (min-wall/4 by default).

Why this exists: naive approaches burned days on a real project. mesh.contains()
probes are ambiguous exactly at seam planes and count clearance gaps as breaches;
KDTree sign estimates disagree with true signed distance; exact signed_distance on
a 1M+ face decorative scan takes minutes per evaluation. The voxel EDT recipe here
is what finally converged: minutes -> seconds, no false seam breaches, and multi-body
shells are unioned by the fill instead of false-alarming at the seam.

Exit code 1 when a wall is below --min-wall, so a Makefile can gate on it.
"""
import argparse, sys
import numpy as np
import trimesh


def self_thickness(shell, min_wall, n=1500):
    pts, fid = trimesh.sample.sample_surface(shell, n)
    th = trimesh.proximity.thickness(shell, pts, method="ray")
    th = th[np.isfinite(th) & (th > 1e-3)]
    if th.size == 0:
        sys.exit("no valid thickness rays; is the mesh watertight?")
    return float(np.percentile(th, 1)), float(th.min())


def breach_check(shell, parts, names, min_wall, pitch):
    from scipy import ndimage
    vg = shell.voxelized(pitch).fill()          # solid outer form, cavities filled
    # pad one empty voxel of margin: the matrix spans exactly the mesh bounds, and
    # EDT needs to see "outside" beyond the outermost solid voxels
    mat = np.pad(vg.matrix, 1, constant_values=False)
    edt = ndimage.distance_transform_edt(mat) * pitch
    results = []
    for name, part in zip(names, parts):
        pts, _ = trimesh.sample.sample_surface(part, 2000)
        idx = np.round(trimesh.transformations.transform_points(
            pts, np.linalg.inv(vg.transform))).astype(int) + 1   # +1 for the pad
        inb = np.all((idx >= 0) & (idx < mat.shape), axis=1)
        depth = np.zeros(len(pts))
        ii = idx[inb]
        depth[inb] = edt[ii[:, 0], ii[:, 1], ii[:, 2]]
        i = int(np.argmin(depth))
        results.append((name, float(depth[i]), pts[i]))
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("shell", help="outer shell mesh (STL/GLB)")
    ap.add_argument("parts", nargs="*", help="internal parts for breach mode")
    ap.add_argument("--min-wall", type=float, default=1.2)
    ap.add_argument("--pitch", type=float, default=None,
                    help="voxel pitch for breach mode (default min-wall/4)")
    args = ap.parse_args()

    shell = trimesh.load(args.shell, force="mesh")
    print(f"shell: {len(shell.faces)} faces, volume={shell.is_volume}")

    if not args.parts:
        p1, tmin = self_thickness(shell, args.min_wall)
        ok = p1 >= args.min_wall
        print(f"thinnest wall ~ {p1:.2f} mm (p1; absolute min {tmin:.2f}) "
              f"{'OK' if ok else f'< {args.min_wall} FAIL'}")
        sys.exit(0 if ok else 1)

    pitch = args.pitch or args.min_wall / 4
    print(f"breach mode: voxel pitch {pitch:.2f} mm (results good to ~that)")
    parts = [trimesh.load(p, force="mesh") for p in args.parts]
    fails = 0
    for name, depth, pt in breach_check(shell, parts, args.parts, args.min_wall, pitch):
        loc = f"at ({pt[0]:.1f},{pt[1]:.1f},{pt[2]:.1f})"
        if depth <= pitch:                       # at/outside the outer skin
            print(f"  X  {name}: BREACH, reaches the outside surface {loc}")
            fails += 1
        elif depth < args.min_wall:
            print(f"  !  {name}: wall {depth:.2f} mm < {args.min_wall} {loc}")
            fails += 1
        else:
            print(f"  ok {name}: min wall {depth:.2f} mm")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
