/**
 * Accumulator-based fixed-timestep driver.
 *
 * - Simulation always advances in exact `dt` increments (default 1/120 s).
 * - Rendering interpolates between the last two states using `alpha`.
 * - Catch-up is bounded (`maxSteps`) to avoid the spiral of death; excess time is dropped.
 * - Large gaps (backgrounded tabs, suspended mobile browsers) are clamped, never replayed.
 */
export class FixedStepLoop {
  readonly dt: number;
  readonly maxSteps: number;
  /** Real-time gaps longer than this are treated as a pause (seconds). */
  readonly maxFrame: number;
  private acc = 0;
  /** Interpolation factor between previous and current simulation state, in [0, 1). */
  alpha = 0;
  /** Simulation time dropped because the device could not keep up (seconds). */
  dropped = 0;
  /** Playback speed multiplier: scales how fast simulation time advances, never the forces. */
  timeScale = 1;

  constructor(dt = 1 / 120, maxSteps = 8, maxFrame = 0.25) {
    this.dt = dt;
    this.maxSteps = maxSteps;
    this.maxFrame = maxFrame;
  }

  /** Feed a real frame duration (seconds); calls `step(dt)` zero or more times. Returns steps taken. */
  advance(frameSeconds: number, step: (dt: number) => void): number {
    if (!Number.isFinite(frameSeconds) || frameSeconds < 0) frameSeconds = 0;
    const frame = Math.min(frameSeconds, this.maxFrame) * this.timeScale;
    this.acc += frame;
    let n = 0;
    while (this.acc >= this.dt && n < this.maxSteps) {
      step(this.dt);
      this.acc -= this.dt;
      n++;
    }
    if (this.acc >= this.dt) {
      // Could not keep up: drop whole steps rather than spiralling.
      const extra = Math.floor(this.acc / this.dt) * this.dt;
      this.dropped += extra;
      this.acc -= extra;
    }
    this.alpha = this.acc / this.dt;
    return n;
  }

  reset(): void {
    this.acc = 0;
    this.alpha = 0;
  }
}
