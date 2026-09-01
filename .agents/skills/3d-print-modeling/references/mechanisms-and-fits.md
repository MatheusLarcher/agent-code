# Mechanisms, fits, and what must be test-printed

Mechanical-design knowledge distilled from FDM gear/drive/enclosure projects. The recurring meta-lesson:
**friction, flex, and engagement cannot be verified virtually**, anything load-bearing or interference-fit
needs one physical test print to dial in. Flag those explicitly; don't claim a snap/clutch/press-fit "works"
from a render.

## Gears and worms

- **Three independent levers**, don't conflate them:
  - **Module** sets *size* (tooth + gear scale). Shrinking module compacts the drive without changing ratio.
  - **Tooth count / ratio** sets *torque multiplication*. A worm with N-tooth wheel = N:1.
  - **Lead angle** sets *efficiency and self-locking*. A single-start worm at a low lead angle (~5°) is
    self-locking (the output can't back-drive the input), the property that holds a load with no power.
- **Center distance = wheel pitch radius + worm pitch radius** is the one number the housing depends on.
  Derive worm pitch Ø from the lead angle, then everything else hangs off center distance.
- **Pressure angle 20°, backlash ~0.25 mm, bore clearance ~0.25 mm** were good defaults for FDM gears.
- **Spec conflicts resolve in favor of meshing physics.** When a requested OD and a requested module+teeth
  disagree, keep module + teeth (they fix the pitch diameter and the mesh) and let the OD fall out. When a
  requested worm body diameter fights the lead angle, keep the lead angle (it governs self-locking).
- **But the housing envelope is a hard constraint and the ratio is often negotiable.** The turntable's
  100-tooth ring gear pushed the pinion OD past the shell's shoulder radius; dropping the ring to 60T (4:1)
  let it tuck inside, and the lost reduction was recovered for free by the stepper's internal 64:1 gearbox.
  If there's an upstream reduction (geared motor, second stage), trade teeth for fit; the envelope won't move.
- **Self-locking worm + a stiff spring-return load is a trap for a rigid coupling**: the worm holds the
  wheel wherever the motor stops, so the load's own spring can't back-drive it. Solutions used: a **one-way
  clutch** in the drive (forward drive, free return), or **firmware that homes/parks** the output at rest.

## One-way clutches (ranked by what survived)

Through a high-ratio worm the motor's ~0.3 Nm becomes ~6 Nm (≤ ~20 Nm stall) at the output, landing on
small features at small radius → hundreds of N. Findings:
- **Printed multi-pawl freewheels / shallow ratchets SKIP under load**, the contact force cams the pawl out
  faster than it digs in. Dead end for real torque.
- **Undercut sawtooth ratchet** (locking face angled *past* radial so torque pulls the pawl into deeper
  engagement = self-energising) holds better than a radial ratchet, but **PLA teeth still crush at ~6 Nm**.
- **The durable answer is a bought steel one-way clutch bearing** (CSK / HF roller clutch). It moves the load
  off plastic entirely. **How it grips matters most:** a press-fit in *plastic* creeps and slips under
  sustained torque, take torque through **keyways**, not interference. Use a **CSK..PP clutch (keyways on
  both races)**: grow an integral lug into the outer keyway from the housing pocket and into the inner keyway
  from the adapter; add only light press (~0.15 mm) to locate. Drawn-cup HF clutches need a *steel* housing
  and a hardened-steel inner race, won't hold in plastic.
- **Direction is set on the bench, not virtually.** A clutch is directional; fit it (or flip the motor leads)
  so it locks the load-driving rotation. This is a test-print/assembly call.

## Keyed bores + manual override

- **Gear and pin/journal are separate prints joined by a square/hex fit**, never one piece: an
  attached coaxial pin forces slicer support under the gear face or around the journal (time +
  waste + rough surfaces where they hurt most). Square/hex pocket in the hub, matching boss on
  the pin, ~0.15-0.25 mm per flat dialed on a test print. Full rule + the one-sided-journal
  exception in fdm-design-rules ("Never print a gear with its pin/journal attached").

- To transmit torque to a supplied shaft, **read the shaft's real profile** (slice the supplied STL at its
  constant section, transform to world XY, center it), offset outward by ~0.25 mm clearance, and CSG-subtract
  a **straight** prism of that profile from the gear. Straight, not helical, a helical bore won't pass a
  straight shaft.
- **Manual override = a swept keyed bore.** Union rotated copies of the key profile over an arc (e.g. 50°) to
  make a fan-shaped bore. That gives **angular lost motion**: the shaft can be hand-turned ~50° before its
  keys hit the bore wall (manual release), while the motor still drives it the rest of the way. The load's own
  return spring recenters it. Independent of any clutch (the fan can be cut into the clutch inner hub instead).

## Press-fits, snaps, and slide-together joints (all test-print-tuned)

- **Friction press-fit lids beat cantilever snaps** for reusable enclosures: a flat plate + a perimeter plug
  rim that friction-fits the cavity (plug = cavity − clearance per side). Prints plate-down (plug rim rises as
  self-supporting walls). Press to seat, pry to open.
- **Clamshell halves: in-wall tongue-and-groove** (shiplap) around the perimeter, living *inside* the wall so
  it never protrudes or intrudes into a pocket. Exclude any face that must butt another module flat.
- **Slide-together modules** (dovetail tongue + socket, or tongue + open mouth) let separate prints assemble
  without tools, each prints flat in its own best orientation.
- **FDM bias:** plugs print a touch oversize, cavities undersize, so a small *nominal* gap nets a snug fit.
  Start near 0.4–0.5 mm clearance, then **dial in on one test print**, loosen if too tight, tighten toward 0
  if loose. Lead-in chamfers help slide fits seat. None of this is verifiable from a render; say so.
- **Tool-free assembly = barbed push-pins + bayonet locks instead of screws.** The turntable assembles with
  zero fasteners: a `push_pin()` (Ø4 barbed pin into a Ø4.1 hole, ~0.1 mm interference at the barb) hand-presses
  motor ears, bearing blocks, and brackets together, and the top plate bayonet-twists onto the hub. Cheaper to
  print and iterate than tapped holes, but the barb interference and the bayonet engagement are exactly the
  features that need one physical test print, they flex and can shear; don't trust them from a render.
- **Snap-tongue doors for panels opened often** (user ask: "easy to open and close", replacing 2 screws +
  captive-nut blocks on a service door): hook the panel's top edge into the frame, then per leg cut a SLIT
  beside the leg so a strip of the panel wall becomes a cantilever tongue, with an outboard barb near the free
  end that clicks behind a fixed wall band. A proud lip or step on the panel is the pull grip; the barb's back
  ramp releases on a firm pull. Keep heavy panel mass (a thick pod, ribs) OFF the tongue zone, notch it clear
  so the tongue keeps its designed flex length. Tongue length/thickness and barb engagement are test-print
  features like any snap.

## Screws + nuts are the cheap structural upgrade (default to M2/M3/M4)

A printed joint that's press-fit or glued is fine until it sees real load, then it creeps, shears a
barb, or splits a layer line. **Common small metric screws + nuts (M2 / M3 / M4) are the easiest way
to make a part strong and serviceable**, and you almost certainly already have them in a drawer.
Reach for them before designing around large or specialty hardware (an M8 bolt, a long ground rod, a
weird shoulder screw) that the user has to go buy. Small screws are cheaper, ubiquitous, and let a
joint be taken apart and re-tightened, which press-fits and glue don't.

- **Captive hex-nut trap >> self-tapping into plastic.** Model a pocket the nut drops into (across-
  flats + ~0.2 mm, depth = nut thickness + ~0.2 mm), run a clearance bore through, bolt from the
  other side. The plastic never carries the thread, the metal does, so it survives repeated assembly.
  Self-tapping a screw straight into a printed boss strips after a few cycles; only acceptable for a
  one-time, low-load fix.
- **Heat-set brass inserts** (soldering-iron press-in) when a face is re-opened often or space is too
  tight for a nut trap. Boss hole = insert's lead diameter; leave a ~1.5 mm wall around it.
- **Default sizes:** M3 is the workhorse (brackets, motor mounts, lids). M2 for small/light/tight
  parts. M4 only where the load or the part size genuinely calls for it. Clearance hole = nominal +
  ~0.4 mm (M3 -> Ø3.4); tap-free, the nut does the holding.
- **Where a screw does NOT substitute:** a *shaft* that must run inside a specific bearing bore (an
  8 mm axle in a 608's 8 mm ID) has to be that diameter, you can't swap it for an M3. That's the one
  case to spec the real rod/bolt; everywhere else (clamping plates, mounting motors, joining
  modules, reinforcing a press-fit) prefer the small screws on hand.
- **Design the holes in `build.py` as parameters** (`M3_CLEAR=3.4`, `M3_NUT_AF=5.5`, `M3_NUT_T=2.4`)
  so the fastener plan is one edit, and so a render/print can verify the nut trap actually captures.

## Bearings and shafts

- **608 (8×22×7) deep-groove** bearings on shaft ends, in Ø~22.15 press-fit pockets split across a clamshell.
  Picked over MR105 (5 mm bore too small for a 5.5 mm motor-shaft bore). Press-fit + pocket locate them; with
  no shoulder at the seat, add a shaft shoulder or E-clip groove if end-float is a problem.
- **Don't neck a load-bearing shaft down to fit a bearing bore.** A shaft thinned to Ø7.8 to clear a top
  bearing's Ø8 bore **broke under load**. Removing the top bearing and keeping the shaft full thickness
  (locating the wheel by its rim in the pocket instead) fixed it *and* removed a bridged ceiling. Less is more.

## Motor coupling

- **Double-D (flatted) shaft bore keys the motor directly**, the flats carry torque, no slip; a set-screw
  becomes just axial retention. Model the real motor (e.g. TT gearmotor: ~64×22×19 mm slab + can + a
  side-exit Ø5.5 dual-D shaft with 3.7 mm flats) in the assembly preview so clearances are visible.
- **Mount = a locating pocket the gearbox nose plugs into, split across the clamshell** so closing the lid
  traps the motor, cleaner than bolting. Open risk: axial pullout under the drive reaction (the worm pushes
  the motor out); the clamshell pinch + set-screw help, may want an external bracket/zip-tie. Lengthen the
  shaft journal so the motor shaft engages the bore ~8 mm, not ~3.
- **Wire pass-throughs split on the clamshell seam** (a semicircle in each half) so leads drop in when the lid
  closes, no threading.

## Serviceability: cartridge subassemblies + homing stops

- **Bench-assembled carrier beats in-situ screws.** When a bought module (motor + worm, display + SBC) needs
  several screws deep inside a shell, mount it to a small printed carrier ON THE BENCH, then drop the loaded
  carrier into the shell and fix it with a few short screws from an open face. Two desk-pi examples: the tilt
  cartridge (motor + worm on a plate; a dead stepper swaps without touching the head) and the screen tray
  (screen + Pi bolt to the tray at the factory bosses on the bench; the tray drops in and takes 4 short screws
  from outside the back wall, replacing 4 screws down 88.5 mm blind channels).
- **Any screw needing a driver channel longer than a normal driver shank (~50 mm) is a design smell.**
  Redesign the joint so heads land on an outside face or in an open bay; don't model the channel.
- **Check the cartridge's EXTRACTION path across the poses the mechanism can hold**, not just neutral. A worm
  cartridge extracts axially by spinning the free wheel, but with the output loaded that motion needs the mesh
  to nod further than the hard stops allow; the fix was a documented service pose ("drive the head fully up
  first"). Write the required service pose into docs/ASSEMBLY.md the moment you find it.
- **Stall-homing hard stops instead of endstop switches.** For stepper-driven joints, model deliberate stop
  features slightly OUTSIDE the software travel (stops at ±93.3° for a ±90° spec): firmware homes by driving
  into the stall, backing off, and calling it the limit. Zero extra parts or wires. Consequence for
  verification: the assembly really visits the STALL angles, so motion sweeps must go there (see
  assembly-verification.md).

## Closed loops of discrete links (tracks, chains, timing belts)

- **The loop perimeter must equal links × pitch EXACTLY.** Don't pick the wheelbase (center distance) and the
  link count independently; solve the free geometric parameter for integer closure and ASSERT it in the build
  (`assert abs(perimeter - n * pitch) < 0.15`) so a later "stretch the chassis" edit can't silently reopen the
  loop. Changing proportions then means re-solving the wheelbase, not re-counting links.
- **Close the loop with a MASTER LINK**: one link of the chain is a drop-on C-jaw variant, locked by slide-in
  keeper bars with one small screw each. The loop installs without flexing the whole chain and opens with two
  screws; a loop that only closes by stretching it over the sprocket tears at the hinge pins.

## Driving printed gears with steppers

- **Printed-gear backlash is ~0.3–0.5°, far more than a machined gear.** Open-loop step counts drift by that
  much per direction change. Expose `STEPS_PER_REV` / `STEPS_PER_DEG` as calibration constants and dial them
  on the first run against a physical reference mark; don't trust the nominal `motor_steps × ratio`.
- **A self-locking worm holds its load with the coils de-energized.** That's the big win for a battery or
  thermally-limited build: the tilt axis parks at 45° drawing zero holding current and zero heat. Release all
  coils after each move. (A back-drivable spur stage will creep, so park it against a hard stop or keep the
  last phase energized.)
- **Derive the step constant from the whole train,** including the motor's internal gearbox: a 28BYJ-48 is
  4096 half-steps/rev internally, so a 15T→60T external stage is `4096 × 60/15 = 27306` steps per output rev.

## Pivoting / gimbal mechanisms

- **Parameterize the pivot height independently and sweep clearance at the extreme angle.** On the turntable,
  putting the tilt pivot at the platter top kept the object still during tilt but made the assembly tall; moving
  it down to the cradle center made everything hang below the pivot as a stable pendulum, at the cost of the
  object swinging ~35 mm during a 45° tilt. That swing was acceptable only because the downstream tolerance (a
  3D scanner's 250 mm working-depth band) absorbed it. Decide the pivot from the *downstream* tolerance, then
  render the mechanism rotated to its max angle to confirm nothing collides or leaves the working envelope.

## Torque is a fuse, not a goal

A high-ratio drive easily exceeds what the load needs while PLA/PETG features shear well below stall. So
**current-limit the motor (treat stall current as a shear fuse)** and **home/park the output at a hard rest
position** so it never drives into a stop. **Grease the meshes**, lubrication was the single biggest life
factor in FDM-gear testing (5×+ life); design the running clearance as a grease reservoir.

## Cover / panel retention (clamp vs rest)

- **A seat pad on a return deck is a bearing surface, not a clamp.** Without undercut, screw
  preload, or interference, the panel peels. Green "solid under pad" + 0.05 gap can still
  mean free lift.
- **Opposite pocket mouths ≠ one slide.** Top windows open north; bottom open south: rigid
  fingers cannot both ride a single −Y cover slide. Solutions that worked: top tenons under
  ledge + **south lock plugs** into frozen windows with front M3 self-taps into the plugs
  preloading the pads. Pad-only "south matches north" was a multi-session false fix.
- **Cantilever snap clips** for daily open/close often break at the root when bent across
  layers (strain 10–22% vs PETG interlayer ~1–3%). Prefer rigid tenons + screws for product
  covers; keep snaps for light duty with layer-aligned flex.
- **Archive frozen frames** and redesign the cover around them; do not move printed window
  cutters to suit a new cover fantasy.

## Servo / horn / paddle mates

- Datum the paddle plane off the **spline tip + OEM socket stack**, not gear-cap height +
  half a thin plane width (that digs the cap when the arm is wider).
- Pocket = convex hull of the measured horn arm (+clear); through bore for collar + OEM
  head when the head seats on the horn, not printed plastic.
- Whitelist only horn×spline / horn×pocket kisses with mm³ floors; never blanket
  paddle×servo.
- Reach: foot track must stay inside the press pad in X and Y across the stroke; Z-only
  reach gates lie.

## Return springs and retention pins

- Model coils as pose-aware display geometry; first mesh often proves stations too far in
  (coil vs skirt). Coil-bind = **counted coils × wire**, gate clearance at full travel.
- Short spigots drop coils; multi-coil pin + seat land + light tip barb holds better. Side-load
  strength for a spring-braced pin is free tip length, not full pin L.
- Fixed barrels must stay flush with the FLIP_X bed face or the print stands on stilts.

## Printed pins under layer peel

Vertical stubs snap at the shoulder root under bending. Glue-slip printed journal + **stock
screw core** across the Z-layer plane (no metal mod to the race) survived where pure PLA
and press-fit races cracked.

## Glued flange joints: spigot register, flat faces, glue in shear

When a printed flange CA-glues to another printed part (a journal sleeve under a gear),
the joint geometry matters more than the glue (finnish-doors, three revisions to get here):

- **Glue FLAT face to FLAT face, centered by a SPIGOT RING in a shallow counterbore**
  (e.g. Ø14.2×0.4 ring into a Ø14.5×0.5 counterbore around the bore). Make the spigot
  ~0.1 mm axially SHY of the counterbore depth so the flat faces clamp — a spigot that
  bottoms first holds the glue faces apart.
- **Anti-pattern 1, flange-in-recess:** glue squish fills the register recess and the
  joint rides squish, not faces.
- **Anti-pattern 2, boss-and-cup:** a raised boss on the gear face un-flattens the print
  face (the gear no longer prints flat), and the cup collar buried itself in an
  un-counterbored mating floor — hidden for two days by a blanket fitmap whitelist.
  Counterbore every floor a glued collar passes, and keep whitelists pair-specific.
- Keep the glue in SHEAR for torque; axial peel is the weak direction, so back it up
  with a mechanical capture (ledge, screw, or the part it's trapped under) when the
  joint sees peel.
