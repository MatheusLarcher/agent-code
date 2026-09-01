# Hard-won patterns (2026-07/08: Klonk + Fermax intercom)

Patterns paid for with printed plastic, false-green gates, or multi-hour pad-position
thrash. Cite these in reviews. Pair with `design-rules-checklist.md` (R1–R8 floor).

## 1. Seat pad ≠ clamp (retention physics)

**Symptom:** cover/lid "clamps" still rattle or lift after endless pad XY/Z tweaks; gates
report solid area under the pad and 0.05 mm gap, yet the user says it does not hold.

**Cause:** a pad that only *rests* on a return deck has no +Z (or peel) preload. Top
tenons under a ledge clamp; bottom windows that open the *opposite* way cannot share the
same slide, so pad-only south is structurally free.

**Rules:**

- Name the preload path: undercut ledge, screw into a plug, captive nut + bolt, interference
  snap. If the answer is only "friction on a face," it is not a clamp.
- When pocket mouths face opposite ends, **do not** invent one rigid finger that rides both
  on a single −Y (or +Y) slide. Use a separate south/north plug + screw, or accept a second
  assembly motion.
- Gate **clamp force**, not only pad solid area. A green "solid A under pad" while lock
  blocks are deleted is a lying design.
- Restoring a proven screwed plug beats another pad-geometry rev. Archive why the plug was
  removed; do not delete preload paths to "simplify" without a replacement.

## 2. Honest designed-contact whitelists (and the nest anti-pattern)

**Symptom:** pairwise dig 50+ mm³ "passes" because `paddle × servo` (or similar) is listed
as DESIGNED; real geometry is wrong. Worse class: `NESTED_OK` / "carrier nests in cover bay"
marks dig=630 mm³ + gap=−0.85 mm as `ok: true` / `designed_nest`.

**Cause:** a pair-name whitelist blesses *any* intersection volume for that pair, including
paddle body into gear cap, web through ears, boxed cradle roof through residual underface.

**Rules:**

- **Never bless a whole PART pair blank-wide.** Face-to-face kiss is fine; solid-into-solid
  is not. Those are different classes of contact.
- **Seat-kiss vs body-dig split (the honest model):**
  1. Name seat *envelopes* (cylinders/boxes at boss pads, crush ribs, horn floor).
  2. `dig_total = ivol(A, B)`.
  3. `dig_seat = ivol(A∩B, union(seats))`.
  4. `dig_body = dig_total − dig_seat`.
  5. Allow `dig_seat ≤ seat_cap` (FDM freckle, often ~0.5–2 mm³ per pad).
  6. Fail `dig_body > body_cap` (usually ~0.5 mm³).
- Uncapped freckle pairs still get a **volume ceiling** (`FRECKLE_CAP_MM3`), never a skip.
- Prefer explicit positive gates: "paddle clears servo swept 0.000 over N poses,"
  "west-face clears gear-cap ≥ 1.5 mm," instead of a blanket allow.
- Unmasking a whitelist often reveals a second pre-existing red (sensor board, tray); fix
  both the same turn. Unit-test the classifier with synthetic boxes so the gate can fail.
- Reference implementation: finnish-doors `intercom/fit_policy.py` +
  `tests/test_intercom_fit_policy.py` (2026-08-06).

## 3. Datum off the real stack, not a convenient face

**Symptom:** paddle "doesn't fit the servo"; pocket floor misses the horn; spline tip
stands proud; arm digs the gear cap.

**Cause:** plane hung off gear-cap thickness + half plane-width while the printed arm is
wider; OEM M2 clamps the horn socket onto the **spline tip**, not the cap face.

**Rules:**

- For horn/servo/blade stacks: measure STEP/scan for socket depth, collar OD/proud, arm
  thickness; set pocket floor = tip + (arm_t − socket_depth) (or the real OEM rule).
- Pocket outline = convex hull of the *measured* arm slab (+print clear), not a parametric
  trapezoid that pinches real flank taper.
- Through-bores for collar + head + driver when the OEM head seats on the *bought* part's
  own step, not on printed plastic.
- Caliper note: reference STEP socket depths often differ from OEM (e.g. 1.0 vs 2.4–2.6);
  absorb with through bore + margin, do not freeze the wrong number as truth.

## 4. Model interacting bought parts as geometry

**Symptom:** green gates, springs bind the moving skirt; coils fall off pins; solid length
wrong.

**Cause:** metal springs (or other bought coils/pins) never existed in the mesh, so no
boolean or clearance gate could see them.

**Rules:**

- Display meshes for return springs, pins, horns that occupy volume during motion.
  NON_PRINTED is fine; absence is not.
- Coil-bind length = **counted coils × wire diameter**, not free_L / guess. Gate
  `CAPSPR_COILS` and bind clearance ≥ 1.5 mm at full travel.
- Spring OD vs guide skirt / pocket flute: measure radial clearance at the station radius;
  first model of the coils often proves stations are too far inboard.
- Retention pins: multi-coil engagement + light barb holds better than a 0.7 mm stub; free
  cantilever strength for side load is only the *unsupported tip* once coils brace the pin.
- Print orientation: fixed spring barrels must not stand proud of the cosmetic face if
  FLIP_X lands that face on the bed (gate "well fixed flush").

## 5. Reach and kinematics need multi-axis gates

**Symptom:** 1-D "press reach" green; pad rebuilt south of the arm's max Y; foot never
touches.

**Cause:** reach gated only in Z (or only centerline distance) while the pad moved off the
foot track in Y/X.

**Rules:**

- Gate foot track ⊆ pad extents with margin (X and Y), pad vs servo body clear, and mesh
  kiss at the press pose (min dist + dig volume).
- Stroke sweep: N poses, paddle×cap dig, paddle×statics dig.
- Firmware angles must match geometry-derived park/touch/press; hardcoded 20°/70° vs
  geometric 43°/71° stalls every cycle.

## 6. Frozen printed interfaces

**Symptom:** redesign of already-printed collar/frame to suit a new cover; user reprints
everything; freeze gate missing.

**Rules:**

- Archive as-printed STLs (`cad/.../printed/`) with content hashes; fail-closed freeze
  gates (sym-diff + bounds) on those parts.
- Cover-side params may move; frame-side window/cutter values live in a FROZEN INTERFACE
  block and stay byte-stable with the archive.
- Redesign the *unprinted* mate (cover, blocks, pads) around the frozen part.

## 7. Strength: measure mesh sections, not only params

**Symptom:** 3×3 mm lugs / Ø2.6×0.7 spigots pass W×H floors then snap by hand.

**Rules:**

- Plane-cut section area and section modulus S along the span from the exported mesh.
- Multi-load util: slot side, peel (layer derate), spigot lateral with Kt, spigot axial
  peel. Design SF on normal-use forces (e.g. 2×) so util ≤ 1 means real margin.
- Size floors (min A, min S, min spigot L/D) are backups; util is the primary.
- Parts that break by hand get strength gates the same turn, not after the next reprint.

## 8. Housing for bought modules: snug + crush, not hang

**Symptom:** servo "in" a pocket with 2 mm/side slop; only two M2s hold it; pilots half in
void.

**Rules:**

- Pocket clearance per side is a named param (e.g. 0.30); recenter on measured body
  center, not the first parametric guess.
- Crush ribs (small interference past the published face) after cuts so the relief does
  not gut them.
- Pilot meat gates: annulus volume around the pilot in solid plastic.
- Floor near-seat gap (0.05), not a floating body.

## 9. CSG order: late unions reseal cuts

**Symptom:** M3 access wells modeled and cut; mesh still solid at the pilot; watertight
fails after "fix."

**Cause:** corner gussets (or any late union) re-fill subtracts; or the same trimesh
instance is both a cutter and a keepout and gets consumed.

**Rules:**

- Any solid unioned *after* `difference(body, cuts)` must subtract the same functional
  keepouts (driver wells, cable exits, screw corridors).
- Build **fresh** keepout meshes for the post-union pass; do not reuse cutter instances
  already fed to manifold.
- Prefer structural deck/underface first, openings second; never hollow a free-span face
  membrane then "hope" ribs appear.

## 10. Voids, decks, and solid probes

**Symptom:** seat pad parked "over" a window Y-range that is actually open from the side;
gap reads ~3 mm (air); next rev parks only on solid deck.

**Rules:**

- Pocket open from the outer face under a solid roof is not a through-void. Probe solid
  *under the pad slab* (frame ∩ thin box just below ret_top), not only Y-overlap with
  window bounds.
- Short feet that clear approach/shell may still miss the clamp deck; prefer full pad on
  solid roof when scan budget allows.

## 11. Viewer and pose artifacts stay fresh

**Symptom:** user stares at old arm length in the viewer; animation sinks the cap before
the foot arrives.

**Rules:**

- After kinematics change, rebuild **both** `assembly.glb` and `assembly.pose.json`
  (or fixture equivalents). Gate pose freshness against datums.
- Cap/follower motion should track contact (sampled lift profile), not a linear lie from
  stroke 0.
- Display springs should squash about the fixed pocket floor in sync with press, not
  rigid-translate through the moving face.

## 12. Printed pins under bending / layer peel

**Symptom:** PETG stub snaps at shoulder root; M5 stud needs metal mod the user rejects.

**Rules:**

- Prefer glue-slip printed journal + stock screw core across the layer-failure plane when
  metal mods are banned.
- Glue-slip races (+0.0 to +0.05 over press) when press cracks thin tubes. Redimensioning
  a failed press-fit never closed one of these bugs; only a fit-class change (glue-slip)
  or a steel core did. Treat "print again with tighter/looser interference" as a smell.
- Vertical-print pins: steel across Z-layer plane beats pure PLA at the root.
- Self-tap pilot sizing: shank minus ~0.3 (M3 → Ø2.7, M5 → Ø4.25). Bury the head in an
  internal counterbore so the part's OD (and its mating bores) stay untouched.
- Order of operations when a screw core meets a glued race: CA the stub into the race
  FIRST, drive the screw after cure — the race gives hoop confinement while the thread
  bites; the reverse order splits the stub.
- Thin necks between fat features are where vertical prints break. Fatten torque tubes to
  the neighboring collar diameter with 45° cones (0.9 → 1.78 mm wall was ~3.8× torsion J
  at the failure plane).
- Glue that commits a bought part (motor shaft into a printed bore) is a one-way door:
  bench-verify mesh sense / throw / click direction first, glue last.
- Print-in-place compliant features (accordion/serpentine springs, flexures) must never
  sit in the torque path — they only reseat or return (a few N); drive load goes through
  rigid bosses. Any flexing member carrying drive torque is a redesign flag.

## 13. Snap clips vs rigid retention (interlayer)

**Symptom:** cantilever snap arms break at root (10–22% strain vs ~1–3% PETG interlayer).

**Rules:**

- Living snaps loaded across layers are a fatigue time bomb for daily open/close.
- Prefer rigid tenons + screws/plugs, or snaps only where layer direction carries flex and
  strain is gated.

## 14. File size and module shape (agent context)

Agents re-read megafiles every turn. Soft target 200–500 lines for a builder/gate module;
soft ceiling ~700; smell >1000. When you edit a fat file, peel a coherent part/region into
a sibling module the same change (or immediate follow-up commit). One printed part or
packaging region ≈ one module; one FEATURE ≈ one named helper (reflection param maps
resolve at function granularity — inline cuts are invisible). Keep params coarser (one
params surface per product). Thin facades so `import build` / gates stay stable. Do not
splinter into dozens of tiny stubs or explode params mid-feature.

## 15. Derive clearance envelopes from the printed mate

**Symptom:** cover "servo pocket" sized to a hardcoded bare-servo ceil (28.83 mm); boxed
carrier roof at 30.65 digs ~630 mm³ of residual underface; gates green under nest whitelist.

**Cause:** pocket XY/Z hung off the *bought* body or a one-off number, not the printed
cradle outer + load paths + park stop + ear span.

**Rules:**

- Clearance cuts for a screwed-on / nested print are derived from that part's datums
  (`carrier_box_datums` → outer AABB + `CARRIER_COVER_CLR` + ear-span + stop AABB).
- Hardcoded `servo_ceil = 28.43 + 0.40` (or any magic envelope) is a smell the day a box
  roof, path, or ear is added.
- Bought-part display digs (MG90S ears past the printed outer) still expand the *same*
  derived pocket — one function, not a second ad-hoc slab.
- Gate "pocket clears mate": body dig outside seats must be zero after the cut lands.

## 16. Residual deck vs thin-shell (underface packaging)

**Symptom:** underface is a continuous structural plate (good for free-span face membranes);
component or carrier roof needs headroom; full residual punch creates a 20×35 mm thin face
cluster that fails the thin-shell audit.

**Rules:**

- Structural underface first; bay hollows **below** it; openings recess only to the
  component ceiling so residual thickness remains for face backing (`COVER_UNDERFACE_T`,
  residual floor ~1.8 mm where possible).
- Stack budget: printed roof top + running clear ≤ underface residual ceiling
  (`under_z1 − residual_deck`). If the stack will not fit, thin floor/roof of the
  *mate* before punching residual to free membrane.
- When residual *must* be punched over a wide bay: tile free spans so the **shorter**
  side of every thin cluster ≤ `COVER_THIN_SPAN_MAX` (ribs across X and/or Y; long
  narrow slots pass, square bays fail).
- Local full-residual punches only for small ports (mic, pot) whose short side is already
  under the thin-shell cap.
- Protect cradle rails/bosses when cutting component pockets or late unions sever them
  into orphan bodies.

## 17. CSG relief orphans and "keep largest body"

**Symptom:** after cylindrical well/nest reliefs, `one-body:part` fails or a ~60 mm³ island
south of the wall digs the button cap while the main body looks fine.

**Cause:** full wall + subtract circles leaves chord islands outside the design outer;
`concatenate` of multi-body keeps the dig.

**Rules:**

- Prefer segmented walls that route around keep-out circles over "full slab then carve."
- After reliefs: split, keep the **primary body only** when islands are sub-feature debris
  (document the volume floor). Do not `concatenate` dig islands back into the print mesh.
- Shave everything outside the design outer AABB when cylindrical cuts can leak past it.
- Ear pads / bridges that share a corridor with a moving part (cap, paddle): size pad_r
  from the moving envelope, not a fixed 1.4 that still clips at press.

## 18. Display-board digs are real packaging

**Symptom:** freckle whitelist `cover × elec_board_sensor` at 2 mm³ while dig is 318 mm³;
PCB itself clears; mic/pot/SOIC occupy residual underface and east wall.

**Cause:** display meshes for bought boards include 3D components; face ports alone do not
clear underface solid or wall thickness.

**Rules:**

- Gate dig of display boards with honest freckle caps (or seat envelopes for rails/boss
  only). Green at 300 mm³ is a nest whitelist in disguise.
- Component clearance = residual recess over board footprint (tiled) + local punches for
  pot/mic + wall notches where components overhang into structural walls.
- Keep cradle rails and pilot bosses as keepouts when subtracting the pocket.

## 19. Live reload is mandatory; skill paths are absolute

**Symptom:** agent asks user to hard-refresh; skill read fails with "SKILL.md does not exist."

**Rules:**

- Every browser-visible page auto-updates (framework HMR or `live_reload.js` polling
  Last-Modified). Never tell the user to hard-refresh; never reopen their tab after HTML
  edits. Static serve: `Cache-Control: no-store`.
- Global skills live under `~/.claude/skills/<name>/SKILL.md` (or skill submodules). Project
  skills live under `<repo>/.claude/skills/`. Use the absolute path from the skill list —
  do not rewrite a global skill into the workspace path.

## Quick self-check before "done" on retention or drive mates

1. What feature provides **preload** (not just contact)?
2. Is every DESIGNED pair seat-kiss-capped or a positive clear gate (no nest whitelist)?
3. Is the kinematic datum the OEM stack, measured?
4. Are bought coils/pins/horns/boards in the mesh for the poses that matter?
5. Do freeze archives still match printed plastic?
6. Would a late gusset/union reseal this hole?
7. Did the viewer artifacts regenerate (GLB + pose)?
8. Is the clearance envelope derived from the printed mate's datums?
9. Residual deck: still ≥ floor, or free spans tiled ≤ thin-shell max?
10. One printable body (no relief islands)?
