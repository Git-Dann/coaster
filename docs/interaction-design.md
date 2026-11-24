# Interaction design

## Principles

- The world is the main surface. Panels are contextual and dismissable.
- Every action gives feedback: motion, sound, and (where supported) haptics.
- Nothing is ever red, alarming or punitive. Problems become friendly hints with a next step.
- Mobile first: portrait works fully; landscape moves sheets to the side.

## Layout

- **Phone**: top bar (coaster name + save dot, undo/redo, frame, settings), bottom navigation (Build, Train, Style, Scenery, Weather, Ride), bottom sheet above the nav (max 46 % of the viewport). Photo and relax modes live in the Ride panel on narrow screens.
- **Desktop / tablet ≥ 900 px**: floating pill toolbar centred at the bottom, inspector floating at bottom-left, modals centred.
- **Landscape phones**: icon-only nav, sheet docked right.
- Safe areas via `env(safe-area-inset-*)`, dynamic viewport units (`dvh`).

## Construction

1. Choose a piece (chips). Defaults are sensible; a translucent preview appears immediately.
2. Drag the **ring** to steer (length and turn follow the finger), or the **arrow** to raise/lower. Sliders mirror the handles for precision and accessibility.
3. Automatic banking suits turns to the estimated train speed.
4. Hints appear for very tight turns, ground clipping and insufficient height. Impossible geometry (radius < 2.2 m) is refused with an explanation.
5. **Place** commits (Enter). **Connect** shows the closing curve as a preview first; nothing changes until confirmed.
6. Tap any point on the track to edit its height or banking in metre/5° steps.

## Gestures

| Input | Result |
|---|---|
| One finger / left drag on a handle | Construction drag |
| One finger / left drag elsewhere | Orbit |
| Tap | Select / place scenery / remove scenery |
| Two fingers | Pinch zoom, pan, twist rotate. Cancels any construction drag |
| Right / middle / shift drag | Pan |
| Wheel | Zoom |

## Keyboard

Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo, Ctrl/Cmd+S save now, Esc cancel/back, Enter place, B build, F frame coaster, C cycle cameras, Space dispatch, P photo mode, R relax mode, arrow keys orbit/zoom.

## Design tokens

`src/design-system/tokens.css`: colour, type, spacing (4–32 px), radius, elevation, motion (120/220/360 ms, spring easing), touch target 48 px, plus larger-UI, high-contrast and reduced-motion variants.

## Accessibility

Semantic buttons with labels and `aria-pressed`/`role=radio|switch`, visible focus rings, modal focus management with Escape, a polite live region for state changes, keyboard alternatives for camera and construction (sliders), reduced motion, camera stabilisation, larger UI, higher contrast, simplified controls. Limitations: the 3D view itself is not navigable by screen reader, and a formal WCAG 2.2 AA audit with assistive technology has not been done.
