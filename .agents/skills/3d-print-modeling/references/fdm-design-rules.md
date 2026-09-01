# FDM design rules (hard-won)

Design-for-manufacturing rules for FDM printing, learned by breaking real prints. Target
printer in these projects is a **Bambu Lab A1 / A1 Mini** (256×256×256 mm, 0.4 mm nozzle,
Textured PEI plate, max bed 100 °C), generic PLA or PETG. Most of this generalizes to any
0.4 mm-nozzle FDM machine.

## Minimum feature size ≈ 0.6 mm

Anything thinner than ~0.4–0.6 mm gets **smoothed away or dropped by the slicer's Arachne
perimeter generator / minimum-feature filter** and won't appear in the print. A real example:
0.5 mm grip ridges on a coupler vanished entirely in slicing. Calibrated breakdown for a 0.4 mm
nozzle:
- **Structural walls: ≥ 0.8 mm** (two 0.4 mm perimeters) for anything load-bearing or that must
  not flex/creep. Walls that are a multiple of the nozzle (0.8 / 1.2 / 1.6) slice cleanest.
- **Visible/functional detail you want reliably present: ≥ 0.6 mm.** This is the safe default for a
  tooth tip, thread crest, grip ridge, or embossed mark. Make `build.py` assert it every run.
- **Absolute single-wall floor ~0.4 mm** (Arachne can print a deliberate ~0.32–0.4 mm single wall
  *only* with well-calibrated flow). Don't design at this edge unless you've dialed flow in, any
  variance magnifies; treat it as a special case, not a target.
Have `build.py` print a feature-size report against these thresholds.

## Print orientation + self-supporting geometry

The whole game is designing so the part prints **with no (or minimal) support**, because support
on internal features is unremovable and ruins surfaces. Techniques that worked:

- **45° gable / tapered roofs instead of flat ceilings.** A sealed hollow part (e.g. a pressurized
  chamber) can print as one piece only if its internal ceiling is a 45° gable revolved/extruded to
  a peak, a flat internal ceiling needs un-removable support. Same trick closes a hollow leg cavity:
  taper the cavity roof shut at 45° so it self-supports, no bridge.
- **Open-top cavities print support-free** (the walls rise vertically, nothing bridges). Orient
  boxes/enclosures cavity-side UP.
- **Thread/shaft run-outs.** A worm threaded only in its center, with the thread *growing out of*
  the plain shaft over ~6 mm, prints vertically with no floating-cantilever shelf. Avoid an abrupt
  overhanging step where a feature starts mid-air.
- **Flat-face-down for crisp detail.** A keypad with raised digits prints front-face-down so the
  digits land crisp on the bed and keycaps are self-supporting islands. Lids print flat-top-down
  (the export flips them) so every cavity opens upward.
- **Engrave features flush, don't raise them, on a face that prints down.** The turntable's top plate
  had a *raised* angle-scale ring; flipped face-down for the print it floated the whole 176 mm disc
  ~1 mm off the bed, so the slicer bridged and drooped the entire underside. Engraving the scale
  *flush into* the flat face (recess opens upward when flipped) lands the face flat on the bed and
  drops auto-support to zero. A raised feature on the bed-facing side is a stilts-and-bridge trap.
- **Narrow-base / wide-top dovetail tongues self-support**; wide-base/narrow-top overhangs don't.
- **Never print a gear with its pin/journal attached, split them and join with a square/hex
  fit.** A gear modeled as one piece with a coaxial pin has no good orientation: axis-vertical,
  the gear disc is a large horizontal overhang cantilevered around the pin (the slicer packs
  support under the whole face and around the journal, longer print, wasted material, rough
  support scars exactly where you need smooth tooth flanks and a smooth bearing journal);
  pin-down is worse. Design them as SEPARATE parts from the start: the gear prints flat on
  the bed (best tooth quality, zero support), the pin/journal prints on its own, usually
  axis-vertical for roundness. Join through an anti-rotation fitting: a **square or hex
  pocket/bore in the gear hub** and a matching square/hex boss section on the pin, so torque
  is carried by the flats, not by glue or friction on a round bore (which freewheels, see the
  torque-path rule in mechanisms-and-fits). Start the fit at ~0.15-0.25 mm clearance per flat
  and dial on a test print; add a lead-in chamfer on the boss, and retain axially with a
  shoulder + glue dab, an E-clip groove, or a screw from the far side. The one-piece
  exception: a journal on ONE side only, printed gear-face-down with the pin rising
  vertically, is self-supporting and needs no split; the split is mandatory when the pin
  extends both sides, when the pin-side gear face needs bed-quality finish, or when a long
  thin pin would wobble during the print.
- **Diagnose floating regions with a bed-facing heightmap**: raycast straight down onto the part
  in its print orientation; any region sitting above the lowest contact plane is a mid-air bridge
  that will fail. This caught a motor-enclosure roof floating 3 mm above the bed, a ~23 cm² mid-air
  bridge that failed in *every* orientation until the enclosure was extended flush with the bed.

## Support strategy

- **Auto *tree* support is the safe default** when a part genuinely has overhangs. It builds only
  under real overhangs and leaves self-supporting faces (open-top cavities, ramped catches,
  flat-top-down lids) bare. Disabling support globally to "save time" silently fails the parts that
  needed it (enclosure roofs, wire holes, recess ceilings). Don't turn support off without checking
  each part's overhangs.
- **Tall thin parts (a worm: ~69 mm tall on a Ø8 base) are the hardest case.** Printed vertically
  for the best thread, they fail two ways: the thin upper section prints alone so layers don't cool
  (stringy/melty top), and the small base peels while the molten top drags on the nozzle. What
  worked: **vertical + tree support** (gives the thin section structure + a heat path) + a **~12 mm
  brim** (base adhesion) + full fan + slightly lower temp (215 °C) + min-layer-time ~12 s. A *long*
  min-layer-time makes it WORSE (the nozzle dwells on the part). A sacrificial cooling tower was
  tried and dropped in favor of tree support. Fallback: horizontal-with-support (rougher thread).
- **A SHORT worm flips the orientation calculus: lay it horizontal.** The turntable's worm (~Ø17 ×
  29 mm) printed axis-vertical packed unremovable support into every thread underside (a 360°
  horizontal overhang at each turn) and fouled the mesh. Laying it horizontal (rotate the axis to
  lie along the bed) halved the overhangs, kept the support external and peelable, and printed ~2×
  faster (support segments 370→120). So: **tall worms go vertical+tree for thread quality; short
  stubby worms lay flat so support stays off the threads.** Either way, test-print to confirm the
  thread finish before trusting it in a drive.

## PLA vs PETG (material choice is a mechanical decision)

- **PLA** is fine for fit-checks and parts that don't see sustained load or warmth. It **creeps
  under sustained load** and softens around ~50 °C.
- **PETG** for anything load-bearing, spring-like, warm, or wet: it resists creep, reaches ~70 °C,
  bonds watertight, and has better layer adhesion. Use it for gears/worms under continuous load,
  living-hinge/flexure parts, snap latches, and water-contact parts.
- **Transparent PETG** reads translucent at thin walls, nice for showing internal mechanism, but
  then you want **0 % infill** (infill is opaque/ugly through clear walls); see the hollowing note.

## Pressure parts: walls are set by hoop stress, not printing

For a part under internal pressure (e.g. a water chamber), wall thickness is a **stress**
calculation, not a min-print one. Hoop stress = P·R/t. Worked example: a Ø232 ring at 5 bar
static (valve-close / water-hammer) needs ~2.4 mm wall (≈ SF 2 in PETG); 1.2 mm gave ~48 MPa
≈ PETG yield and would creep/crack. Note the load case matters: the same chamber *flowing* is
only ~0.07 bar (trivial), the wall is sized for the static/transient spike. Thinner walls are
only safe if you also drop the bore diameter (lowers chamber pressure); pressure and wall are
coupled. Have `build.py` print the hoop-stress + safety-factor every run.

## Warp / bed adhesion (big thin parts)

A big thin part with a heavy feature near the bed **edge** warps and peels, the edge is the
coolest, weakest-grip zone. Fixes that worked on a Ø232 PETG ring that spaghettified at the front:
- **Keep parts off the bed edge.** Pull the diameter in so the part sits on the well-heated center
  (e.g. 13 mm margin, not 4 mm). For very large parts, orient diagonally (heavy feature into a corner).
- **Trim warp mass**, a chunky overhang gusset slimmed 24→14 mm warps less.
- **Brim** (8 mm outer), **slow first layer** (~20 mm/s), reduced cooling for the first ~3 layers,
  **elephant-foot compensation** (~0.15 mm), and a **clean plate wiped with IPA** (skin oils kill
  PETG grip). Dry filament, no room draft.

## The hollowing lesson: slicer settings usually beat geometry surgery

For a constant-cross-section, overhang-free part (e.g. a tripod leg), **carving an internal cavity
in CAD does NOT beat just slicing the solid at low infill**, the slicer already shells a solid to
outer-perimeters-only at 0 % infill. Measured in BambuStudio CLI: the original solid leg at
**0 % infill + 0.28 mm layer + 2 walls** printed **−44 % time / −38 % filament** vs the 15 %/0.20
default, while the hollowed `_light` mesh was a **net negative** (the carved cavity only adds inner
perimeter paths → slightly slower + heavier). Walls thicker than ~2.0 mm print *heavier* than
slicing the solid at low infill.

Geometry-hollow earns its place only in a narrow regime: **transparent PETG at 0 % infill** (where
you can't use infill for stiffness and a flat solid cap would sag bridging a wide ceiling), there,
thin defined walls + a self-supporting tapered roof give a clean, bridge-free, supportless print
*and* perimeter-wall stiffness so a load-bearing part can run 0 % infill safely. Otherwise: **leave
parts solid and slice at 0 % infill + 2–3 perimeters.** Reach for slicer settings before mesh surgery.

## Lightening that does pay off

- **Spoke a wheel** (e.g. 5 holes through a gear web): real volume drop with the torque path intact
  (rim + hub + spokes). A worm-wheel went 70 → 46 cm³ (−34 %) this way.
- **Thread only the engaged zone** of a worm (center ~6 teeth), leave the rest plain shaft.
- These are *model* volume reductions that also shrink real print time, unlike shelling a solid
  constant section.

## Chunky parts are FLOW-LIMITED, not setting-limited

For a big solid-ish part (a bracket, a clamp arm), print time is often just the time to *extrude
the volume* at the filament's max flow. PETG melts at ~10-12 mm³/s on a 0.4 mm nozzle, so the floor
is `volume / (flow * 3600)` hours **regardless** of layer height / walls / infill. A 216 cm³ PETG
bracket → ~6 h floor at 10 mm³/s; dropping 0.24→0.28 mm and 20→10 % infill barely moved it.

When the user says "too slow", check the volume floor first, then pull the levers that actually
matter for a flow-limited part, biggest first:
1. **Bigger nozzle** (0.4 → 0.6 mm): wider lines + higher melt rate (~20 mm³/s) ≈ *halves* time.
   Perfect for no-fine-detail parts; keep threaded fasteners on the 0.4.
2. **Turn support OFF when the part is self-supporting** in its orientation. Auto-tree support can
   silently fill horizontal bores with hard-to-remove material AND add hours. Orient so cavities /
   pockets open upward, then disable support (clearance bores tolerate a little bridge sag).
3. **Use less plastic — shrink the geometry, not the settings.** The part is usually over-built:
   shrink the outer section toward what actually has to fit (e.g. a 46 mm body around a 38 mm nut →
   42 mm dropped 216→148 cm³, −31 %). Enlarging an existing through-bore also works but adds bolt slop.
4. Raise `filament_max_volumetric_speed` to 12-14 if the filament tolerates it (direct multiplier).

Layer height + infill are real levers on *tall thin* parts (many layers, little flow per layer);
they're weak on *chunky* parts where flow is the wall.

**The 0.8 mm nozzle is not a free `nozzle_diameter` flip.** On the dual-axis-turntable, switching a
profile to a 0.8 nozzle by editing `nozzle_diameter` alone made perimeter-heavy parts *slower*: the
flow stayed capped at the 0.4 profile's `filament_max_volumetric_speed` (~12 mm³/s), so wider lines
just took longer per mm. To actually get the ~35 % time win you have to (1) raise
`filament_max_volumetric_speed` to ~21, (2) set `print_compatible_printers` to the 0.8-nozzle
machine or the slicer refuses with "not compatible", and (3) widen any fine feature that has to
survive the fat bead (degree ticks went 0.8→1.8 mm). And the hidden cost: **a 0.8 nozzle's ±0.25 mm
tolerance swamps a designed 0.1–0.2 mm interference, so every press-fit becomes a glue-fit.** Print
bearing seats and snap pins on the 0.4, or plan to epoxy/CA them. Keep the fast 0.8 for the bulk
structural parts (shell, cradle), not for anything that has to grip.
