#!/usr/bin/env python3
"""Design-invariant tests: unit tests for geometry. Copy into src/checks.py, call
run_checks(parts) at the END of every build.py run.

WHY: across real projects, user-approved features were silently deleted by later,
unrelated edits (a manual-override key removed three separate times; fix-agent ledgers
marked done for edits that never applied; a lid that quietly became a sealed box).
Renders don't catch a MISSING feature, because nobody looks for what isn't there.

THE RULE: every time the user approves a design requirement ("manual override stays",
"tilt must reach +/-30 deg", "the bearing drops in from +Z"), encode it here as one
check THE SAME TURN. Never delete or weaken a check without the user's explicit
sign-off; a failing check means the geometry regressed, not that the check is stale.
Build fails loudly on any regression, so the feature cannot vanish silently.

Helpers below cover the recurring invariant shapes: existence, dimension envelopes,
bore piercing (probed along the REAL feature axis; planar sampling false-alarms on
slanted/staggered holes), pocket-open-from-direction (the "lid that isn't a lid"
class), pairwise clearance, and keyed-bore (anti-freewheel) checks.
"""
import sys
import numpy as np
import trimesh

_results = []


def check(name, ok, detail=""):
    _results.append((name, bool(ok), detail))
    print(f"  {'ok ' if ok else 'X  '}{name}" + (f"  ({detail})" if detail else ""))
    return bool(ok)


def finish():
    fails = [n for n, ok, _ in _results if not ok]
    print(f"\n{len(_results) - len(fails)}/{len(_results)} invariants hold")
    if fails:
        print("REGRESSED: " + ", ".join(fails))
        sys.exit(1)


# ---------------------------------------------------------------- invariant helpers

def bore_pierces(mesh, start, direction, length, n=60):
    """True if a bore is open along its real axis: probe points along the axis must
    all be OUTSIDE the solid. start/direction in mm / unit vector."""
    d = np.asarray(direction, float)
    d /= np.linalg.norm(d)
    pts = np.asarray(start, float) + np.outer(np.linspace(0, length, n), d)
    return not mesh.contains(pts).any()


def open_from(mesh, point, direction, reach=500.0):
    """True if `point` (e.g. a pocket floor center) can be reached from `direction`
    without passing through the solid, i.e. the pocket is open (a bearing/motor can
    actually be inserted). Catches the sealed-void 'lid that is not a lid' class."""
    d = np.asarray(direction, float)
    d /= np.linalg.norm(d)
    pts = np.asarray(point, float) + np.outer(np.linspace(1e-3, reach, 120), d)
    return not mesh.contains(pts).any()


def clearance(a, b, n=600):
    """Approx min surface distance between two parts (mm)."""
    pts, _ = trimesh.sample.sample_surface(a, n)
    return float(trimesh.proximity.ProximityQuery(b).on_surface(pts)[1].min())


def bore_is_keyed(mesh, center, axis, radius, z, n=90):
    """True if a bore section at height z deviates from a plain circle (D-flat, key,
    spline). A perfectly round result means the 'driven' part FREEWHEELS on its
    shaft; torque paths through plain bores have shipped to plastic twice."""
    ax = np.asarray(axis, float); ax /= np.linalg.norm(ax)
    # two perpendicular vectors spanning the section plane
    u = np.cross(ax, [1, 0, 0]); u = np.cross(ax, [0, 1, 0]) if np.linalg.norm(u) < 1e-6 else u
    u /= np.linalg.norm(u); v = np.cross(ax, u)
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    ring = (np.asarray(center, float) + z * ax
            + radius * (np.outer(np.cos(th), u) + np.outer(np.sin(th), v)))
    inside = mesh.contains(ring)
    # plain bore: no ring point at bore radius is inside the solid; keyed: some are
    return inside.any()


# ------------------------------------------------------------------ example usage
if __name__ == "__main__":
    print("""Copy into src/checks.py and call from build.py, e.g.:

    from checks import check, finish, bore_pierces, open_from, clearance, bore_is_keyed

    # user-approved 2026-07-06: manual override must exist
    check("manual override key present", "override_key" in parts)
    # user-approved: wire hole actually pierces the housing (probe the REAL axis)
    check("wire bore pierces", bore_pierces(parts["housing"], WIRE_XYZ, WIRE_AXIS, WALL*2))
    # the lid must be a lid: bearing pocket reachable from +Z
    check("608 pocket open from +Z", open_from(parts["lid"], POCKET_FLOOR, [0,0,1]))
    # gear must not freewheel: bore keyed, not plain round
    check("wheel bore keyed", bore_is_keyed(parts["wheel"], WHEEL_C, [0,0,1], BORE_R+0.05, 2))
    # envelope: whole assembly fits the A1 bed
    check("fits 256 bed", all(assembly.extents[:2] <= 256), f"{assembly.extents}")
    finish()
""")
