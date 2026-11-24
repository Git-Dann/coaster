/** Hand-drawn style stroke icon set (original). 24×24, round caps. */
const P: Record<string, string> = {
  build: 'M4 18c3-6 5-9 8-9s4 5 8 5M4 18h16M7 18v-3M12 18V9M17 18v-4',
  train: 'M5 15h14v-4a3 3 0 0 0-3-3H8a3 3 0 0 0-3 3zM8 18.5a1.5 1.5 0 1 0 0-.01M16 18.5a1.5 1.5 0 1 0 0-.01M5 12h14',
  style: 'M12 3c5 0 9 3.6 9 8 0 2.5-2 3.5-3.5 3.5H15a2 2 0 0 0-1.4 3.4c.8.9.2 3.1-1.6 3.1-5 0-9-4-9-9s4-9 9-9zM7.5 11a.5.5 0 1 0 0-.01M11 7.5a.5.5 0 1 0 0-.01M15.5 8a.5.5 0 1 0 0-.01',
  scenery: 'M12 3l-5 8h3l-4 6h12l-4-6h3zM12 17v4',
  weather: 'M7 17a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 8.5 3.8 3.8 0 0 1 17.5 17zM9 20l-1 1.5M13 20l-1 1.5M17 20l-1 1.5',
  ride: 'M3 17c2.5-5 4.5-10 7-10s3 7 5.5 7S19 9 21 7M3 20h18',
  undo: 'M9 7L5 11l4 4M5 11h9a5 5 0 0 1 0 10h-2',
  redo: 'M15 7l4 4-4 4M19 11h-9a5 5 0 0 0 0 10h2',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  camera: 'M4 8h3l2-2.5h6L17 8h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  play: 'M8 5.5v13l10-6.5z',
  pause: 'M8 5v14M16 5v14',
  reset: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.7A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.6 6.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.1-1',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  trash: 'M5 7h14M9 7V4.5h6V7M7 7l1 13h8l1-13',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  frame: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  leaf: 'M5 19c0-8 5-14 14-14 0 9-6 14-14 14zM5 19l7-7',
  brush: 'M14 4l6 6-8 8H6v-6zM4 20h5',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2.5M12 19v2.5M21.5 12H19M5 12H2.5M18.7 5.3L17 7M7 17l-1.7 1.7M18.7 18.7L17 17M7 7L5.3 5.3',
  moon: 'M19 14.5A7.5 7.5 0 0 1 9.5 5 7.5 7.5 0 1 0 19 14.5z',
  folder: 'M3.5 6.5h6l2 2h9v10.5h-17z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.8v.2',
  chart: 'M4 19h16M7 16V11M12 16V6M17 16v-3',
  hand: 'M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 6.5-6 6.5S5.5 18 4.5 15l-1-3a1.4 1.4 0 0 1 2.5-1.2L8 13',
  mirror: 'M12 3v18M8 7l-5 5 5 5zM16 7l5 5-5 5z',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  speaker: 'M4 9.5h4L13 5v14l-5-4.5H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9.5h4L13 5v14l-5-4.5H4zM17 9.5l5 5M22 9.5l-5 5',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9.5l5-5 5 5M5 20h14',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  pencil: 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  music: 'M9 18V6l11-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  eraser: 'M8 20h12M5.5 14.5l7-7 5 5-7 7H8z M12.5 7.5l3-3 5 5-3 3',
  wand: 'M5 19L15 9M14 4v3M18 8h3M17.5 4.5l-2 2M19 13l-1.5-1.5',
  'p-straight': 'M3 15h18M3 18h18M6 15v3M10 15v3M14 15v3M18 15v3',
  'p-left': 'M18 20v-6a6 6 0 0 0-6-6H5M8 5L5 8l3 3',
  'p-right': 'M6 20v-6a6 6 0 0 1 6-6h7M16 5l3 3-3 3',
  'p-up': 'M3 19h5c5 0 6-10 11-10h2M17 6l3 3-3 3',
  'p-down': 'M3 9h2c5 0 6 10 11 10h5M17 16l3 3-3 3',
  'p-hill': 'M2 18c4 0 5-11 10-11s6 11 10 11',
  'p-lift': 'M3 19h3l12-12h3M7 15l1 1M10 12l1 1M13 9l1 1M16 6l1 1',
  'p-drop': 'M3 6h4c3 0 4 13 9 13h5',
  'p-loop': 'M2 19h7c-3-2-4-6-1-9s8-2 8 3-5 6-7 6h13',
  'p-roll': 'M3 14c3 0 4-4 9-4s6 4 9 4M12 10a4 4 0 1 0 0 8',
  'p-cork': 'M2 12h3c2-5 5-5 7 0s5 5 7 0h3M8 12c1 3 3 3 4 0',
  'p-helix': 'M5 7c0-2 14-2 14 0s-14 2-14 4 14 2 14 4-14 2-14 4',
  'p-brake': 'M3 16h18M6 12v4M9 12v4M12 12v4M15 12v4M18 12v4',
  'p-launch': 'M3 15h12M3 18h12M16 12l5 4.5-5 4.5M13 12l3 4.5-3 4.5',
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 22, label }: { name: IconName | string; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d={P[name] ?? P.sparkle} />
    </svg>
  );
}
