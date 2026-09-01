# 3D DESIGN RULES (mandatory, all agents: Claude / Grok / Codex / Kimi)

Hard rules for every parametric-CAD project in this workspace (Python + trimesh/manifold3d,
FDM printing on a Bambu A1, 0.4 mm nozzle, PLA/PETG). Every one of these was paid for with
a failed print or a physically un-assemblable part that passed all renders. Read this
BEFORE touching geometry. Cite rules by number in reviews and fix ledgers (e.g. "violates
R3.1"). R1 printability, R2 clearances, R3 assembly, R4 fasteners, R5 load paths, R6
bought parts, R7 verification, R8 source of truth. Repo-specific gates, axis glossary,
and commands live in `AGENTS.md` and `docs/AGENT-LOOP.md`; this file is the
cross-project floor.

## R1. Printability

- **R1.1 Minimum feature 0.6 mm; structural walls >= 0.8 mm.** Anything thinner is
  silently smoothed away by the slicer (Arachne), it will not exist in the print. Walls in
  multiples of 0.4 slice cleanest. Load-bearing: >= 0.8.
- **R1.2 Overhangs <= 45 deg self-support; flat internal ceilings do not print.** Close a
  cavity with a 45 deg gable/taper, or open it upward. Support inside internal features is
  unremovable, design it out, don't "let support handle it".
- **R1.3 Declare the print orientation at design time, per part.** Raised detail on a
  bed-facing side floats the whole part on stilts; engrave flush instead. Open-top
  cavities up; lids flat-top-down; crisp detail face-down.
- **R1.4 Holes print undersize.** Add ~0.2 mm diametral on vertical bores, more on
  horizontal ones. Never design a running bore at nominal diameter.
- **R1.5 Layers are weak in peel/tension.** Orient parts so drive loads, snap-arm roots,
  and thin necks are loaded along layer lines, not across them.
- **R1.6 Never print a gear with a coaxial pin/journal attached.** Split into gear (flat
  on bed) + pin (vertical), joined by hex/square flats. One-sided journal printed
  gear-face-down is the only exception.
- **R1.7 Material is a mechanical decision.** PLA creeps under sustained load and softens
  ~50 C. Springs, snaps, and continuously loaded gears want PETG.
- **R1.8 Print-in-place gaps >= 0.4 mm** or the parts fuse into one.
- **R1.9 Slicer-style cut + connectors live in the model when asked.** When the user
  asks to cut/split/section a part for bed fit, orientation, or reassembly — or the
  part clearly will not fit the plate — perform a **plane cut in parametric CAD** and
  add mating connectors yourself. Do not only tell them to use Bambu/Prusa Cut.
  Choose plane(s) through thick bulk (sequential multi-axis cuts if needed); pick
  connector **type** (plug / dowel / snap / dovetail) and **shape** (circle / hex /
  square / triangle) from load and anti-rotation needs; name size, depth, and
  tolerance params (FDM start ~0.15–0.25 mm/side); leave meat around pockets; export
  separate halves (+ free dowel pins if used). **Place connectors by cut-face disk
  scoring**, not only `contains(center)` — thin floor/ceiling strips edge-on are
  false positives; grow **pad bosses** when radial wall after the hole would be
  <~1.6 mm; place for moment (extrema + mid-span), gate the pad ring. Full playbook:
  `references/slicer-style-cut.md` (in the 3d-print-modeling skill). Structural
  multi-part design (M3 flanges, panel/frame) is complementary, not a substitute for
  this when the user wants slicer-style peg/dovetail joinery.

## R2. Clearances and collisions

- **R2.1 Nothing runs at zero.** Running fits >= 0.2-0.3 mm per side; slide-together
  joints ~0.4-0.5. FDM bias: plugs print oversize, cavities undersize.
- **R2.2 Boolean "no overlap" proves neither "no press" nor "it turns".** Measure signed
  clearance (fitmap) and, for gears, backlash rotate-until-contact in both directions.
  0.00 deg of play is a bind even when booleans pass.
- **R2.3 Sweep everything that moves across FULL travel to the hard stops** (stall
  angles, not the software limit), against the fixed parts, the parent group, AND the
  other clamshell half / lid. A neutral-pose check misses most collisions.
- **R2.4 Whitelists stay honest: seat-kiss, not nest.** Only named, designed contacts
  (seats, presses, meshes) get allowed, pair-specific, with a reason AND a volume floor.
  A blanket `partA × partB` or `NESTED_OK` allow that swallows 50–600 mm³ of real dig-in
  is a bug factory (paddle×servo, cover×carrier "nests in bay"). Face-to-face kiss is not
  the same as solid-into-solid. Prefer seat envelopes: dig inside pad/boss cylinders is
  freckle-capped; dig *outside* those envelopes is body dig and fails hard (cap ~0.5 mm³).
  Prefer positive clear gates. A new unexpected contact is a failing gate to investigate,
  never a whitelist entry to add.
- **R2.5 Every clearance is a named parameter** with a one-line why. No magic 0.25s
  scattered in geometry code.
- **R2.6 Reach is multi-axis.** A 1-D Z (or length-only) reach gate can pass while the
  pad/foot track has moved off in X/Y. Gate track ⊆ pad extents, body clearance, and
  mesh kiss at the press pose across the stroke.
- **R2.7 Gate MINIMUM RUNNING GAP across the pose sweep, not just non-overlap.** Boolean
  sweeps pass at 0.02 mm of air; the print rubs. Every moving part keeps a floor gap to
  housings (~0.30) and to fragile fixed parts like sensors (~0.25) at EVERY pose, with the
  floors traced to a named clearance-budget block in params (never a magic number in the
  gate). Designed running fits (journals, thrust seats) get named CLEAR_WHITELIST entries.
  Corollary: every rotating part needs an explicit AXIAL locator (thrust seat/boss) — a
  helical or worm mesh thrusts axially, and "the pocket roughly holds it" is not a design.
- **R2.8 Clearance envelopes derive from the printed mate.** A cover pocket for a
  screwed-on cradle is sized from that cradle's outer AABB + ear span + park stop + named
  clear, not a hardcoded bare-servo ceil. Stack budget under residual underface: roof top
  + running clear ≤ residual ceiling; thin the mate's floor/roof before punching the face
  into a free-span membrane. When residual must be opened wide, tile free spans so the
  shorter side of each thin cluster ≤ the thin-shell max; protect rails/bosses so cuts do
  not create orphan bodies.

## R3. Assembly (can it physically go together?)

- **R3.1 Every part needs a real insertion path**: through which opening, in what order,
  what blocks it. Verify the PATH (swept translate, parts present at that assembly stage),
  not just the final pose. Perfect final-pose clearance with no way in is a broken design.
- **R3.2 A part can be trapped by a feature added later for another part.** Re-check
  insertion paths after ANY housing/pocket/wall edit. Late unions (gussets, decks) must
  re-subtract functional keepouts (driver wells, cable exits) or they reseal cuts.
- **R3.3 Bearings, nuts, and bought parts drop in AFTER printing** through open pockets.
  Nothing captured mid-print (no pause-and-insert designs unless the user asks).
- **R3.4 Bench-assemble cartridges.** Motor + worm + bearings build as a unit on the bench
  and drop in together; don't design screws deep inside a shell.
- **R3.5 The moment assembly order matters, write it into `docs/ASSEMBLY.md`.**
- **R3.6 Seat pad ≠ clamp.** A face that only rests on a deck has no peel/preload path.
  Name the preload (ledge undercut, screw into plug, captive nut). Opposite-facing
  pocket mouths cannot share one rigid finger on a single slide direction — use a
  separate plug+screw or a second motion. Do not thrash pad XY when the failure is
  missing preload.
- **R3.7 Every printed-part interface gets a typed JOINT CONTRACT in the gate suite**:
  locator, fastener stack math, axial/radial capture, tool access, seating probes, and a
  swept insertion sim — run against the world-posed assembly, not the print-frame STL.
  The insertion audit is a standing gate, not a one-time eyeball. Mutation-test the gate
  engine itself (break a contract on purpose; the gate must fail).

## R4. Screws and nuts

- **R4.1 Threads live in metal, not plastic.** Captive hex-nut pocket (across-flats
  + ~0.2, depth + ~0.2) or heat-set insert. Self-tapping into printed plastic only for
  one-time, low-load joints, with a pilot ~0.8-0.85x the thread OD, and documented as a
  deliberate exception.
- **R4.2 Clearance hole = nominal + ~0.4** (M3 -> 3.4). Counterbore or recess the head;
  verify driver access to every head (probe the well empty of solid after ALL unions).
  A driver channel longer than ~50 mm is a design smell, redesign the joint.
- **R4.3 Do the stack math per joint.** Screw length must cover the clamped stack plus
  full nut engagement; a screw that bottoms out, or bites nothing (every hole a clearance
  hole), passes every render and clamps nothing.
- **R4.4 The nut must be insertable.** Check the physical gap for the nut and the tool
  that holds it. If no nut fits in the space, redesign or switch to a documented
  self-tap/insert, don't model a nut that can't get there.
- **R4.5 Default to drawer hardware: M3 workhorse, M2 tight/light, M4 for real load.**
  Don't design around specialty fasteners the user must buy when common ones work.

## R5. Torque and load paths

- **R5.1 Name the feature carrying torque at EVERY interface** (D-flat, hex, key,
  spline). A plain round bore is a freewheel. A press fit on a smooth rod creeps loose in
  plastic under sustained torque.
- **R5.2 Never neck a load-bearing shaft down** to pass a bearing bore; it breaks at the
  neck. Re-journal or relocate the bearing instead. Prefer glue-slip + stock screw core
  across the layer plane when pure printed stubs snap and metal mods are banned.
- **R5.3 Springs never sit in the drive path.** Load goes through rigid features; springs
  only reseat/return. A spring that sees drive torque creeps or shears.
- **R5.4 Current-limit the motor and never dwell at stall.** Stall torque through a high
  ratio shears printed features; treat the current limit as the shear fuse and park/home
  at a rest position, not against a stop under power.
- **R5.5 Grease the meshes**; design running clearance as a grease reservoir. Lubrication
  is the biggest life factor for printed gears.
- **R5.6 Strength-gate load-bearing printed features** that break by hand (lugs, spigots,
  thin arms): mesh plane-cut A/S + multi-load util with interlayer peel derate and a
  design SF on normal-use forces. Param W×H alone is not enough.

## R6. Bought parts

- **R6.1 Never model a bought part from memory.** Datasheet, caliper, or user-supplied
  STL/STEP. Echo the critical dims back for confirmation before geometry depends on them.
- **R6.2 Mark estimated dims as ESTIMATE, caliper before printing.** Guessed motors,
  boards, keypads, and battery holders have each cost a reprint.
- **R6.3 Datum mates off the OEM stack.** Horn/servo/blade planes hang off the measured
  spline tip / socket / collar, not a convenient printed face. Pocket outline from the
  measured arm hull when the part is bought.
- **R6.4 Interacting bought hardware is geometry.** Return springs, pins, and horns that
  occupy volume during motion need display meshes (NON_PRINTED OK). Coil-bind =
  coils × wire. Absence from the mesh is not a free pass.

## R7. Verify before saying "done"

- **R7.1 After every geometry change: rebuild, render multiple angles + section cuts +
  the bottom view, and actually read the images.** Numeric gates miss visual bugs; the
  file path is not the render. Ghost/translucent renders hide interference, contact
  questions get numbers.
- **R7.2 Run the repo's gates** (make targets in `AGENTS.md`) before claiming done. Green
  gates plus at least one read screenshot is the floor.
- **R7.3 Encode every user-approved feature as a check/invariant the same turn** it is
  approved. Never weaken or delete a check or whitelist entry without explicit user
  sign-off; a failing check means the geometry regressed.
- **R7.4 Friction, snap, press, and spring behavior cannot be verified virtually.** Say
  "needs a test print to dial in" plainly instead of claiming it works from a render.
- **R7.5 Restate spatial instructions in axis terms before implementing** ("user 'up' =
  +Y on the door, correct?"). If the user corrects the same pose twice, stop iterating
  and ask which faces/edges mate.
- **R7.6 Freeze already-printed interfaces.** Archive as-printed STLs + fail-closed
  sym-diff gates; redesign the unprinted mate around them. Rebuild viewer
  assembly.glb + pose.json the same turn kinematics change; gate pose freshness.
- **R7.7 Probe solid under seats.** Pad-over-window must hit solid frame volume just
  below the deck (thin slab ∩ frame), not only Y-overlap with a pocket that is open
  from the side under a solid roof.
- **R7.8 Headless-slice every exported plate as a gate.** The slicer sees a failure
  class nothing upstream does: sub-line-width cheeks slicing to EMPTY LAYERS, floating
  first layers, support explosions. Its first run on a "verified" project caught 0.4 mm
  groove cheeks that vanished entirely in slicing.

## R8. Source of truth and derived artifacts

- **R8.1 No hand-maintained artifacts, ever, unless the user explicitly asks.** Never
  introduce a manually curated mapping/registry/parallel list/table that duplicates
  information living elsewhere (param→node maps, part indexes, doc tables restating
  code). Derive it from the source of truth at build time, or generate it and add a
  staleness gate that fails the build when it drifts. Found one already existing? Flag
  it and propose the derived replacement.
- **R8.2 One params surface per product** (`params.py`), edited there and only there.
  Derived/rebound values are computed, presented read-only, never re-typed. Prefer
  reflection/instrumentation (trace which params each part actually consumed during a
  build) over hand-annotating what-affects-what.
