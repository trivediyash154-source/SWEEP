const PATHS: Record<string, string> = {
  select: 'M5 3l13 8-6 1.5L9 19z',
  add: 'M12 5v14M5 12h14',
  connect: 'M6 18a2 2 0 1 0 0-.01M18 8a2 2 0 1 0 0-.01M7.5 16.5l9-7',
  required: 'M4 12h16M4 12l4-4M4 12l4 4M20 12l-4-4M20 12l-4 4',
  delete: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12',
  depot: 'M12 3l7 7-7 11-7-11z',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  restart: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5',
  prev: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  library: 'M4 5h5v14H4zM10 5h4v14h-4zM15.5 5.5l4 1-3 13-4-1z',
  close: 'M6 6l12 12M18 6L6 18',
  import: 'M12 3v12M7 10l5 5 5-5M4 19h16',
  export: 'M12 15V3M7 8l5-5 5 5M4 19h16',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  check: 'M5 12l4 4 10-10',
  cross: 'M6 6l12 12M18 6L6 18',
  info: 'M12 8h.01M11 12h1v5h1',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  layers: 'M12 4l9 5-9 5-9-5zM3 14l9 5 9-5',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  route: 'M5 19a2 2 0 1 0 0-.01M19 5a2 2 0 1 0 0-.01M5 17V9a4 4 0 0 1 4-4h2M19 7v8a4 4 0 0 1-4 4h-2',
  menu: 'M4 7h16M4 12h16M4 17h16',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      <path d={PATHS[name]} />
    </svg>
  );
}
