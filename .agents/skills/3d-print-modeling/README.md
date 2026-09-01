# 3d-print-modeling — a Claude Code skill for parametric 3D-print parts

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Agent%20Skill-d97757)](https://code.claude.com/docs/en/skills)
[![Plugin](https://img.shields.io/badge/install-%2Fplugin%20marketplace-5436DA)](#install)
![GitHub stars](https://img.shields.io/github/stars/m-esm/3d-print-modeling?style=social)

Design FDM 3D-print parts as **parametric Python** (`trimesh` + `manifold3d` + `shapely`, or `build123d`), then **view and screenshot them headlessly** so Claude checks the geometry by eye on every change. No GUI CAD (no OpenSCAD, FreeCAD, or Fusion). The geometry engine is pip-installable, the viewer runs in a browser, and "done" means Claude actually looked at the render from six angles, not "it's watertight, ship it."

![Claude Code 3D-print parts viewer: 31 colored FDM parts on a print-bed grid, grouped into categories (beams, connectors, bolts, nuts, function parts) with a searchable side panel showing per-part dimensions and descriptions](assets/viewer.png)

> The bundled self-contained parts viewer: every STL in a project, gridded on the print bed, grouped by category, with a searchable panel and per-part dimensions. One double-click HTML file, no server.

## Why

LLMs are good at writing the Python that generates a mesh and bad at noticing the bolt hole missed the shaft, the bracket is mirrored, or two parts collide. Numeric checks (`is_watertight`) pass while the part is visibly wrong. This skill closes that loop: it makes Claude **render the part and read the image** before claiming the change works, the same discipline a human modeler uses staring at the viewport.

## What it does

- **Parametric-first.** One `build.py` with a `PARAMETERS` block is the source of truth. Edit values, rerun, never hand-edit mesh output.
- **View → screenshot → iterate.** `serve.py` + `shoot.py` render iso / front / side / top + two section cuts to PNG via headless Chromium. Claude looks at the part from multiple angles, and the section cuts confirm internal features (bores piercing, cavities connecting, wall thickness).
- **Parts-kit fan-out.** Want a whole family of parts at once? The skill fans out one subagent per part against a shared `lib.py` helper API, then builds them in a single pass. Measured: 19 parts, every one watertight on first build.
- **Two viewers.** `viewer_glb.html` for a single live-reloading assembly GLB (per-part toggles, explode slider, section cut, L/W/H dimension lines, Z-up). `parts_viewer.py` bundles a directory of STLs into the one-file HTML grid shown above.
- **FDM design rules + mechanisms references** loaded on demand: print orientation, self-supporting geometry, minimum feature size, PLA vs PETG, gears and worms, press-fits and clearances, bearings, snap joints, **slicer-style cut + connectors** (cut large parts in CAD with plug/dowel/snap/dovetail joinery like Prusa/Bambu).
- **Engine-agnostic.** Use `trimesh` + `manifold3d` for mesh surgery on downloaded STLs, or a real BREP kernel (`build123d` / `CadQuery`) for new parts with native fillets, chamfers, and threads. Both are `pip install`, no system CAD.

Pairs with **[bambu-3mf-export](https://github.com/m-esm/bambu-3mf-export)** to turn finished STLs into a sliceable Bambu Studio `.3mf` project with print settings baked in.

## Install

### Option 1: Manual (works everywhere, all projects)

```bash
git clone https://github.com/m-esm/3d-print-modeling ~/.claude/skills/3d-print-modeling
```

Restart Claude Code. The skill auto-loads when you describe a modeling task, or run `/3d-print-modeling`.

### Option 2: Plugin marketplace (supports updates)

```
/plugin marketplace add m-esm/3d-print-modeling
/plugin install 3d-print-modeling@3d-print-modeling
```

Update later with `/plugin marketplace update 3d-print-modeling`.

## Usage

Describe the part. Claude loads the skill and runs the loop:

> Make a parametric M8 bolt and a matching nut, then a wall bracket they bolt through.

> This part is too flexible. Thicken the spine to 4mm and add a 45-degree gusset, then show me the section cut.

> Give me a family of 42mm beam connectors: corner, tee, cross, end cap.

Or invoke it explicitly with `/3d-print-modeling`.

## Requirements

- Python 3.9+ for the trimesh path (Python 3.10+ for the `build123d` BREP path).
- Install the pinned toolchain:
  ```bash
  pip3 install --user -r scripts/requirements.txt
  python3 -m playwright install chromium
  ```

## What's in here

```
SKILL.md                 the skill itself (workflow + FDM rules Claude reads)
references/
  design-rules-checklist.md  R1–R8 hard-rule floor (seed as docs/DESIGN-RULES.md)
  slicer-style-cut.md        plane cut + plug/dowel/snap/dovetail connectors (do in CAD)
  hard-won-patterns.md       clamp, seat-kiss vs body dig, residual deck, derived
                             packaging envelopes, relief orphans (2026 Klonk/intercom)
  fdm-design-rules.md        print orientation, supports, min feature size, PLA vs PETG
  mechanisms-and-fits.md     gears/worms, retention, servo mates, springs, bearings
  assembly-verification.md   fitmap, seat-kiss classifier, freezes, retention, pose
  csg-robustness.md          boolean playbook + late-union keepouts + cache
scripts/                 generic, copy into a project as needed
  serve.py               localhost static server for the viewer
  shoot.py               headless multi-angle Playwright renders
  viewer_glb.html        Three.js assembly viewer (toggles, explode, section, dims)
  viewer_stl.html        single-STL viewer for mesh surgery
  parts_viewer.py        bundle a dir of STLs into one self-contained HTML grid
  stlpaths.py            subsystem output router (keeps the repo root clean)
  Makefile               make build / export / viewer / shot / install / all
  requirements.txt       pinned toolchain
```

## Security

Skills can run code. This one ships Python that Claude executes: mesh generation, a localhost static server, and headless Chromium screenshots. No network calls beyond `pip` / `playwright install`, no credential access. Read `SKILL.md` and `scripts/` before installing, same as any skill.

## License

MIT. See [LICENSE](LICENSE).

---

<sub>Keywords: Claude Code skill · Claude agent skill · Anthropic · 3D printing · FDM · parametric CAD · trimesh · manifold3d · build123d · CadQuery · STL · 3MF · GLB · mesh · watertight CSG · print bed · gears · brackets · headless rendering.</sub>
