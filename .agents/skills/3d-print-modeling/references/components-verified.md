# Bought components: verified dimensions + the never-guess rule

**The rule: never model a bought part from memory.** Across projects, guessed component
dimensions were the #2 time sink after assemblability: a TT gearmotor took FIVE correction
rounds (photos, wrong screw boss, wrong shaft side) before the user said "trust the STL";
a keypad print was a total write-off because it was designed against an imagined keypad
instead of the real 4x4 matrix (no room for its pin headers); an L298N was modeled 25 mm
tall and is 28.6, so the box didn't close; a charge board assumed 9x24 mm measured
26.6x31.3; battery holders were wrong in all three axes.

Before designing around ANY bought part:
1. **Get dimensions from a datasheet, the user's caliper, or a user-supplied STL**, in
   that order of preference. State which source you used.
2. **Echo the key dims back to the user for confirmation** before geometry depends on
   them ("modeling the holder as 78.5 x 40 x 22.5, mounting holes at ..., confirm?").
   One question is cheaper than one reprint.
3. **Model the part into the assembly GLB** (as a named non-printed part) so clearances,
   insertion paths, and wire room are visible and checkable by `assembly_check.py`.
4. **Include connector/header overhead.** Boards are never their PCB outline: pin
   headers, USB sockets, heatsinks, and soldered capacitor legs set the real envelope.
   This killed more enclosure fits than the PCBs themselves.
5. Keep the measured model in a project `components/` dir (or reuse across projects);
   downloaded "reference" STLs can be illustrative, not mechanical CAD; verify before
   trusting ("the charge-board STL turned out to be a low-poly illustrative scene").

## Dimensions verified in real sessions (re-verify against YOUR unit; clones vary)

- **28BYJ-48 stepper**: 4096 half-steps/rev (internal ~64:1 gearbox). Shaft is OFFSET
  from the can center by ~7.9 mm; locate features from the CAN, don't fight the offset.
  Shaft ~Ø5 double-D with flats (~3 mm across measured ~4.93 on one unit); a plain round
  bore SLIPS, always key the flats. Holds position only while a coil is energized (no
  detent worth trusting); pair with a self-locking worm to hold with power off.
- **TT gearmotor (yellow)**: housing ~70 x 23 x 25 mm (user-measured; datasheets say
  65-70 depending on variant). Side-exit Ø5.5 dual-D shaft, flats 3.7 mm. Has ONE screw
  boss on the can side; its position was mis-modeled repeatedly, take it from an STL or
  photo of the actual unit. The 120:1 variant is an order of magnitude short on torque
  for a 1/10 crawler; check torque math before designing the chassis around it.
- **L298N driver board**: ~43 x 43 footprint, ~28.6 mm TALL including heatsink +
  terminals (not the 25 mm the bare heatsink suggests).
- **DRV8833 board**: ~small 2-channel option chosen over L298N for 3-6 V motors; verify
  the specific breakout's pin-header height.
- **TP4056 USB-C charge board**: USB-C is CHARGE-IN ONLY, never an output path; never
  route motor current through the charge board or the controller. Standard "03962A with
  protection" is ~28 x 17.5 mm; measured-with-connector heights vary, measure yours.
- **MT3608 boost board**: SOT-23-6 chip; ~0.5 W dissipation ceiling means ~1.7 A output
  in a sealed enclosure runs too hot, that is a design ceiling, not a tuning problem.
  Coil whine into a phone: fixed by 1000 uF electrolytic + 100 nF ceramic across Vout.
- **18650 holders**: single measured 78.5 x 40 x 22.5 mm; dual measured 80 x 42 x 22.
  The spring end needs compression room; model the holder, not the cell.
- **608 bearing**: 8 x 22 x 7 mm; press-fit pocket Ø22.15, split across a clamshell.
  Don't neck a load shaft to 7.8 to pass the 8 mm bore, it snaps; see mechanisms doc.
- **HF/CSK one-way clutch bearings**: drawn-cup HF needs a STEEL housing and hardened
  inner race, it will not hold in plastic; use CSK..PP (keyways both races), torque
  through keys, light press only to locate.
- **4x4 membrane/tactile keypad ("Tegg")**: budget space for the PIN HEADER ROW along
  one edge, plus tail clearance; tactile keys have ~0.5 mm real travel, don't design
  5 mm-travel printed caps over them.
- **Raspberry Pi**: Pi 5 wants 5 V/5 A PD (27 W official) or it software-limits USB to
  600 mA. Pi 3A+ has 512 MB RAM: 1920px camera streams OOM-kill, 720p is the practical
  ceiling. mDNS: `<hostname>.local` resolves where the bare hostname doesn't.
- **Official 7" touchscreen**: display mount tabs are shallow, screw bosses punched
  2.5 mm through them in one build; take boss depth from the drawing, not the glass.
- **Pi Camera v2.1/v3**: enable continuous autofocus (v3) or streams look blurry;
  aperture cones need a wider clearance than the lens barrel or corners vignette.
- **Slip rings**: hobby capsule rings are ~2 A/circuit; they cannot pass a 5 A motor
  rail. For <360-degree travel, use a service-loop coil instead.

## Electronics-in-enclosures checklist (the recurring killers)

- Wire bend radius + connector overhang at every port; a USB-C plug body needs ~10 mm
  behind the socket.
- Motor current never through controller or charge board; separate rails, common ground.
- Shared 5 V rail brownout: servo/motor inrush resets SBCs; separate regulation or bulk
  capacitance at the rail.
- Every board gets: mounting bosses matched to REAL hole positions, tallest-component
  clearance, and an insertion path (can you actually place it after the walls exist?).
- Ventilation for anything dissipating (boost converters, drivers, Pi): a sealed pickle
  is an oven.
