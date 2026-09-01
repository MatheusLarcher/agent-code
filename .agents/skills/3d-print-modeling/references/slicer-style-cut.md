# Slicer-style CUT + connectors (do it in CAD, not only in the slicer)

Modern FDM slicers (PrusaSlicer 2.6+, Bambu Studio, OrcaSlicer) ship a **Cut** tool that
splits a solid on a plane and can auto-generate **mating connectors** on the cut face so
parts reassemble after print. Cura mostly splits already-separate mesh islands; it does
**not** own this full plane-cut + connector system.

**Agent rule:** when the user asks to cut / split / section a model for printing, or the
part clearly will not fit the bed / needs a better print orientation, **perform the cut
yourself in the parametric model**. Do not only tell them to open Bambu Studio. Prefer
editable params + separate export meshes over a one-shot mesh hack.

This doc is the playbook. The short pointer in `SKILL.md` and **R1.9** in the design-rules
checklist both point here.

---

## When to cut

Do it when any of these are true:

| Trigger | Why |
| --- | --- |
| Part exceeds bed (e.g. A1 256×256) | Must fit plate |
| Dominant print time / volume | Smaller worst piece, faster plates |
| Bad orientation if monolithic | Cut so each half sits flat, less support |
| User says "cut / split / section / multi-part for print" | Explicit ask |
| Thin tall feature that would fail as one print | Split journals, pins, tall necks |

Do **not** auto-cut every model. Do not cut through frozen already-printed interfaces
without user sign-off (R7.6). Prefer a design-time multi-part architecture when the split
is permanent product structure (clamshell, panel/frame) rather than a late bed-fit hack.

Related skill sections: **Splitting big prints for speed** and **Separate by stability**
in `SKILL.md` (M3 flanges, panel/frame, frozen shell vs equipment base). This doc is the
**slicer-style plane cut + peg/dovetail connector** vocabulary and algorithm.

---

## Mental model (what the slicer does)

1. Place a **cut plane** (any angle; some UIs force Z until you rotate the model).
2. Optionally **Add connectors** on the cut face (click to place).
3. **Perform cut** → two solids + connector geometry applied.
4. Optionally cut again on another axis (sequential multi-cut).
5. Re-orient each piece for print (often cut face down).

Connectors need a **shared mating plane**. The tool does not place connectors between
arbitrary already-split parts without faking booleans. In CAD you always: partition on
the plane, then boolean the joinery on both halves with the same centers.

---

## Connector types (taxonomy)

Match Prusa / Bambu / Orca names so agents and users share language.

### Plug
- Male prism **fused to half A**
- Matching cavity **subtracted from half B**
- One-shot press or glue assembly
- Flip which side gets male by flipping the plane normal / `male_on` flag

**Use when:** simple alignment + glue; light to medium load; fewest parts.

### Dowel
- **Holes on both** halves
- A **separate printable pin** (or metal rod later)
- Pins can print **lying flat** (stronger layers) or as free objects

**Use when:** you want replaceable pins, pin orientation control, or multiple large
plates joined by stock rods. Export `dowel_pin_N.stl` as its own part.

### Snap
- Plug-like with a **bulge / lip** that clicks into an undercut socket
- Reusable open/close; often brittle if undersized; PETG can creep under sustained hold

**Use when:** light service access, occasional disconnect. Not primary structural join.

### Dovetail (cut style / plane joinery)
- Trapezoidal pin + tail along the cut plane (slide-together)
- Strong against pull-apart in one axis; works on **thin** sections where peg depth is tiny

**Use when:** flat plates, thin shells, decorative or shear registration with little thickness.

---

## Shapes

| Shape | Role |
| --- | --- |
| **Circle** | Default pin; can rotate unless ≥2 pins or glued |
| **Hexagon** | Anti-rotation single pin; good for torque registration |
| **Square / prism** | Anti-rotation; align flats with part axes |
| **Triangle** | Anti-rotation; awkward if rotation UI is limited |

**Style notes:** off-center single pin also stops rotation. Prefer **hex or ≥2 non-collinear
circles** when the joint must not spin. Square plugs need explicit rotation so flats match
the part axes (slicers often place diamonds if the model isn't pre-rotated).

---

## Parameters (always named in `params.py`)

| Param | Meaning | Typical FDM start |
| --- | --- | --- |
| `cut_plane` / origin + normal | Where and which way | Through thick bulk |
| `conn_type` | plug / dowel / snap / dovetail | plug default |
| `conn_shape` | circle / hex / square / triangle | hex if single pin |
| `conn_size` | Diameter or broad side (mm) | 4–8 small; 8–12 medium; 12–15 large |
| `conn_depth` | Male protrusion / pocket depth (mm) | ≈ size, or 0.6–1.0× size |
| `conn_tol` | Clearance on male shrink or cavity grow (mm) | **0.15–0.25** per side PETG/PLA |
| `conn_bulge` | Snap lip only | small; test-print |
| `conn_centers` | XY (or UV on plane) of each connector | ≥2 for large faces |

**Tolerance is empirical** (R7.4). Say "needs a coupon" for critical snap fits. Never design
a running/plug fit at zero clearance.

**Meat around the pocket:** leave ≥ **1.2–2.0 mm** solid wall around and behind each
connector. Depth must not break through thin sections (probe remaining wall after cut).

**Min feature (R1.1):** male walls, snap lips, and dovetail tips ≥ 0.6 mm; structural ≥ 0.8.

---

## Connector placement (score the cut face, not just the center)

Hard-won (Klonk/windows `r3_motor_housing` Y-clamshell, 2026-08-09): a layout that only
checked `mesh.contains(center)` put 5 mm hex dowels into thin floor/ceiling **strips**
seen edge-on on the cut face. Radial solid was ~1.5 mm; the hole blew through. A second
failure class: pins clustered at the easy slabs while a **65 mm mid-span** on the only
continuous wall column had zero joinery.

### Score meat on the cut face (disk), not along the pin axis alone

| Check | What it proves | How |
| --- | --- | --- |
| Center solid | Site is not air | `contains([origin])` on the cut plane |
| **Radial solid radius** | Room for hole AF/2 + wall | Grow a ring of samples in the cut plane until a sample exits solid; that radius is the pad |
| **Y (normal) depth both sides** | Pin engagement | Sample ±depth along the plane normal into each half |
| **Wall left** | After hole, ≥1.2–2.0 mm meat | `r_solid − hole_r` (use AF/2 + tol for hole_r) |

A thin **floor or ceiling** contributes full depth along the normal (the plate is wide in
that axis) but only **plate thickness** as radial solid on the cut face. Edge-on strips
are the classic false positive for center-only checks.

### Local pad bosses when the natural disk is too small

If `wall_left < pad_wall` (default **1.6–2.0 mm**), **do not move the pin into fantasy
solid**. Grow a **pad boss** into the monoblock *before* the split:

- Shape: cylinder (or hex) along the cut normal, radius = `size/2 + pad_wall`, length
  ≥ `2·depth` so both halves bury the hole.
- Fuse with manifold union; then cut holes; then split (or split then cut — same centers).
- Pads may enter free cavities; keep them out of **precision seats** and **motor/board
  envelopes** (probe bought-part dig after the pad union).
- Gate: after pads, sample a ring at `hole_r + 0.6·pad_wall` on the cut face — every
  sample must be inside. Fail the build if not. Center-only checks are not enough.

### Place for moment, not for "how many easy hits"

On a large mating face:

1. **Extrema first** — corners / ends of the solid mating region (long lever arm).
2. **Mid-span on the only continuous column** — if the face is a hollow frame (walls +
   sparse slabs), pin the wall that actually bridges the long gap; do not leave >~40–50 mm
   unpinned on a structural shell.
3. **Prefer natural thick pads** (sill bars, decks, flanges) over inventing floor sites.
4. **Non-collinear** — ≥3 pins not on one line for anti-rotation; two pins 4 mm apart on
   the same rib are one pin with extra holes.
5. **Count** — 4–6 good pins beat 7 broken ones. Each hole is a stress riser.

### Dowel + cut-face-down print (common shell case)

When both halves print **cut face on the bed**:

- Prefer **dowel** (holes both sides + free pins printed flat). Plug males hang under the
  bed on the cut face.
- Pads are still valid: they thicken the face, not hang as males.
- Pin tray: one multi-body STL, axis in-plane for strong layers.

### Placement anti-patterns

- `contains(center)` only — ignores radial breakout on thin strips.
- Pins only on floor/ceiling slabs of a hollow shell (edge-on on the cut face).
- Large unpinned gap on the continuous wall between two slabs.
- Two pins in one cluster, zero pins at the opposite end of the face.
- Pad bosses that dig the motor, bearing seat, or board envelope.
- Zero-clearance dowels; FDM needs `tol` 0.15–0.25/side and pin undersize.

---

## Choosing cut planes (geometry judgment)

Prefer planes that:

1. Pass through **thick bulk**, not gear teeth, seal faces, thin walls, or bearing seats.
2. Create a **large, flat mating face** (room for ≥2 connectors).
3. Let each half sit **stable on the bed** after reorient (cut face down is common).
4. Improve orientation (detail on bed, open cavities up, load along layers — R1.3 / R1.5).
5. Avoid critical load paths unless the joinery **restores** shear/torque (name the path).
6. For nested shells, **stagger seams** between inner/outer parts (brickwork).

### Multi-axis / multi-cut

There is no single "cut on three axes" dialog in slicers; they **sequence** cuts. Agents
should do the same:

1. Cut on plane 1 → parts A, B + connectors on face 1.
2. If A or B still too big / wrong orientation, cut that piece on plane 2 (often orthogonal)
   → connectors on each new face.
3. Name exports clearly: `housing_base_x0`, `housing_base_x1_z0`, etc.

Plan the **print orientation of each final piece** before committing planes.

### Where NOT to cut

- Through a precision feature that must stay monolithic (bearing seat, worm mesh zone).
- Through already-printed mating geometry the user must keep (R7.6 freeze).
- Where remaining wall after pockets < min structural thickness.
- So that connectors would hang in free air (centers must sit fully inside both solid halves).

---

## Decision table

| Situation | Prefer |
| --- | --- |
| Alignment + glue, simple | **Plug**, circle or square |
| Torque / no spin, one pin | **Hex** (or triangle) plug |
| Large face, anti-rotation | ≥2 plugs, non-collinear |
| Strong pin, pin print flat | **Dowel** + separate pin STLs |
| Thin plate, little peg depth | **Dovetail** along plane |
| Occasional open, light load | **Snap** (larger size; warn on PETG creep) |
| Structural / load-bearing | Multiple large plugs or dovetails **+ glue**; not snap alone |
| Still too big after one cut | Second cut, other axis; new connectors |
| Precision seat on one piece | Cut **around** the seat, not through it |

---

## Algorithm to implement in CAD

```
inputs: mesh/solid S, plane P (point + normal), connector list C[]
0. PLACE connectors using cut-face scoring (section above). For each candidate:
     r_solid = max radius of solid disk on P around center
     wall_left = r_solid − hole_r
     if wall_left < pad_wall: mark site needs pad boss
     reject sites with insufficient depth along ±normal into both halves
1. For each connector that needs meat: union a PAD BOSS (cyl along normal,
   r = size/2 + pad_wall, length ≥ 2·depth) into S → S_pad
2. Gate: ring samples at hole_r + 0.6·pad_wall on P are all inside S_pad
3. Partition S_pad by P → solids S_pos, S_neg  (keep both unless user drops a side)
4. For each connector c in C:
     shape = extrude(profile(c.shape, c.size), ±normal, c.depth)
     if type == plug or snap:
         male = shape (+ bulge if snap)  # optionally offset -tol for male
         female = shape expanded by c.tol
         S_pos = S_pos ∪ male          # or S_neg; honor male_on
         S_neg = S_neg − female
     if type == dowel:
         hole = shape expanded by c.tol
         S_pos = S_pos − hole
         S_neg = S_neg − hole
         emit free pin solid at nominal size − loose (export separately)
     if type == dovetail:
         build trapezoid pin on one side, tail pocket on the other along P
5. Verify:
     - each half is_volume / watertight
     - hole center void + pad ring solid just inside each half (not only on P)
     - no dig into motor/board precision envelopes
     - remaining wall ≥ floors
     - parts fit bed AABB after proposed print orientation
6. Export separate STLs + optional free dowels; update assembly GLB with both halves
   posed closed (and optionally exploded) for the viewer.
```

Use manifold CSG (`engine="manifold"`). Fresh boolean operands per op
(`references/csg-robustness.md`). Prefer a small helper in project `lib.py` /
`geom_util.py` (or promote to **mechlib** once print-validated): e.g.
`plane_cut(mesh, origin, normal)`, `add_cut_connectors(a, b, plane, specs)`.

Check **mechlib first** for dovetails / cutters before inventing a one-off.

---

## Defaults (starting values, not gospel)

For 0.4 mm nozzle PETG/PLA, mid-size enclosure-ish parts:

| | Small part (<80 mm face) | Medium | Large face |
| --- | ---: | ---: | ---: |
| size | 5 mm | 8 mm | 10–12 mm |
| depth | 4–5 mm | 6–8 mm | 8–10 mm |
| tol (per side) | 0.15 | 0.20 | 0.20–0.25 |
| count | 1–2 | 2–3 | 3–4 |

Lead-in: 0.3–0.5 mm chamfer on male tip and female mouth helps assembly.

Snap: start larger than plug; treat as **test-print only** until proven.

---

## Verification after a cut

1. Rebuild both halves; watertight.
2. **Render closed assembly + cut face section** (`shoot.py`); read PNGs.
3. Check bed AABB of each half against printer volume.
4. Wallcheck around connector pockets.
5. If the project has fitmap / joint contracts: designed contact at the seam is OK with a
   named reason + volume floor; do not blanket-whitelist the whole pair forever without
   a cap (R2.4). Same-parent split aliases if you rename pieces (`SPLIT_ALIAS` in
   assembly-verification).
6. Update Bambu plate list (names changed; stale exporter is a known failure class).
7. State clearly: friction/snap **needs a physical coupon** for tol (R7.4).

---

## Naming and params discipline

```python
# params.py — example surface
cut_housing_base = True
cut_hb_plane_z = 0.0          # or origin + normal vectors
cut_hb_conn_type = "dowel"    # plug | dowel | snap | dovetail
cut_hb_conn_shape = "hex"     # circle | hex | square | triangle
cut_hb_conn_size = 4.5
cut_hb_conn_depth = 5.0
cut_hb_conn_tol = 0.20
cut_hb_pad_wall = 1.8         # radial meat outside hole; pad boss grows to this
# Centers on the cut plane — extrema + mid-span, not a thin-strip cluster:
cut_hb_conn_uv = (
    (14.0, -147.0),   # floor corner (gets pad)
    (38.0, -147.0),
    (42.5, -90.0),    # continuous wall mid-span (gets pad)
    (42.5, -62.0),
    (47.0, -42.0),    # natural thick sill
    (6.0, 30.0),      # deck
    (40.0, 36.0),
)
```

Export names: `{part}_a`, `{part}_b`, or axis-coded `{part}_xneg` / `{part}_xpos`.
Free dowels: `{part}_dowel` or shared `dowel_{size}x{depth}`.

Document assembly order in `docs/ASSEMBLY.md` when order matters (R3.5).

---

## Anti-patterns

- "Just open the slicer" when the user asked the agent to cut.
- Zero-clearance plugs that only work in the mesh, not in FDM.
- One round pin on a torque joint (spins).
- Connectors through thin skins with paper walls left.
- **Center-only placement** on thin floor/ceiling strips edge-on to the cut face.
- **Unpinned mid-span** on the only continuous wall of a hollow shell.
- Cutting a bearing seat or worm mesh in half "to fit the bed."
- Snap as the only hold on a structural or continuously loaded joint.
- Hand-maintained duplicate cut maps (R8) — params + geometry builders only.
- Forgetting to re-plate export and re-gate after renames.
- Shipping cut STLs without a pad-ring / breakout gate (silent paper walls).

---

## Quick agent checklist

- [ ] Confirm why cut (bed / support / user ask / time)
- [ ] Choose plane(s); multi-axis if needed; name each
- [ ] Choose type + shape from decision table (dowel if cut-face-down print)
- [ ] Size / depth / tol from thickness + table; named params
- [ ] **Score cut-face disks**; add pad bosses where wall_left is short
- [ ] Place for moment: extrema + mid-span; no thin-strip cluster
- [ ] Pad-ring gate before/after boolean; no motor/board dig
- [ ] Boolean both halves; emit free dowels if used
- [ ] Verify walls, watertight, bed fit, renders
- [ ] Update exports, assembly view, ASSEMBLY.md if needed
- [ ] Flag test-print for snap/friction fits
