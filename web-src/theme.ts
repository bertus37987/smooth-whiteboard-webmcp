/**
 * The one visual vocabulary shared by the high-level composers and the agent's low-level edits.
 * `inspect_whiteboard` returns this as `designSystem`, so a hand-placed rectangle uses the same
 * ink, surface and spacing values as a generated study note.
 */
export const palette = {
  ink: "#080808",
  muted: "#404040",
  faint: "#808080",
  hairline: "#c0c0c0",
  surface: "#ffffff",
  surfaceAlt: "#f3f3f3",
  accent: "#080808",
  note: "#fff4b8",
  highlight: "#ffd84d",
  positive: "#16833b",
  warning: "#c2410c",
  info: "#2457e6"
} as const;

/** 4pt-based spacing scale; every generated layout uses these gaps and paddings. */
export const spacing = { xs: 8, sm: 12, md: 18, lg: 28, xl: 44 } as const;

export const typeScale = {
  title: { fontSize: 34, fontWeight: 700, blockStyle: "heading-1" },
  heading: { fontSize: 27, fontWeight: 700, blockStyle: "heading-2" },
  subheading: { fontSize: 21, fontWeight: 600, blockStyle: "heading-3" },
  body: { fontSize: 20, fontWeight: 400, blockStyle: "body" },
  detail: { fontSize: 18, fontWeight: 400, blockStyle: "body" },
  caption: { fontSize: 16, fontWeight: 400, blockStyle: "body" }
} as const;

export const radius = { card: 16, control: 24, frame: 24, note: 18 } as const;

export const strokeWidth = { hairline: 1.5, regular: 2.5, emphasis: 4 } as const;

export const artboardPresets = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
  custom: { width: 960, height: 640 }
} as const;

/** Minimum touch target the linter enforces. */
export const minimumTouchTarget = 44;

export const designSystem = { palette, spacing, typeScale, radius, strokeWidth, artboardPresets, minimumTouchTarget } as const;
