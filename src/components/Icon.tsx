const PATHS = {
  "corner-sharp": <path d="M3 13V3h10" />,
  "corner-soft": <path d="M3 13V6a3 3 0 0 1 3-3h7" />,
  "corner-round": <path d="M3 13V9a6 6 0 0 1 6-6h4" />,
  alignLeft: <path d="M2.5 3h11M2.5 6.3h7M2.5 9.7h11M2.5 13h7" />,
  alignCenter: <path d="M2.5 3h11M4.5 6.3h7M2.5 9.7h11M4.5 13h7" />,
  alignRight: <path d="M2.5 3h11M6.5 6.3h7M2.5 9.7h11M6.5 13h7" />,
  caption: <path d="M2.5 3h11v7h-11zM4 13h8" />,
  expand: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  comment: <path d="M2.5 3h11v8H7l-3.5 2.5V11h-1z" />,
  crop: <path d="M4 1.5v10.5h10.5M1.5 4H12v10.5M7 4h5v5" />,
  chevron: <path d="M6 3.5 10.5 8 6 12.5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  expandAll: <path d="m5 5 3-3 3 3M5 11l3 3 3-3M3 8h10" />,
  collapseAll: <path d="m5 2 3 3 3-3M5 14l3-3 3 3M3 8h10" />,
  star: <path d="m8 2.2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4 4.4 13.3l.7-4L2.2 6.5l4-.6z" />,
  trash: <path d="M2.5 4.5h11M6 4.5V3h4v1.5M3.8 4.5l.7 8a1 1 0 0 0 1 .9h5a1 1 0 0 0 1-.9l.7-8M6.8 7v3.8M9.2 7v3.8" />,
  back: <path d="M13 8H3m4.5-4.5L3 8l4.5 4.5" />,
  forward: <path d="M3 8h10M8.5 3.5 13 8l-4.5 4.5" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="12.5" cy="8" r="1" />
    </>
  ),
  page: <path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" />,
  restore: <path d="M2.4 8A5.6 5.6 0 1 0 4 4M2.5 2.5v3h3M8 5.2V8l1.9 1.4" />,
  grip: (
    <>
      <circle cx="6" cy="4" r="1" />
      <circle cx="10" cy="4" r="1" />
      <circle cx="6" cy="8" r="1" />
      <circle cx="10" cy="8" r="1" />
      <circle cx="6" cy="12" r="1" />
      <circle cx="10" cy="12" r="1" />
    </>
  ),
  text: <path d="M3 4h10M3 8h10M3 12h6" />,
  bullet: <path d="M3 4h.01M3 8h.01M3 12h.01M6.5 4H13M6.5 8H13M6.5 12H13" />,
  todo: <path d="M3 3.5h10v9H3zM5.5 8l1.8 1.8L10.5 6.5" />,
  toggle: <path d="M3.5 5l3 3-3 3M9 5h4M9 8h4M9 11h3" />,
  quote: <path d="M3 4v8M6 5h7M6 8h7M6 11h5" />,
  divider: <path d="M2.5 8h11" />,
  code: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />,
  sigma: <path d="M12 3.5H4.5L8.5 8l-4 4.5H12" />,
  table: <path d="M2.5 3.5h11v9h-11zM2.5 7h11M6.2 3.5v9M9.8 3.5v9" />,
  image: <path d="M2.5 3.5h11v9h-11zM2.5 11l3.5-3.5 3 3 1.5-1.5 3 3M10.5 6h.01" />,
  audio: <path d="M3 6.5v3M5.5 4.5v7M8 3v10M10.5 5.5v5M13 7v2" />,
  video: <path d="M2.5 4.5h8v7h-8zM10.5 7l3-1.8v5.6l-3-1.8" />,
  link: <path d="M6.7 9.3l2.6-2.6M7 5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11l-1 1A2.5 2.5 0 0 1 4.5 8.5l1-1" />,
  note: <path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 7.4v3.3M8 5.3h.01" />,
  tip: <path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM5.6 8.2l1.8 1.8 3.2-3.4" />,
  warning: <path d="M8 2.5 14 13H2zM8 6.8v2.9M8 11.4h.01" />,
  search: <path d="M7 2.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4zM10.2 10.2l3.3 3.3" />,
  hash: <path d="M6 3 5 13M11 3l-1 10M3 6h10M2.5 10h10" />,
  tag: <path d="M2.5 8.5v-5h5l6 6-5 5zM5.5 6h.01" />,
  calendar: <path d="M2.5 4.5h11v9h-11zM2.5 7.5h11M5.5 2.5v3M10.5 2.5v3" />,
  mail: <path d="M2.5 4h11v8h-11zM2.5 4.5 8 9l5.5-4.5" />,
  phone: <path d="M4 2.5h2l1 3-1.5 1a7 7 0 0 0 3 3l1-1.5 3 1v2a1.5 1.5 0 0 1-1.5 1.5A10 10 0 0 1 2.5 4 1.5 1.5 0 0 1 4 2.5z" />,
  clock: <path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.2l2 1.3" />,
  arrowUp: <path d="M8 13V3M4 7l4-4 4 4" />,
  arrowDown: <path d="M8 3v10M4 9l4 4 4-4" />,
  filter: <path d="M2.5 3.5h11L9.5 8.5v4l-3 1v-5z" />,
  columns: <path d="M2.5 3.5h11v9h-11zM6.5 3.5v9M10 3.5v9" />,
  eye: <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />,
  eyeOff: <path d="M2.5 2.5l11 11M6.4 4a6 6 0 0 1 1.6-.5c4 0 6.5 4.5 6.5 4.5s-.8 1.4-2.2 2.6M4.3 5.5C2.8 6.7 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1 0 1.9-.3 2.7-.7" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  open: <path d="M5.5 3.5h7v7M12.5 3.5l-9 9" />,
  timeline: <path d="M2.5 4h6M5.5 8h8M3.5 12h6" />,
  function: <path d="M10.5 3.2c-1.6-.5-2.6.4-2.9 1.9L6.4 11c-.3 1.5-1.2 2.4-2.9 1.9M4.5 7.5h5" />,
  layers: <path d="M8 2.5l6 3-6 3-6-3zM2 8.5l6 3 6-3M2 11.2l6 3 6-3" />,
  download: <path d="M8 2.5v7.5M5 7l3 3 3-3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />,
  upload: <path d="M8 10V2.5M5 5.5l3-3 3 3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />,
  play: <path d="M5 3.5v9l7.5-4.5z" />,
  bolt: <path d="M9 2 3.5 9H8l-1 5L12.5 7H8z" />,
  chart: <path d="M3.5 13V8.5M8 13V3.5M12.5 13V6M2 13.5h12" />,
  form: <path d="M3 2.5h10v11H3zM5.5 6h5M5.5 9h5M5.5 11.5h2.5" />,
  feed: <path d="M3 3h10v3.5H3zM3 9.5h10V13H3z" />,
  dashboard: <path d="M2.5 2.5h5v5h-5zM8.5 2.5h5v3h-5zM2.5 8.5h5v5h-5zM8.5 7.5h5v6h-5z" />,
  edit: <path d="M9.5 3.5l3 3M3 13l.7-3.2 6.8-6.8a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2l-6.8 6.8z" />,
  monitor: <path d="M2.5 3.5h11v7.5h-11zM6 13.5h4M8 11v2.5" />,
  sun: <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M12.4 3.6l-1 1M4.6 11.4l-1 1" />,
  moon: <path d="M12.8 9.6A5.2 5.2 0 0 1 6.4 3.2a5.2 5.2 0 1 0 6.4 6.4z" />,
  gear: <path d="M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 3.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8zM8 1.7v1.9M8 12.4v1.9M1.7 8h1.9M12.4 8h1.9M4.9 4.9 3.55 3.55M11.1 4.9l1.35-1.35M4.9 11.1l-1.35 1.35M11.1 11.1l1.35 1.35" />,
  collapseSidebar: <path d="M2.5 3v10M12 4.5 8.5 8l3.5 3.5M8.5 8h5" />,
  expandSidebar: <path d="M2.5 3v10M8.5 4.5 12 8l-3.5 3.5M12 8H7" />,
  sidebar: <path d="M2.5 3.5h11v9h-11zM6.5 3.5v9" />,
  smile: <path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM5.8 9.6a2.9 2.9 0 0 0 4.4 0M6 6.6h.01M10 6.6h.01" />,
  keyboard: <path d="M1.8 4.5h12.4v7H1.8zM4 7h.01M6.4 7h.01M8.8 7h.01M11.2 7h.01M4.6 9.6h6.8" />,
  duplicate: <path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />,
} as const;

export type IconName = keyof typeof PATHS;
export const isIconName = (name: string): name is IconName => Object.prototype.hasOwnProperty.call(PATHS, name);

const FILLED = new Set<IconName>(["grip", "more"]);

/** One consistent icon set: 16px grid, 1.5 stroke, round joins, inherits text color. */
export function Icon({ name, filled = false, size = 16 }: { name: IconName; filled?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled || FILLED.has(name) ? "currentColor" : "none"}
      stroke={FILLED.has(name) && !filled ? "none" : "currentColor"}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
