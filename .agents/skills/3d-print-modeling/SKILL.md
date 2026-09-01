---
name: 3d-print-modeling
description: Author and iterate on 3D-printable parts as parametric Python (trimesh + manifold3d + shapely), then view and screenshot them headlessly to verify. Use when the user wants to design, modify, or print a mechanical part, gear/worm drive, enclosure, bracket, or any FDM/resin model, anything involving STL/3MF/GLB, build123d-style geometry, watertight CSG, or "make this part / make it bigger / make it printable". Also when the user asks to cut/split/section a model for the bed or reassembly (slicer-style cut + plug/dowel/snap/dovetail connectors in CAD). Covers the view-screenshot-iterate loop and FDM design rules. For Bambu .3mf slicer export see the bambu-3mf-export skill; for importing STEP/IGES/foreign CAD see foreign-cad-import.
---

# 3D-print modeling (Python-parametric, view-driven)

This is the workflow distilled from a series of FDM projects (worm-gear door drive, window
blind coupler, vortex shower head, tripod, turntable mount). The throughline: **geometry is
generated parametrically in Python, viewed in a browser, screenshotted headlessly, and
checked by eye on every change.** No GUI CAD (OpenSCAD/FreeCAD/Fusion) is needed, the geometry
engine is pip-installable Python: `build123d`/`CadQuery` (BREP) for new parts, `trimesh`+`manifold3d`
for meshes. See "Pick the engine first" below.

## The non-negotiable loop

1. **`build.py` is the single source of truth.** Put a `PARAMETERS` block at the top with
   every tunable + a one-line comment on *why* each value is what it is. Edit params, rerun,
   never hand-edit the mesh output.
2. **After every geometry change: rebuild, then LOOK at the render from multiple angles.**
   This is the non-negotiable verification step, not optional polish. Numeric and watertight
   checks miss the bugs that actually bite, wrong orientation, parts floating, collisions,
   holes not piercing, features distorted, a stretched-wrong axis. The drill:
   - `python3 serve.py` (once; port auto-derived per project, prints a LAN URL for the
     user's phone), then `python3 shoot.py <model>.glb chk` after each rebuild.
   - That writes **iso / front / side / top / BOTTOM + two section cuts** into **`.claude/renders/chk_*.png`**
     (the script always renders there, never the project root, so screenshots don't pollute the
     working dir). One angle is never enough, a part can look right head-on and be floating or
     colliding when seen from the side; the section cuts are how you confirm internal features
     (bores piercing, cavities connecting, wall thickness).
   - **Downscale, then actually Read every PNG**
     (`sips -Z 1400 .claude/renders/chk_iso.png --out .claude/renders/chk_iso_s.png`). Looking at
     the file path is not looking at the render. Read the image into the conversation and check it
     against what you intended.
   - Only then say done. If you couldn't render (no browser, no GLB), say so plainly instead of
     claiming the change works.
3. **Git checkpoint after each meaningful change.** These designs iterate fast and you want
   cheap reverts: `git add -A && git commit -m "<what changed>"`. Don't leave the tree dirty
   across iterations. (`git init` if the project isn't a repo yet.) Commit the source and the
   one current `web/assembly.glb`; gitignore renders and scratch iterations. See **Project layout**
   below for the exact commit-vs-ignore rule, it's the line the dual-axis-turntable got wrong
   (every `_t_*.glb`/`.3mf` iteration tracked at the repo root until it was unreadable).
4. **Keep a project `CLAUDE.md`** that records the mechanical intent, key numbers (and the
   tradeoff behind each), print orientation, and every hard-won gotcha. The next session reads
   it first. Update it as decisions land, don't wait for the end.
5. **Gate every export on the assembly audit + design invariants.** Watertight + pretty
   renders have repeatedly passed on assemblies that could not physically be assembled
   (lugs bigger than their notches, sealed "lids", freewheeling plain bores). Before any
   export: `python3 src/assembly_check.py web/assembly.glb` (pairwise interference +
   clearance + motion sweep, bundled) and `checks.py` design invariants (one assertion per
   user-approved feature, added the same turn it's approved, so features can't silently
   regress). Full protocol, insertion-path and torque-path audits included:
   **`references/assembly-verification.md`**.
6. **Never model a bought part from memory.** Datasheet, caliper, or user STL, then echo
   the dims back for confirmation before geometry depends on them. Guessed motors, boards,
   keypads, and battery holders have each cost a reprint. Measured library + checklist:
   **`references/components-verified.md`**.
7. **Seat pad ≠ clamp; seat-kiss ≠ body dig; OEM datums.** A pad that only rests has no
   preload. Blanket `A×B` / `NESTED_OK` designed-contacts hide digs (630 mm³ cover×carrier
   passed as "nests in bay"). Face kiss inside named seat envelopes is allowed; solid
   dig outside those envelopes fails. Hang mates off the measured OEM stack. Model
   coils/horns/board components that occupy volume. Full pattern set:
   **`references/hard-won-patterns.md`** (2026 intercom/Klonk, incl. residual deck,
   derived packaging envelopes, relief orphans).
8. **Derive packaging cuts from the printed mate's datums**, not a hardcoded bare-bought
   envelope. Stack under residual underface or tile thin-shell free spans. One body after
   CSG reliefs (no dig islands).

## Project layout (set this up before modeling, not after)

Every multi-part project here converged on the same shape. **finnish-doors is the reference layout,
copy it.** Retrofitting organization onto a littered root (the dual-axis-turntable's actual state:
loose `_t_*.glb`, `bambu_*.3mf`, and STLs all at top level) is the tax you pay for skipping this.
The discipline: **all Python in `src/`, output routed into `stl/<subsystem>/`, the live assembly in
`web/`, a `Makefile` as the front door, and `requirements.txt` pinned.**

```
project/
├── CLAUDE.md           mechanical intent, key numbers + the tradeoff behind each, print
│                       orientation, every gotcha. Read first each session; update as you go.
├── Makefile            the front door: make build / export / viewer / shot / all. Self-
│                       documenting via `## ` comments; a new session runs `make help` first.
├── README.md           one paragraph: what it is + how to build.
├── requirements.txt    PINNED deps (trimesh + manifold3d as a pair). `make install` runs it.
├── .gitignore          see "what to commit" below.
├── docs/               ASSEMBLY.md (BOM, which part on which plate, assembly order), motor/
│                       bearing datasheets, one reference Bambu .3mf for the profile template,
│                       and DESIGN-RULES.md (see "Seed the hard rules" below).
├── src/                ALL Python, run from repo root (`python3 src/build.py`):
│   ├── build.py          source of truth, PARAMETERS block at top
│   ├── build_<sub>.py    one per independent subsystem (keypad, conduit, ...), standalone
│   ├── params.py         design numbers (when the facade is split; edit HERE)
│   ├── metrics.py        stage wall-times + archived run history (see csg-robustness)
│   ├── build_cache.py    content-hash part/assembly/fitmap cache (.cache/build/)
│   ├── fitmap.py         clearance/press audit (often the slowest stage — cache it)
│   ├── stlpaths.py       routes stlp("worm.stl") -> stl/drive/worm.stl by name prefix
│   ├── export_bambu.py   packs parts onto plates, writes sliceable .3mf (bambu-3mf-export skill)
│   ├── bambu3mf.py        the .3mf writer
│   ├── serve.py          localhost viewer server
│   └── shoot.py          headless multi-angle renders -> .claude/renders/
├── stl/<subsystem>/    organized output: drive/, housing/, keypad/, ... (routed by stlpaths.py)
├── web/                viewer_glb.html + assembly.glb + assembly_dims.json (+ fit_report.json,
│                       build_metrics.json). serve.py serves THIS dir; auto-reloads on rebuild.
├── metrics/            optional: archived build timings (runs/, baselines/, index.jsonl) for
│                       compare-after-change. Small JSON; safe to commit named baselines.
├── .cache/build/       content-hash cache (gitignored; regenerable). BUILD_CACHE=0 to bypass.
├── exports/            Bambu .3mf plates, one per profile/material group.
└── firmware/           only if the project has electronics: the sketch + WIRING.md (pin map,
                        driver wiring, calibration constants). See dual-axis-turntable.
```

**`stlpaths.py` is the small piece that keeps the root clean.** Writers and readers both call
`stlp(name)`, which routes a bare filename to `stl/<subsystem>/name` by a prefix rule
(`worm_*`→drive, `housing_*`→housing). One rule, so the build, the assembly loader, and the Bambu
export stay in sync and nothing lands at the root. Bundled in `scripts/stlpaths.py`.

**The Makefile is the front door.** Targets seen across projects: `build` (rebuild all STLs +
`web/assembly.glb`), `export` (write Bambu plates), `viewer` (serve), `shot` (headless render),
`fits` (canonical fitmap), `watch` (rebuild with `SKIP_FITS=1` so the loop stays snappy),
`metrics-list` / `metrics-compare`, `install`, `all`. End each target line with a trailing
`## comment` so `make help` lists them. A subsystem with its own script gets its own target
(`make keypad` → `python3 src/build_rotary_keypad.py`). Bundled in `scripts/Makefile`.

**Conditional builds via env vars, not commented-out code.** dual-axis-turntable drives one
`build.py` with `EXPORT=1` (write STLs, else just the GLB for the viewer), `SHELL=0`, `TILT=45`
(preview tilt clearance at 45°), `NOZZLE08=1`. Clean way to get preview/variant modes out of a
single source of truth without forking the file.

**When one assembly's `build.py` outgrows ~1.5k lines, split it into per-subsystem MODULES**
(desk-pi hit 3.4k lines, then split into `params.py` / `geo.py` (shared box/cyl/boolean/screw
helpers + COLORS) / one module per physical subsystem (`head.py`, `neck.py`, `chassis.py`,
`tracks.py`, ...) / `build.py` reduced to the entry that poses and collects parts into the GLB).
Keep the import DAG one-way and record it in CLAUDE.md: params ← geo ← part modules ← build,
params imports nothing local, no cycles. This is a different pattern from the standalone
`build_<sub>.py` scripts above: standalone scripts are for INDEPENDENT parts, modules are for
one interconnected assembly whose parts share params and interfaces.

**Publish `web/` to GitHub Pages when the user wants the viewer off-LAN** (phone anywhere,
sharing a link). It works because `web/` is self-contained and `assembly.glb` is committed:

Prefer the AUTO-DEPLOY wiring (desk-pi endgame): a workflow that publishes `web/` on any
push to main that touches it, with the repo's Pages source set to "GitHub Actions"
(`gh api -X PUT /repos/<r>/pages -F build_type=workflow`; no gh-pages branch at all):

```yaml
# .github/workflows/pages.yml
on: {push: {branches: [main], paths: ["web/**"]}, workflow_dispatch: }
permissions: {contents: read, pages: write, id-token: write}
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: {name: github-pages, url: ${{ steps.d.outputs.page_url }}}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: {path: web}
      - {id: d, uses: actions/deploy-pages@v4}
```

Then the flow is just build -> commit -> push. (The manual fallback, a `make pages` that
subtree-pushes `web/` to a gh-pages branch, works but every forgotten run ships a stale
viewer.) Add `web/.nojekyll` (empty) and a `web/index.html` meta-refresh redirect to the
viewer page. Note the commit that ADDS the workflow usually doesn't touch `web/`, so
trigger the first deploy by hand (`gh workflow run pages.yml`).

**What to commit vs ignore** (the line the turntable got wrong):
- **Commit:** `src/`, `stl/`, `web/assembly.glb` + `web/assembly_dims.json`, `docs/`, `CLAUDE.md`,
  `Makefile`, `requirements.txt`. Committing the current `assembly.glb` means a fresh clone shows
  the part in the viewer with no rebuild, and you get a visual diff history.
- **Ignore:** `.claude/renders/`, scratch/iteration GLBs (`_t_*`, `_test_*`), `exports/*.3mf`
  (regenerable), videos (`*.mp4 *.mov *.avi`), `__pycache__/`, **`.cache/`** (content-hash build
  cache). Minimum `.gitignore`:
  ```
  .claude/renders/
  .cache/
  _t_*
  _test_*
  exports/*.3mf
  *.mp4
  *.mov
  __pycache__/
  ```
  The anti-pattern: tracking every `_t_*.glb`/`.3mf` iteration at the repo root. It works, but the
  root becomes unreadable. Route outputs into `stl/` + `exports/` and ignore the scratch.
  Optional: commit `metrics/baselines/*.json` (named timing pins) so cold vs warm / pre vs post
  change comparisons survive clones; leave raw `metrics/runs/` untracked if it gets noisy.

### Variants on the layout

- **Single quick part:** skip `src/`, just `build.py` + the bundled scripts at root. Graduate to the
  full layout the moment a second part appears.
- **Part-by-part** (user drives one part at a time: "now a bolt", "now a nut that fits it"):
  `build_all.py` at root discovers `parts/*.py` via importlib, each module defining `build() ->
  trimesh mesh`; shared helpers in `lib.py` (`save(mesh,name) -> stl/<name>.stl`, plus reusable
  generators like `threaded_rod(major_d,pitch,length)` feeding both the bolt and the nut). Keep
  `lib.py` + `build_all.py` at the ROOT (parts do `from lib import ...`; moving lib breaks that);
  scripts in `tools/` compute ROOT from `__file__` so they run from anywhere.
- **Foreign-CAD-centric** (you start from a downloaded STEP, not parametric source): `cad/` holds
  the STEP, `parts/<subassembly>/` holds pre-exported STLs grouped by subassembly with design
  iterations kept side by side (`Spool_V1/`, `Spool_V2/`), `tools/` holds the import/analysis
  scripts. This is the finnish-windows shape; see the **foreign-cad-import** skill for the gmsh
  tessellation + OCP hole/screw-BOM pipeline.

## Generating a parts KIT (multi-agent fan-out)

When the user wants MANY independent parts at once ("add connectors and function parts",
"a family of bolt variants"), and they've opted into multi-agent work, **fan out one subagent
per part, in parallel** (all Agent calls in one message). Measured on this project: 10 + 9 parts,
every one watertight on first build, ~44k tokens / ~1 min each. Rules that made it work:

- **Each agent creates ONLY its own `parts/<name>.py`** and verifies it
  (`python3 -c "from parts.<name> import build; m=build(); print(m.is_volume, ...)"`). It must NOT
  run `build_all.py`, touch `lib.py`, or edit other parts. Distinct new files = safe concurrent
  writes, no merge conflict. The orchestrator runs `build_all.py` ONCE after all agents return.
- **The speedup is SHARED HELPERS, not the agents.** Without them every agent re-derives the same
  geometry and re-types the same constants with *drifting names* (`INNER` vs `SLEEVE_IN` vs `43.0`),
  which also breaks single-source-of-truth (change the section once and 20 files silently disagree).
  So FIRST factor the common geometry + a constants block into `lib.py`
  (e.g. `SEC`, `SLEEVE_INNER`, `BORE`, `NUT_SQ` + `sleeve()`, `bolt_hole()`, `nut_pocket()`,
  `countersink()`), THEN **hand the helper API to each agent in its prompt** so they compose instead
  of invent. Drop a `parts/_template.py` (import line + helper cheat-sheet) to copy from.
- **Batch a tight family into ONE agent** when the members are variations of one parametric idea
  (corner/tee/cross = "N sleeves at a junction" → one `junction(dirs)` function), to avoid
  triplicated code. Reserve the strong model for hard geometry; trivial parts (caps, washers, plain
  blocks) are fine on a cheaper/faster model via the Agent `model` override.
- Give every agent the SAME system block (exact mm: section, clearances, thread spec) so parts
  actually interconnect; reference an existing canonical part ("copy the body of `parts/nut.py`").

## Viewer for a kit: categories + on-part labels

`parts_viewer.py` reads each part's one-line **docstring via `ast.get_docstring`** (no import) for a
description, groups the panel by a name→category map, and floats a CSS2D **name + short description
label above each part** (toggleable, like the dim labels). Keep the on-part description to the first
clause / ~44 chars single-line (full sentences wrap into tall overlapping columns); put the full
text in the side panel.

**Threaded meshes are HEAVY.** An M30 `threaded_rod` at `n_theta=96, steps_per_pitch=12` is ~99k
faces; a dozen threaded parts base64-embedded blew the self-contained viewer to 31 MB. Drop the
thread resolution (64/6 → 13 MB, still fine for both viewer and a utility-bolt print). Quadric
decimation (`simplify_quadric_decimation`) may be unavailable on system Python 3.9 (a `type | None`
type-union bug), so lowering generation resolution beats decimating after.

## Pick the engine first: BREP (build123d/CadQuery) vs mesh (trimesh)

These projects historically built everything in **trimesh** because "OpenSCAD/FreeCAD aren't
installed." That reasoning is stale, and it's worth correcting before you start a new part:

- **For NEW parametric parts, prefer a real BREP kernel: `build123d` (or `CadQuery`).** Both are
  `pip install` (they ship their own OpenCascade via the `cadquery-ocp` wheel, so NO system CAD
  install and no macOS Gatekeeper problem, which was the original blocker). They give you true
  solids with native fillets, chamfers, lofts, sweeps, and threads, and they **import AND export
  STEP** plus STL/3MF. `bd_warehouse` adds parametric gears/threads/fasteners to build123d, so you
  don't hand-roll involute math. This is far more productive than reconstructing geometry from
  triangle arrays. Caveat: needs **Python ≥3.10** (the system `python3` here is 3.9, use a newer
  interpreter or a venv). build123d and CadQuery share the OCP wrapper, so objects interchange.
- **Use trimesh + manifold3d when the input IS a mesh** (downloaded STL/3MF, mesh surgery on a part
  with no parametric source), or as the robust boolean engine on triangle soups. It's battle-tested
  and exports a named GLB straight to the viewer. It does NOT read STEP (see foreign-cad-import).
- **They compose:** model the part in build123d, export STL, then use the trimesh viewer/`shoot.py`
  loop and the FDM checks below. The view-screenshot-iterate loop is identical regardless of engine.

The rest of this skill's report/verify/print guidance is engine-agnostic. The notes below describe
the trimesh path (what these projects used); the same checks apply to build123d output.

## mechlib: check the shared library BEFORE writing any geometry helper

`mechlib` (`~/Desktop/myprojects/mechlib`, https://github.com/m-esm/mechlib) is the shared
package of project-agnostic semi-primitives for the trimesh+manifold3d path: primitives,
sweeps, print-safe cutters (teardrop bores, nut slots, dovetails), gear/worm/planetary
generators, ratchets, threads, fasteners, closures, patterns, text, mesh utils, plate
packing, STEP export. It was mined from finnish-doors, finnish-windows, and parviz after
the same helpers got reimplemented three-plus times.

- **Install per consumer project:** `pip3 install -e ~/Desktop/myprojects/mechlib`
  (editable, tracks the checkout).
- **Before writing a gear generator, cutter, thread, or mesh helper, check mechlib first:**
  README API tables + interactive gallery with live parameter playground at
  https://m-esm.github.io/mechlib/. The helper you're about to write probably exists.
- **Promote, don't fork:** when a helper or mechanism generator in a consumer project
  proves project-agnostic and print-validated, RECOMMEND to the user promoting it into
  mechlib (explicit parameters only; a promotion adds a README row, a minimal gallery
  demo, and a test). Raise this proactively when a part reaches "validated" state — the
  user wants the nudge. Finished designed parts and assemblies never move there;
  mechlib is semi-primitives only.

## Params are an editing surface (derive maps, never hand-maintain them)

Once `params.py` is the single design surface, two practices follow (finnish-doors,
2026-08, both now standing user rules):

- **NO hand-maintained artifacts.** Never introduce a manually curated map/registry/
  parallel table that duplicates information living elsewhere — the canonical failure
  was a hand-authored param→component prefix map for the viewer that drifted the day it
  was written. Derive from the source of truth, or generate + gate staleness (a check
  that fails the build when the generated artifact no longer matches). This is R8 in
  the checklist; flag existing hand-maintained artifacts and propose the derived
  replacement.
- **Generate the param→geometry map by REFLECTION, not annotation.** Instrument the
  build so each part records which params it actually read (a recording namespace
  around the params import + per-builder scoping), and emit the map as a build output
  (`web/param_node_map.json`). A `PARAM_TRACE=1` build + an audit command
  (`python -m param_reflect --audit`) proves coverage: unread params and unmapped nodes
  go to zero instead of to a TODO list. The same instrumentation can log CSG cut
  provenance (which param produced which boolean), which turns "what do I edit to move
  this pocket" into a lookup.

**The viewer can then become a param EDITOR, not just a display.** Pattern that works
(a small param server beside the static file server): the panel shows params grouped by
the component you have selected (via the generated map), edits apply as
**compare-and-swap span-rewrites of `params.py`** (byte spans captured at parse time;
comments and formatting preserved; a concurrent hand-edit fails the CAS instead of
clobbering), a batch Apply triggers the quick rebuild (`SKIP_FITS=1`) with staged
progress streamed back, and **undo/redo history lives server-side** so it survives
browser reloads, devices, and commits. Derived/rebound params render read-only with
their effective values — the editor never lets you type over a value the build computes.

## Toolchain (all via `pip3 install --user`, or a venv for build123d)

- **trimesh 4.12 + manifold3d**, boolean CSG (`engine="manifold"`): holes, pockets, bores,
  keyed profiles, housings. manifold3d is still the recommended robust, guaranteed-manifold CSG
  backend for Python meshes. **All boolean inputs must be watertight volumes** or manifold throws
  "Not all meshes are volumes!", check `mesh.is_volume` per part when a union/difference fails.
  **Pin the pair** (`trimesh`+`manifold3d`) together, a major manifold3d bump has broken
  `trimesh.boolean` before; upgrade them in lockstep, not piecemeal.
- **numpy**, vertex/tooth math. **shapely**, 2D profiles, then `extrude_polygon` / `revolve`
  to 3D (gear teeth, threads, revolved chambers). **scipy / networkx / rtree**, as needed for
  sections and multi-loop work.
- **trimesh exports GLB directly** with named, vertex-colored nodes, no 3MFLoader needed in
  the browser. Gear/worm tooth profiles are computed from first principles (involute wheel,
  trapezoidal thread), then fed to trimesh; CSG only does holes and housings.
- **playwright + Chromium**, headless viewer screenshots (swiftshader GL, no real GPU needed).

In the trimesh path you generate tooth/thread profiles from first principles and reach for CSG
(manifold) only for holes, pockets, and housing booleans. In build123d, prefer `bd_warehouse` for
gears/threads instead of hand-rolling them. Either way: a helical *bore* through a straight shaft
must be cut **straight**, not helical, or the shaft won't pass.

## Bundled scripts (copy into the project, they're generic)

Everything in `scripts/` is project-agnostic. Copy what you need:

- **`serve.py`**, tiny static server (browsers won't fetch `.glb`/`.stl` over `file://`).
  `python3 serve.py` with no args derives a **stable per-project port** (8100-8799 from the
  project dir name), so two projects can never collide on 8765 again (that collision burned
  three projects debugging the wrong model). Binds 0.0.0.0 and prints the **LAN URL so the
  user can open the viewer on a phone on the same wifi**. Answers `/__project__` so shoot.py
  can verify identity. Sets `Cache-Control: no-store` and the `.glb` mime type.
- **`assembly_check.py`**, the pre-export gate: pairwise boolean interference (exit 1 on
  un-whitelisted overlap, Makefile-gateable), sub-clearance warnings, and a `--sweep`
  motion check across a moving part's full travel. See `references/assembly-verification.md`.
- **`wallcheck.py`**, fast trustworthy wall-thickness + breach checking (shell
  self-thickness via voxel EDT; parts-inside-shell breach via union -> signed distance,
  coarse proxy for search, exact for the verdict). The naive alternatives (contains-probes
  at seams, KDTree signs) false-alarm; this encodes the recipe that finally worked.
- **`checks_template.py`**, design-invariant tests ("unit tests for geometry"): copy to
  `src/checks.py`, add one check per user-approved requirement the same turn it's approved,
  run at the end of every build. Kills the silently-deleted-feature class.
- **`viewer_glb.html`**, the main Three.js (0.169, jsdelivr) GLB viewer for **multi-part
  assemblies**, and the single viewer that carries every feature the projects evolved. `?m=<file>.glb`.
  Responsive: side panel on desktop/big displays (font scales with viewport), collapsible
  ☰ bottom sheet with fat touch targets on phones; canvas is `touch-action:none` so
  one-finger orbit / two-finger pan-zoom don't fight page gestures.
  Per-part toggles **grouped BY OBJECT into collapsible categories** (name-regex `CATS` table,
  each group with a toggle-all checkbox, indeterminate when mixed -- how you flip the pieces of
  one split object on and off), deterministic per-name colors, **ghost-outline**
  default for housing-like parts (translucent + edge lines) with a **solid** toggle,
  **click-to-select** (raycast on click; >6 px pointer travel = orbit, not click: the part glows,
  its row highlights + scrolls into view, name + posed world L/W/H print under the title; same
  part / empty space / Esc clears), **per-part
  L/W/H axis dimension lines + labels** (toggleable;
  X=length red, Y=width green, Z=height blue), an **explode** slider (parts fly out radially,
  composed with the joint pose in ONE place), **per-joint pose sliders** from the
  `<model>.pose.json` sidecar (rotary AND linear joints -- see the articulated-assemblies
  section), the **fit map ON by default** (patches re-posed per kinematic group), a
  **section cut on any axis** (X/Y/Z select + slider), a **spin** toggle, a print-bed grid, Z-up,
  ACES tone mapping, and auto-reload on rebuild. Exposes `window._scene/_cam/_controls/THREE` and
  sets `window.__ready` for headless control by `shoot.py`. The dimension labels use `CSS2DRenderer`
  so they always face the camera and follow their part through explode.
- **`viewer_stl.html`**, simpler single-STL viewer for mesh-surgery work. `?file=<f>.stl&view=iso`,
  print-bed grid, axes, bbox HUD.
- **`parts_viewer.py`**, bundles every STL in a dir into ONE self-contained `parts_viewer.html`
  (base64-embedded, **no server, double-click to open**). Multi-part grid / "in place" layout,
  per-part show/hide, CAD-style **L/W/H dimension lines** on each bbox, spin/fit, and an OPTIONAL
  data-driven **assembly view** (drop an `assembly.json` of 4x4 poses next to the STLs). This is the
  viewer for the **part-by-part workflow** (many independent STLs you iterate on and want to see
  together + dimensioned); `viewer_glb.html` is for a single live-reloading assembly GLB instead.
- **`shoot.py`**, headless multi-angle renders via Playwright. `python3 shoot.py model.glb tag
  [port]` writes `.claude/renders/tag_{iso,front,side,top,bottom,sec_mid,sec_iso}.png` (always
  into `.claude/renders/`, created on demand, so renders never clutter the project root).
  **Bottom is in the standard set**: bed-facing bugs (floating discs, raised features that
  should be engraved) hide from every other angle. Defaults to the same per-project port as
  serve.py and **aborts if `/__project__` says the server belongs to another project**.
  Auto-detects STL vs GLB by extension. Pairs with `serve.py`.
- **`stlpaths.py`**, the subsystem router from **Project layout**. `stlp("worm.stl")` →
  `stl/drive/worm.stl` by filename prefix; `webpath()` / `exportpath()` / `rootpath()` for the
  other dirs. Drop it in `src/`, edit the `SUBSYSTEMS` prefix table per project. Keeps every export
  out of the repo root and the assembly loader + Bambu export reading the same paths the build wrote.
- **`Makefile`**, the front door (`make build / export / viewer / shot / install / all`),
  self-documenting via trailing `## ` comments (`make help` lists them). Add one target per extra
  `build_<sub>.py`.
- **`requirements.txt`**, the pinned toolchain (`trimesh>=4.12` + `manifold3d>=2.5` as a pair,
  numpy/scipy/shapely/networkx/rtree/matplotlib/playwright). `make install` runs it + `playwright
  install chromium`.

**Image cap:** renders are @2x and phone/Retina-scale captures exceed the 2000px many-image
limit, which poisons the whole session. Always downscale before reading a PNG inline:
`sips -Z 1400 .claude/renders/in.png --out .claude/renders/in_s.png` (or `-Z 1100` for the
densest scenes).

**Don't reopen the user's browser tab.** The viewer auto-reloads `assembly.glb` on rebuild
(polls Last-Modified), the user watches changes land live. `shoot.py` is a separate headless
context for *your* verification. **Never ask the user to hard-refresh.** Every new/edited
static page includes live reload (`live_reload.js` or framework HMR); serve with
`Cache-Control: no-store`.

**Viewer growth path.** The bundled static `viewer_glb.html` is the right default and stays
the portable reference. Two upgrades earn their cost as a project matures:
- **A MARKS panel for geometry handoff** (finnish-doors): click a surface → world-coord
  probe pin; 2-click and 4-click boxes (AABB of hits, flat axes auto-expanded to a target
  part's span); copy exports rounded JSON. The user marks "cut here / this boss" on the
  model and pastes coordinates into chat — this kills most of the spatial-language
  ambiguity that the orientation protocol below otherwise pays for.
- **Graduating to an app-framework viewer** (finnish-doors moved to a Next.js app once it
  had two products, a param editor, fits/joints panels, and doc pages): worth it only at
  that scale. The contracts stay identical either way — the build regenerates
  `assembly.pose.json` / `fit_report.json` every run (never hardcode ratios in the viewer),
  a coverage gate in `checks.py` fails when a GLB node matches no viewer-tree entry, and
  `shoot.py` drives whichever viewer serves the page.

**Viewer gotchas baked into the templates** (carried from real breakage):
- Three.js `3MFLoader` ignores Bambu's multi-file production extension → bake to GLB instead.
- trimesh writes colors as *vertex* colors, so `material.color` is unreliable, classify parts
  by **mesh name**, not color.
- GLB normals often arrive inverted/unlit → `computeVertexNormals()` + `DoubleSide`.
- Without ACES tone mapping, raw light intensities clip to white.
- `top`/`bottom` camera views are degenerate (camera-up parallel to view dir) → on-screen axis
  orientation is arbitrary; trust `iso`/`front`/`side` for axes.
- `matplotlib` 3D (`Poly3DCollection`) has no occlusion → muddy and misleading. Use the Three.js
  viewer for anything you actually need to read.
- **Z-up the right way: `cam.up=(0,0,1)`, a `GridHelper` with `rotation.x=PI/2`, sit parts on the
  ground via `mesh.position.z = -bbox.min.z`, spin about Z.** Do NOT rotate the geometry to Three's
  default Y-up to fake it, it fights OrbitControls and renders cylinders / bores lying on their side.
- **The headless browser caches `localhost:<port>/<file>` per port.** A stale `serve.py` from a
  prior project on the same port silently serves the WRONG model (you debug geometry that's fine).
  The bundled serve.py/shoot.py now auto-derive a per-project port and handshake via
  `/__project__`; if you override the port manually, keep it unique per project and
  `pkill -f serve.py` whenever a render looks like someone else's part.
- **CSS2D dimension labels:** `CSS2DRenderer` + a second `.render(scene,cam)` in the loop gives crisp
  bbox L/W/H tags that always face the camera; attach them as children of the mesh so they follow it.

## Articulated assemblies: pose sidecar + viewer joint sliders

When the assembly has joints (pan/tilt head, hinged lid, rotating stage), don't rebuild the GLB
to inspect another pose. The pattern that landed on desk-pi (reference implementation:
its `web/viewer_glb.html` + the sidecar writer in `src/build.py`):

- **The build writes a `<model>.pose.json` sidecar next to the GLB** on every run: the BAKED
  preview pose angles (the GLB's vertices bake whatever pose the build rendered), each joint's
  axis position, the travel limits, and a name → kinematic-group map (which nodes ride which
  joint: `head` rides tilt rides pan, `pan` rides pan only, everything else fixed).
- **The viewer adds one slider per joint and applies DELTA rotations** from the baked angles
  (slider pose × inverse of baked pose), per kinematic group, composed with explode in ONE
  place so the two effects don't fight over `object.position`. The user drags pan/tilt live;
  no rebuild.
- **Fit-map patches are stored in NEUTRAL-pose coords**, so unlike the baked meshes they need
  the FULL slider pose, not the delta. A patch belongs to the MORE moving of its two parts
  (child group > parent group > fixed); same-group pairs then ride exactly.
- **Linear joints ride the same sidecar** (desk-pi's telescoping antenna masts): list the
  moving nodes (`ant_nodes`) + travel + the baked extension; the viewer composes a
  head-local translation INSIDE the parent joint pose
  (`parentPose . T(0,0,slider-baked) . inv(bakedParentPose)`), one slider per node, so a
  tilted head deploys along its own up. Bake the preview extension via env
  (`ANT=<mm> make build`) like the rotary poses.
- **Shoot the extremes, not just neutral.** Drive the bake pose via env (`PAN=90 TILT=-30
  make build && make shot`) and read those renders too; the neutral render hides every swept
  collision. For the numeric version see the motion sweep + swept-envelope notes in
  `references/assembly-verification.md`.
- **Place new mechanisms by PROBING keep-outs, not by eyeballing:** transform the moving
  group's vertices into the target frame across the joint range and take the cloud's
  bounds (desk-pi: the tilt drivetrain sweeps x +-24 z<174 inside the head; the screen
  tray owns x 56..68 z<196) -- then lay the new gear train inside the free bands and let
  the interference gate arbitrate. Guessing placements cost three collision rounds;
  probing found the only workable band in one.

## Verify before "done"

- **Run the assembly gate**: `assembly_check.py` (pairwise interference, clearance,
  motion sweep) + `fitmap.py` (pairwise CLEARANCE MEASUREMENT + contact patches — booleans
  prove non-overlap, not non-press; a gearbox passed every boolean while seized at 0.00°
  backlash; run the canonical report at the NEUTRAL pose, and since a full-assembly pass
  costs **minutes** — often ~99% of total build wall time on a mature scene — keep it a
  flag like `FITS=1` / `make fits` / `SKIP_FITS=1` for watch, not part of the fast loop;
  content-hash cache the fitmap result keyed by posed geometry so no-change rebuilds skip
  it entirely — see `references/assembly-verification.md` "Fitmap is often the whole
  build") + `checks.py` design invariants + the insertion-path and torque-path
  audits from `references/assembly-verification.md`. "Watertight and looks right from six
  angles" has shipped unassemblable parts to plastic more than once; the gate is what
  catches lugs bigger than notches, sealed pockets, and freewheeling bores.
- **On a mature assembly, run the gates in their pipeline ORDER** (`make all`): gate
  self-tests → build → invariants → joint contracts → wallcheck → static interference →
  pose sweeps (overlap AND minimum running gap — boolean sweeps are blind to thin rubs;
  floors come from a named clearance budget in params) → export → **headless slice
  check** (the slicer catches empty-layer walls nothing upstream sees). Order matters:
  gates consume files earlier stages generate. See assembly-verification.md "Running
  clearance", "Typed joint contracts", and "Release pipeline".
- **Retention self-check** (before claiming a cover/lid clamps): named preload path;
  solid under pad (slab ∩ frame); driver wells empty after late unions; no opposite-mouth
  single-slide fantasy. See hard-won-patterns §1 and assembly-verification "Retention".
- **Contact self-check**: no `NESTED_OK` / uncapped pair bless; seat envelopes + body dig
  cap; freckle pairs have mm³ ceilings; packaging pocket derived from mate datums;
  residual/thin-shell still green. See hard-won-patterns §2, §15–18.
- **Kinematics self-check**: OEM datum, multi-axis reach, pose.json regenerated with GLB,
  DESIGNED contacts volume-capped or replaced by clear gates.
- **Strength self-check** for hand-breakable features: mesh A/S + multi-load util with SF,
  not only param floors.
- **When a build "feels slow", measure before guessing.** Stage timers + archived
  `metrics/runs/` (and `python3 src/metrics.py compare prev latest`) are how you learn that
  housing CSG is fine and fitmap is the wall. Content-hash part cache + fitmap cache is the
  fix; see `references/csg-robustness.md` "Iteration speed".
- `mesh.is_watertight` and `mesh.is_winding_consistent` after every edit.
- Print a feature-size report: smallest wall / tooth tip / thread crest. **< ~0.6 mm won't print**
  (the slicer's Arachne generator smooths it away).
- For "does this hole actually pierce / does this cavity connect" use `mesh.contains()` probes
  along the **real feature axis**, a naive horizontal/planar sample misses slanted or staggered
  holes and falsely reports "no hole."
- **Then render from multiple angles and read every PNG (the iso/front/side/top + section cuts
  from `shoot.py`).** This is the step that catches what the numbers can't: watertight + correct
  measurements still hides orientation, collision, floating-part, and feature-distortion bugs.
  Treat "I looked at all the angles and they match intent" as the bar for done, not "it's watertight."

## Slicer-style CUT + connectors (do it in the model)

PrusaSlicer / Bambu Studio / Orca can **Cut** a solid on a plane and **Add connectors**
(plug, dowel, snap, dovetail; circle/hex/square/triangle) so halves reassemble. Agents
must know that feature and, when asked (or when bed/orientation forces a split),
**reproduce it in parametric CAD** — not only point the user at the slicer.

Full taxonomy, decision tables, multi-axis sequencing, sizes/tolerances, and the
boolean algorithm: **`references/slicer-style-cut.md`**. Hard rule: **R1.9** in the
design-rules checklist.

**Minimum agent loop when cutting:**

1. Choose one or more **planes** (thick bulk, large mating face, each half bed-stable;
   sequential multi-axis cuts if one plane is not enough). Never through precision seats
   or frozen printed interfaces without sign-off.
2. Choose **connector type + shape** from the decision table (hex or ≥2 pins for
   anti-rotation; **dowel** when both halves print cut-face-down; dovetail for thin
   plates; snap only for light service).
3. **Place connectors by cut-face scoring** (disk radius on the plane, not only
   `contains(center)`). Thin floor/ceiling strips edge-on are false positives. Spread
   for moment (extrema + mid-span); add **pad bosses** when radial wall would be
   <~1.6 mm after the hole. Gate the pad ring; probe motor/board dig. Details:
   `references/slicer-style-cut.md` → "Connector placement".
4. Name params: `conn_size`, `conn_depth`, `conn_tol` (~0.15–0.25/side FDM),
   `pad_wall`, centers; leave ≥1.2–2 mm meat; min feature 0.6 mm.
5. Boolean both halves (plug male∪/female−, or dual holes + free dowel STLs); export
   separate parts; show closed + section renders; update plates/gates/ASSEMBLY.md.

Prefer editable `params.py` + builders (or a shared helper; check **mechlib** first)
over a one-shot mesh hack.

## Splitting big prints for speed (and less support)

When a part dominates print time or needs a big bed, split it and join with printed
features (desk-pi took its four biggest from a 434 cm3 worst-piece / 256 bed to a
225 cm3 worst-piece with everything on 180x180, and no plate over 8 h). For
**slicer-style plane cut + peg/dovetail connectors**, use the section above and
`references/slicer-style-cut.md`. For **structural multi-part design** (flanges, screws,
panel/frame), use the patterns below:

- **Halve wide shells at a plane through their sparse cross-section** (a head shell's
  only solid at x=0 was the top wall + one rear strip). Joint kit per seam: an internal
  flange with 2x M3 (clearance + counterbore one side, Ø2.5 thread-form pilot the
  other), Ø4 dowels for shear/alignment, or a 0.15-fit tongue/groove where a flange
  won't fit. **Stagger the seams of nested parts** (bezel at x=+22 vs back at x=0) so
  the assembled stack interlocks like brickwork, and count the OTHER parts that bridge
  a seam (perimeter screws, rails, pinned trim) before adding more joint hardware.
- **Kill ceiling support with a panel/frame split, not more supports:** a tub-shaped
  part printed open-face-down turns its whole back wall into a supported ceiling.
  Split the flat wall off as a PANEL (prints lying flat, features up, ~zero support,
  minutes not hours) and leave a wall FRAME that prints with no ceiling at all; join
  with M3s from the back into frame rim tabs (clip tabs into rounded-corner mass with
  `inter(tab, solid)` -- at the wall plane the "side wall" may be all corner curve).
- **Slabs with a precision feature keep it monolithic:** a deck carrying a bearing
  seat splits into strips AROUND the seat (half-laps + vertical screws), never through
  it.
- **Solid styling bodies get pockets, not seams** (a display pod's solid tiers:
  interior lightening pockets with >=2 mm walls).
- **Gates must survive the rename:** alias each piece to its parent object for
  whitelist lookups and allow same-parent contact (the designed seam) -- the
  `SPLIT_ALIAS` hook in the bundled `assembly_check.py` / `fitmap.py`. Then re-run the
  full gate stack and re-plate the slicer export (the part list changed; a stale
  exporter re-plating deleted names is the staleness class the bambu skill warns about).
- **Measure, don't guess, the win:** headless-slice the re-plated project and quote
  per-plate times (foreign-cad-import skill, BambuStudio CLI; pass `--export-3mf` a
  RELATIVE filename -- it prepends `--outputdir` even to absolute paths).

## Separate by stability (frozen shell vs equipment base)

Splitting for print speed is not the only partition. Before modeling any enclosure or
chassis that carries components, partition it by CHANGE FREQUENCY first:

- **The FROZEN shell**: structural + cosmetic geometry (walls, kinematic seats, seams,
  bearing bores). Big, slow, support-sensitive, printed once. Keep it CLEAN: no screw
  pockets, posts, or bosses for any component whose dimensions are unverified
  (dev boards, sensor modules, buck converters, anything marked verify-on-arrival).
- **The IN-FLUX equipment base**: a small flat drop-in plate that owns EVERY mount for
  the unverified/evolving components. It bolts to the shell at a few generic points
  (e.g. 4x M3 into floor pilots). When a real part arrives with different holes, you
  edit the base layout and reprint ONLY the base — a flat, support-free, minutes-long
  print — never the shell.

**Decision rule** for what stays fused in the shell: only features that are
(a) kinematic/structural-critical (a pan-axis pedestal, bearing seats), or
(b) physically coupled to the shell skin — sensor barrels through a wall, vents,
light pipes, anything air- or hole-coupled to an exterior face. Everything else rides
the base. Bonus: a base plate can deliberately SPAN a shell print-seam and tie the
pieces together, replacing seam hardware.

**Build the base against the shell, not into it**: model the base solid, then subtract
the union of the shell pieces (plus a despeckle pass) so it auto-acquires clearance
pockets for every floor feature it spans and can't silently clash.

**Anti-pattern**: retrofitting a tray AROUND an existing hand-packed component layout.
The tray fights every pocket and rib the old layout owned, and half the mounts stay
fused in the shell anyway — you keep the reprint cost you were trying to kill. When
adopting this split on an existing design, RE-LAY-OUT the components onto the base as
a contiguous bay; don't notch a plate around them. (desk-pi learned this the slow way:
the retrofit tray collided with the belly-opening rebate until the electronics were
re-laid-out onto `chassis_base` and the base was relieved by boolean subtraction.)

## Seed the hard rules into every project (external agents don't load skills)

Grok/Codex/Kimi CLI workers and non-skill sessions never read this skill, so the distilled
hard rules must live IN each repo. When starting (or first touching) a 3D project:

1. Copy **`references/design-rules-checklist.md`** to the repo as **`docs/DESIGN-RULES.md`**.
2. Add a mandatory pointer at the TOP of the repo's `AGENTS.md` (create one if missing) and
   in `CLAUDE.md`: "read `docs/DESIGN-RULES.md` before any geometry work; cite rule numbers".
3. Briefs dispatched to external CLIs must name the file explicitly and put the repo's
   geometry gates in the acceptance criteria.

The checklist is the numbered floor (R1 printability, R2 clearances/seat-kiss, R3
insertion paths, R4 screws/nuts, R5 torque paths, R6 bought parts, R7 verification,
R8 derived artifacts); the references below carry the full rationale. If a project's
copy drifts from the skill copy, the skill copy wins, sync it.

## Deeper references (read on demand)

- **`references/design-rules-checklist.md`**, the numbered cross-project hard-rule floor
  (R1-R8, incl. R1.9 slicer-style cut+connectors, R2.4 seat-kiss/body dig, R2.7
  running-gap, R2.8 derived envelopes, R3.6 pad≠clamp, R3.7 joint contracts, R5.6
  strength util, R6.3–6.4 OEM/bought mesh, R7.6 freeze/pose, R7.8 slice gate, R8
  no-hand-maintained-artifacts) seeded into each repo as `docs/DESIGN-RULES.md`.
- **`references/slicer-style-cut.md`**, Prusa/Bambu/Orca **Cut + connectors** playbook
  for agents: plug/dowel/snap/dovetail, circle/hex/square, multi-axis sequential cuts,
  sizing/tolerance, boolean algorithm, when to cut vs structural split. Do the cut in
  parametric CAD when asked — do not only send the user to the slicer.
- **`references/hard-won-patterns.md`**, 2026-07/08 Klonk + Fermax intercom patterns:
  clamp physics, seat-kiss vs body dig (no nest whitelist), OEM datums, display springs,
  multi-axis reach, freeze archives, mesh strength util, late-union keepouts, residual
  deck vs thin-shell, derived packaging envelopes, CSG relief orphans, display-board
  digs, live reload + skill paths. Read when retention, servo mates, or false-green
  gates bite.
- **`references/fdm-design-rules.md`**, print orientation, self-supporting geometry (45° roofs,
  run-outs), min feature size, support strategy, PLA vs PETG, hoop stress for pressure parts,
  warp/adhesion, the "slicer settings beat geometry hollowing" lesson.
- **`references/mechanisms-and-fits.md`**, gears/worms (module vs teeth vs lead angle), keyed
  bores + manual override, press-fits / clearances / snap vs friction joints (incl. snap-tongue
  service doors), cover/panel retention, servo/horn/paddle mates, return springs + pins,
  screws/nut traps, bearings, one-way clutches, motor coupling, service cartridges +
  stall-homing hard stops, closed loops of discrete links (tracks/chains/belts).
- **`references/assembly-verification.md`**, the pre-export gate: interference + motion-sweep
  audit, FIT MAP, **running-clearance sweeps + thrust locators**, **typed joint contracts
  (mechanized insertion/fastener audits, mutation-tested)**, the ordered release pipeline +
  slice gate, insertion/torque paths, seat-kiss classifier, retention audits, datum/reach
  gates, freeze interfaces, strength gates, bought hardware in mesh, multi-agent pre-print
  review, spatial-language protocol, render legibility.
- **`references/csg-robustness.md`**, trimesh/manifold3d playbook (single-call booleans,
  late-union keepouts, fresh keepout instances, crush-ribs-after-cuts, underface-first),
  build123d on-ramp, iteration-speed / content-hash cache. finnish-doors: ~300 s → ~0.8 s.
- **`references/components-verified.md`**, the never-model-bought-parts-from-memory rule and
  session-verified dimensions for the recurring hardware (28BYJ-48, TT motor, driver/charge/
  boost boards, 18650 holders, 608, keypads, Pi + touchscreen), plus the
  electronics-in-enclosures checklist.

## Related skills

- **bambu-3mf-export**, turn finished STLs into a real Bambu Studio `.3mf` project with print
  settings baked in (no "not from Bambu Lab" warning), FINE/FAST profile splits, support strategy.
- **foreign-cad-import**, bring in STEP/IGES/F3D you don't have parametric source for (gmsh
  tessellation → GLB), 3MF read/write gotchas, mesh surgery, BambuStudio-CLI slicing for measurement.
