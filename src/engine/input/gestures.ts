/**
 * Pointer gesture recogniser that separates construction from camera navigation.
 *
 * - One finger / left mouse: if it starts on a construction handle the handler claims it
 *   (drag), otherwise it orbits the camera. A short, still press is a tap.
 * - Right mouse / middle mouse / shift-drag: pan.
 * - Two fingers: pinch zoom, translate to pan, twist to rotate. Starting a second touch
 *   cancels any in-progress construction drag so pinching never places track.
 * - Wheel: zoom. pointercancel / lost capture safely abort everything.
 */
export interface GestureHandlers {
  /** Return true to claim the pointer for a construction drag. */
  dragStart(x: number, y: number): boolean;
  dragMove(x: number, y: number): void;
  dragEnd(x: number, y: number, cancelled: boolean): void;
  tap(x: number, y: number): void;
  hover(x: number, y: number): void;
  orbit(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  zoom(factor: number, x: number, y: number): void;
  rotate(dAngle: number): void;
  /** Any user interaction (used to wake audio, stop relax cameras). */
  interact(): void;
}

interface P {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  t: number;
  button: number;
  shift: boolean;
}

type Mode = 'none' | 'pending' | 'drag' | 'orbit' | 'pan' | 'multi';

const TAP_DIST = 7;
const TAP_TIME = 350;

export class GestureRecogniser {
  private pointers = new Map<number, P>();
  private mode: Mode = 'none';
  private lastDist = 0;
  private lastAngle = 0;
  private lastCx = 0;
  private lastCy = 0;
  enabled = true;

  constructor(
    private el: HTMLElement,
    private h: GestureHandlers,
  ) {
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    el.addEventListener('lostpointercapture', this.lost);
    el.addEventListener('wheel', this.wheel, { passive: false });
    el.addEventListener('contextmenu', this.ctx);
  }

  dispose(): void {
    const el = this.el;
    el.removeEventListener('pointerdown', this.down);
    el.removeEventListener('pointermove', this.move);
    el.removeEventListener('pointerup', this.up);
    el.removeEventListener('pointercancel', this.cancel);
    el.removeEventListener('lostpointercapture', this.lost);
    el.removeEventListener('wheel', this.wheel);
    el.removeEventListener('contextmenu', this.ctx);
  }

  private ctx = (e: Event) => e.preventDefault();

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private down = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.h.interact();
    const [x, y] = this.local(e);
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* capture may fail on some browsers; gestures still work */
    }
    this.pointers.set(e.pointerId, { id: e.pointerId, x, y, sx: x, sy: y, t: performance.now(), button: e.button, shift: e.shiftKey });
    if (this.pointers.size >= 2) {
      // Second finger: abandon any construction drag safely.
      if (this.mode === 'drag') {
        const p = [...this.pointers.values()][0]!;
        this.h.dragEnd(p.x, p.y, true);
      }
      this.mode = 'multi';
      this.initMulti();
      return;
    }
    if (e.button === 2 || e.button === 1 || e.shiftKey) {
      this.mode = 'pan';
      return;
    }
    if (this.h.dragStart(x, y)) {
      this.mode = 'drag';
      return;
    }
    this.mode = 'pending';
  };

  private initMulti(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    this.lastDist = Math.hypot(a.x - b.x, a.y - b.y);
    this.lastAngle = Math.atan2(b.y - a.y, b.x - a.x);
    this.lastCx = (a.x + b.x) / 2;
    this.lastCy = (a.y + b.y) / 2;
  }

  private move = (e: PointerEvent) => {
    const [x, y] = this.local(e);
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') this.h.hover(x, y);
      return;
    }
    const dx = x - p.x;
    const dy = y - p.y;
    p.x = x;
    p.y = y;
    switch (this.mode) {
      case 'drag':
        this.h.dragMove(x, y);
        break;
      case 'pending':
        if (Math.hypot(x - p.sx, y - p.sy) > TAP_DIST) {
          this.mode = 'orbit';
          this.h.orbit(x - p.sx, y - p.sy);
        }
        break;
      case 'orbit':
        this.h.orbit(dx, dy);
        break;
      case 'pan':
        this.h.pan(dx, dy);
        break;
      case 'multi': {
        const [a, b] = [...this.pointers.values()];
        if (!a || !b) break;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        if (this.lastDist > 10 && d > 10) this.h.zoom(this.lastDist / d, cx, cy);
        let da = ang - this.lastAngle;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        if (Math.abs(da) < 0.5) this.h.rotate(da);
        this.h.pan(cx - this.lastCx, cy - this.lastCy);
        this.lastDist = d;
        this.lastAngle = ang;
        this.lastCx = cx;
        this.lastCy = cy;
        break;
      }
      default:
        break;
    }
  };

  private up = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const [x, y] = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.mode === 'drag') this.h.dragEnd(x, y, false);
    else if (this.mode === 'pending' && performance.now() - p.t < TAP_TIME * 2) this.h.tap(x, y);
    if (this.pointers.size === 1 && this.mode === 'multi') {
      // Lifting one finger of a pinch continues as a camera orbit, never as construction.
      const rest = [...this.pointers.values()][0]!;
      rest.sx = rest.x;
      rest.sy = rest.y;
      this.mode = 'orbit';
      return;
    }
    if (this.pointers.size === 0) this.mode = 'none';
  };

  private cancel = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.mode === 'drag' && p) this.h.dragEnd(p.x, p.y, true);
    if (this.pointers.size === 0) this.mode = 'none';
  };

  private lost = (e: PointerEvent) => {
    if (this.pointers.has(e.pointerId)) this.cancel(e);
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.h.interact();
    const [x, y] = this.local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.h.zoom(Math.exp(Math.max(-0.5, Math.min(0.5, dy * 0.0012))), x, y);
  };
}
