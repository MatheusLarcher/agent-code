# CSG robustness: the trimesh/manifold3d boolean playbook

Boolean artifacts are the #1 pure-geometry time sink: phantom "windows" in housings,
half-circle slivers around screw pockets, wall "fins" hanging off lids, sealed voids where
cavities should connect, and "Not all meshes are volumes!" storms (318 watertight failures
logged in one project). This is the playbook distilled from what actually fixed them.

## Prevention

- **One boolean call, many operands.** `difference(base, [c1, c2, ...])` /
  `union([a, b, c])` in a single call is dramatically more robust than chaining
  `base - c1 - c2 - ...`. A sequential per-ear subtraction produced corrupt geometry the
  single-call version didn't. manifold re-canonicalizes once instead of accumulating
  near-degenerate intermediates.
- **Do the thinking in 2D (shapely), extrude late.** 2D polygon ops are exact and
  debuggable; 3D boolean surgery on the result is where artifacts breed. When a 2D clip
  region leaks arcs into the extrusion (the "half circles everywhere" bug: a circular
  clip boundary contaminating ear outlines), **morphological close** the polygon first:
  `poly.buffer(+w).buffer(-w)` removes boundary slivers below width `w`.
- **Coincident geometry is the enemy.** Faces, edges, or vertices that exactly touch
  (gear tooth feet on a root circle, a cutter flush with a wall) generate zero-thickness
  shards. Jitter one operand by 0.01 mm (`buffer(0.01).buffer(-0.01)` in 2D, or oversize
  a cutter 0.1 mm past the face it exits) so nothing is exactly coplanar.
- **Cutters must fully pierce.** A subtraction whose cutter ends exactly at a surface
  leaves a membrane. Extend cutters well past both faces.
- **A cutter can erase a smaller positive.** `difference` after `union` deletes any
  feature that lives inside the cut volume (a collar smaller than the port hole being
  subtracted vanished entirely). Order: cut the openings first, then union small external
  features, or exclude the feature's volume from the cutter.
- **Late unions reseal cuts.** Corner gussets, decks, or "reinforce after" unions
  re-fill driver wells and cable exits if keepouts are not re-subtracted. Register
  functional openings as keepouts for every post-cut union (R3.2).
- **Never reuse the same trimesh instance as both cutter and keepout.** Manifold may
  consume or corrupt the mesh; build fresh keepout solids for the second pass. Reuse
  was enough to make `cover_front` non-volume after an otherwise correct well cut.
- **Crush ribs after pocket cuts**, or the relief that opens the bay guts the rib
  annulus. Union ribs last; gate pilot-meat annulus volume in solid plastic.
- **Structural underface first, openings second.** Hollowing a free-span face then
  hoping ribs appear leaves membranes the thin-shell audit must catch.

## Diagnosis, when a boolean output is wrong anyway

- `mesh.is_volume` per INPUT, not just the output. manifold throws "Not all meshes are
  volumes!" naming neither operand; bisect by checking each input.
- `mesh.split(only_watertight=False)` on the output: an artifact usually shows up as
  extra small bodies (a "1882-body" part happened). Keeping `max(bodies, key=volume)` is
  a legitimate last-resort cleanup for known-good outer shells, but treat it as a bandage
  and find the coincident geometry that produced the shards.
- A parameter change that "tips a fragile boolean into non-watertight" (bezel overlap
  3.5 -> 1.5 broke a build) means two features started sharing a face at the new value.
  Don't hunt the magic number; jitter or restructure the operands.
- When an artifact resists two fix attempts, stop tweaking offsets and re-derive the 2D
  outline; research agents found root causes in the profile construction both times this
  happened.

## The deeper fix: stop hand-rolling BREP problems in mesh land

The skill already says it, and no project has done it yet, so here is the on-ramp. For
NEW parametric parts with fillets/chamfers/threads, build123d avoids the entire artifact
class above (true solids, exact booleans):

```bash
python3.11 -m venv .venv && .venv/bin/pip install build123d bd_warehouse
```
```python
from build123d import *          # needs Python >= 3.10
with BuildPart() as p:
    Box(40, 30, 12)
    with Locations((0, 0, 6)):   # pocket, filleted, exact
        Box(30, 20, 8, mode=Mode.SUBTRACT)
    fillet(p.edges().filter_by(Axis.Z), 2)
export_stl(p.part, "part.stl")   # then the normal viewer/shoot loop applies unchanged
```
Keep trimesh+manifold for mesh inputs (downloaded STLs, scan surgery) and as the boolean
engine of last resort. The viewer/verify loop is identical either way.

## Iteration speed: don't rebuild the world per tweak

100+ full `build.py` runs per session is normal; make each run cheap. finnish-doors
(2026-07-22) measured this on a mature multi-subsystem assembly and the numbers are
blunt: **geometry generation was ~3 s; the fit/contact audit was ~280–320 s (~99%)**.
Never optimise the wrong half.

### Measure first (build metrics)

Instrument stages with wall-time + peak RSS *before* guessing. A small module
(`src/metrics.py` in finnish-doors) is enough:

- Nestable `with metrics.timed("housing"):` / `export.fitmap` around every expensive step.
- Print a ranked table at the end; write `web/build_metrics.json` (latest).
- **Archive every run** under `metrics/runs/<utc>_<gitsha>[_label].json` + append
  `metrics/index.jsonl` so later sessions can compare.
- Named pins: `python3 src/metrics.py save pre-change` → `metrics/baselines/<label>.json`.
- Compare: `python3 src/metrics.py compare prev latest` or
  `compare baseline:pre-change latest`. Warn when `SKIP_FITS` differs (totals are not
  comparable if one run skipped the audit).
- Label runs: `BUILD_METRICS_LABEL=post-fitmap-cache python3 src/build.py`.
- Disable: `BUILD_METRICS=0`; quiet JSON-only: `BUILD_METRICS=quiet`.

Without this, agents "optimise" housing booleans while fitmap still owns the wall clock.

### Content-hash part cache (the real lever)

Once metrics show which stages dominate, add a content-hash cache (finnish-doors
`src/build_cache.py`, layout `.cache/build/` gitignored):

| Layer | Key (inputs only) | On hit |
|-------|-------------------|--------|
| Per-part STL | `params.py` + builder modules + flag tokens | load STL, skip CSG |
| Shared generators | e.g. `gen_flat_worm` called from build + coupon + assembly | compute once |
| Assembly export | input STL digests + placement sources + env (`DRIVE`, `SKIP_FITS`) | skip GLB rebuild |
| **Fitmap** | **posed-assembly fingerprint** (or same input digests) | reuse `fit_report.json` |

**Hard rules (learned the expensive way):**

1. **Key on INPUTS only. Never content-hash noisy outputs.** `fit_report.json` (signed
   distance + intersection volumes) has float noise: hashing it as a validity input makes
   every warm rebuild re-run the 280 s audit. Outputs need only *exist* on hit.
2. **Optionally pin input STL digests** in the manifest and re-check them so a silent
   overwrite of an STL still misses. Do not pin output content.
3. **Share expensive generators.** A 3-start worm rebuilt three times per run (export STL,
   coupon, assembly pose) is pure waste; put the cache *inside* the generator.
4. **Restore mutable build state on hit.** If the housing builder writes
   `state.HOUSING_Z0/Z1` for downstream boxes, stash those in the cache `meta` and restore
   on load (loading STLs does not re-run the writer).
5. **Controls:** `BUILD_CACHE=0` force rebuild; `BUILD_CACHE_CLEAR=1` wipe
   `.cache/build/`; print hit/miss per key + summary (`hits=10 misses=0 hit_rate=100%`).
6. **Measured win (finnish-doors, no geometry change):** cold ~300–325 s → warm **~0.8 s**,
   peak RSS ~14 GB → ~300 MB, when assembly+fitmap both hit.
7. **The assembly-export key must content-fingerprint the PLACEMENT source files** (a
   declared `ASSEMBLY_SOURCE_DEPS` list: assembly.py + everything that poses parts),
   not just the input STL digests. Placement/pose edits change no STL, and without the
   source fingerprint they serve a stale GLB — the bug looks like "my edit did nothing".
   With it, placement edits bust the cache automatically and `BUILD_CACHE_CLEAR=1` is
   only ever needed for a corrupt manifest.

`make watch` / live loops should keep `SKIP_FITS=1` (or full assembly-cache hit) so the
viewer stays snappy; run `make fits` / a canonical full build when gates need the report.

### Fitmap cost anatomy (so you know what to skip)

A full fitmap pass on ~30–40 nodes (finnish-doors):

- ~C(n,2) AABB prune → ~100–130 "close" pairs actually sampled.
- Per close pair: ~2600 surface samples + `signed_distance` (**~280 s**, the wall).
- Boolean `intersection` only on press candidates (**~1 s**).
- `gc.collect()` after **every** pair cost **~5 s** for little OOM benefit; every 20 pairs
  + once at the end is enough (~0.2 s). Still clear trimesh `_cache` per pair.
- Seed surface sampling (`seed=0`) so the report is as stable as possible for git.

Cache key for fitmap: fingerprint the *posed* assembly dict after any display→parametric
swaps (name + face/vert counts + rounded bounds/area + a few vertex anchors). That is
what signed_distance actually sees; STL digests alone miss pose bugs.

### Other speed tactics (still useful)

- **Cache expensive foreign imports.** An 85 MB STEP re-tessellated on every build made
  sweeps unusable. Hash the source file, cache tessellation
  (`.cache/` or `.claude/cache/<sha>.npz`), load instead of re-importing.
- **`PREVIEW=1` mode**: lower `n_theta`/segment counts, skip STL export (GLB only), skip
  the heaviest decorative parts. Full resolution only for `EXPORT=1`. Threaded parts at
  preview resolution are ~10x fewer faces and still fine in the viewer.
- **Per-part rebuild targets** (`make housing`), so a housing tweak doesn't regenerate
  gears (or rely on the content-hash cache above).
- **Placement/parameter sweeps against a coarse proxy.** Optimize against a decimated or
  voxel-remeshed skin (~5x faster per evaluation), then validate the winner against the
  full-res mesh (see `wallcheck.py`). Precompute anything reused across evaluations
  (centerline lookup tables); a sweep that recomputes a centerline per point earns a kill.
- Long sweeps: run foregrounded with progress prints and unbuffered output
  (`python3 -u`), not backgrounded-and-polled; buffered background jobs look hung, invite
  duplicate launches ("three duplicate sweeps competing"), and time out monitors.


## trimesh's boolean wrapper injects phantom geometry (desk-pi, 2026-07-14)

On complex meshes, `trimesh.boolean.union/difference/intersection(engine="manifold")`
(trimesh 4.12) can HALLUCINATE material neither input has: an intersection grew a
0.2 mm bulge on a rib face; a compound union of overlapping coplanar boxes grew
150 mm3 inside a probe window its inputs couldn't fill. The same operands through
manifold3d's own API came out exact. Rules that ended it:

- Call manifold3d DIRECTLY (f32 `Mesh`; rewrap with `Trimesh(..., process=False)`).
  The f64 `Mesh64` path produced its own artifacts on this trimesh/manifold combo.
- Never union many overlapping coplanar volumes in one call. Build capture regions
  as ONE shapely 2D `unary_union` extruded once; union added bodies PAIRWISE.
- `trimesh.contains()` is ray-parity and LIES near coincident faces. Probe with a
  manifold cube intersection instead: `(Manifold(mesh) ^ cube_at_point).volume()`.
- Boolean facet residue owns the last ~0.02 mm3: keep placeholder-to-part design
  clearances >= 0.3, and expect zero-thickness sheets where a cut plane lies
  exactly on an open face (shave 1 micron with a capped slice).
- Silent tooling corollary: `str.replace` edits without an assert and gates run
  through `| tail` (exit code masked) let two of these "fixes" no-op unnoticed.
