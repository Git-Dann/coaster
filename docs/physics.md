# Physics model

Cozy Coaster is an entertainment simulation. It is physically grounded but simplified, and it is **not** a certified engineering or ride-safety tool. This page lists every approximation.

## Units and constants

SI throughout (m, s, kg, N, rad). Gravity defaults to 9.80665 m/s². G-forces are always expressed relative to standard gravity, even when the experimental gravity setting is changed.

## Track representation

- Designs are ordered nodes (position, unit tangent, bank, section kind and parameter).
- Each segment is a **quintic Hermite** curve. Tangent magnitudes use the circular-arc arc-length estimate. Node second derivatives are set from a shared curvature vector (average of the neighbouring cubic estimates, made perpendicular to the tangent), so curves are G1 everywhere and G2 (curvature-continuous) at nodes.
- `BakedTrack` resamples the curve uniformly in arc length (≈0.25 m) using Simpson-integrated arc-length tables and Newton refinement. Physics, rendering, supports and audio all read this baked representation; meshes are never the source of truth.
- Sampling between stored points uses cubic Hermite interpolation of position with the unit tangent as derivative. Gravity uses `dy/ds` of that interpolant, so work done by gravity matches potential energy exactly.

### Frames and banking

- Frames are **upright-continuous**: where the tangent is not near vertical the lateral axis is horizontal (sign chosen for continuity); within ~14° of vertical it is carried by rotation-minimising transport and blended back. This keeps helices level (pure parallel transport drifts on helices) and makes vertical loops invert naturally without flips.
- Bank is a roll about the tangent relative to that reference, interpolated with a monotone (Fritsch–Carlson) cubic over node arc length. Positive bank tilts the up vector towards the right rail.
- Closed circuits: any residual twist at the seam is distributed along the circuit; a half-roll parity mismatch is reported (`seamFlip`) and the builder refuses that connection with a friendly explanation.

## Train model

- Generalised coordinate `s`: arc position of the front carriage centre.
- Each carriage contributes **two bogie mass points** (half its mass each) at ±wheelbase/2, spaced by the carriage pitch. Fixed-spacing articulation.
- Equation of motion: `M_eff · s̈ = Σ_j m_j (g·T_j) + F_roll + F_drag + F_launch + F_brake`.
- `M_eff = M + Σ wheels ½ m_w` (solid-disc running wheels, I/r² = ½m). Kinetic energy uses `M_eff` consistently.
- Because gravity is summed per bogie, a long train cresting a hill is held back by cars still climbing and pulled over by cars already descending. Tests verify acceleration against an independent per-bogie sum for 1, 3 and 6 cars.

### Resistance

- **Rolling resistance**: `μ · Σ_j |N_j|`, where `N_j = m_j (v²κ_j − g⊥_j)` is the actual normal (constraint) force at each bogie, so wheels load up in valleys and unload on airtime hills. Default μ = 0.0045. Direction uses `tanh(v / 0.05 m/s)` to avoid chatter around zero speed (no static friction is modelled, so a train can creep on a very slight slope).
- **Aerodynamic drag**: quadratic, `½ ρ CdA_eff v|v|`, with `CdA_eff = CdA_lead · (1 + 0.18 · (n − 1))`. Trailing cars add only 18 % of a lead car's drag each (wake shielding, skin friction and gaps), avoiding double-counting. ρ = 1.225 kg/m³. Optional wind (environmental physics) uses relative air speed along the track.

With defaults, the starter coaster loses roughly 15 % of its mechanical energy per lap, in line with typical steel coasters.

### Powered sections

- **Chain lift**: a velocity constraint. While any car is on a lift section, the train is carried at chain speed, catching up from its previous speed at 2.5 m/s². A ratchet prevents rollback (anti-rollback dogs). A train faster than the chain runs free.
- **Launch (LSM)**: force per car on the section, `m_car · a_launch`, tapering to zero over the last 1.5 m/s before the target speed.
- **Magnetic brakes**: per car on the section, deceleration `min(a_max, 3 · (|v| − v_target))` opposing motion. They only remove energy.
- **Station**: tyre drive brings the front car to a stop mark with a speed profile `√(2·1.2·d)` capped at 2.2 m/s and 2.2 m/s² authority (5 m/s² friction brake if the train arrives too fast), holds for the dwell time, then dispatches at 1.6 m/s.
- **Unfinished track**: on open tracks a virtual buffer decelerates the train before the end and pauses it safely. This is deliberately non-physical and only exists so incomplete layouts never crash.

Energy added by lifts, launches and tyres and energy removed by resistance and brakes are accumulated in telemetry (`powered`, `dissipated`), so the energy balance can be audited.

## Integration and timing

- Classic **RK4** on (s, v) at a fixed **120 Hz** step. Velocity constraints are applied after each step.
- 120 Hz vs 60 Hz: both conserve energy well on the test circuits (relative drift ≈1e-5 over 60 s at 120 Hz). Lifts, brakes and the station controller respond more smoothly at 120 Hz, and the cost is negligible (≈0.1 ms per frame for a six-car train on desktop), so 120 Hz is the default.
- Accumulator loop with at most 8 catch-up steps per frame; excess time is dropped (no spiral of death). Gaps longer than 0.25 s (backgrounded tabs, suspended phones) are clamped, never replayed.
- Rendering interpolates the train between the last two simulation states.
- Inputs are validated: carriage count clamped to 1–6; physics parameters clamped to documented ranges; non-finite state triggers a safe stop and a `numeric-error` event.

## G-forces and telemetry

Track acceleration `a = s̈ T + v² κ`. Apparent force per unit mass `f = a − g`, expressed in the lead car's frame: vertical (`f·up`), lateral (`f·right`), longitudinal (`f·T`), divided by g₀. Jerk is the smoothed time derivative of vertical G.

## Known approximations

- Physics follows the track centre line, not the rider heartline.
- Fixed spacing: couplings are rigid along the track (no slack, no coupler forces).
- No static friction, no wheel slip, no track flex, no temperature effects.
- Inverted and near-vertical sections are not supported from the ground (visual limitation, not physics).
- The wind model is a constant vector, not turbulence.

## Validation

`src/tests/physics/physics.test.ts` covers: free-coast energy conservation and timestep convergence; inclined-track acceleration; resistance only removing energy; flat-track coasting without oscillation; rollback with the expected rise height; distributed mass against an independent calculation, crest behaviour and slope invariance; banked turns (no lateral G, expected vertical G); vertical loop energy and inversion; lift engagement, chain speed and anti-rollback; braking without energy gain; station stopping and repeatable lap times; seam continuity; frame-rate independence (30/60/120/144 FPS and irregular frames); 20 minutes of continuous operation; origin independence (translated by 250 km); input clamping.
