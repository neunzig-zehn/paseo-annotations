/*
 * Paseo's design tokens for the plugin's floating UI.
 *
 * The app publishes its theme as CSS custom properties (`--colors-*`), which
 * inherit into shadow trees, so every surface here follows the selected theme
 * and switches with it. Geometry mirrors the app's menus and buttons: 8px
 * surfaces with an accent border, 6px rows, 28px controls, 14px text, and
 * 1.5px Lucide strokes.
 */

import { web, type DomElement, type DomShadowRoot } from "./dom";

const ICON_PATHS = {
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: IconName, size = 14): string {
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

/** Shared by every floating surface: the app's menu surface and controls. */
export const SURFACE_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.surface {
  font-family: var(--pa-font);
  font-size: 14px;
  line-height: 18px;
  color: var(--colors-foreground);
  background: var(--colors-surface1);
  border: 1px solid var(--colors-border-accent);
  border-radius: 8px;
  box-shadow: var(--pa-shadow);
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
}
.icon { flex: 0 0 auto; display: block; }
button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 0 0 auto;
  margin: 0;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
  outline: none;
}
button:disabled { opacity: 0.5; cursor: default; }
button[hidden] { display: none; }
button:focus-visible { border-color: var(--colors-border-accent); }
/* A menu row: the hover fill is a chip inset inside the surface. */
.item {
  min-height: 28px;
  padding: 4px 8px;
  border-radius: 6px;
  color: var(--colors-foreground);
}
.item .icon { color: var(--colors-foreground-muted); }
.item:hover:not(:disabled), .item:focus-visible { background: var(--colors-surface2); }
.item:hover:not(:disabled) .icon { color: var(--colors-foreground); }
.icon-button {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  color: var(--colors-foreground-muted);
}
.icon-button:hover:not(:disabled) { background: var(--colors-surface2); color: var(--colors-foreground); }
`;

/** The passage being commented on, painted like the browser's own selection. */
export const DRAFT_HIGHLIGHT = "paseo-annotation-draft";

/** The blue of the numbered badges Paseo puts on annotated browser elements. */
export const BADGE_COLOR = "#2563eb";

/** Page-level styles: the passage tints and the comment field's placeholder. */
const PAGE_CSS = `
::highlight(${DRAFT_HIGHLIGHT}) {
  background-color: Highlight;
}
::highlight(paseo-annotation-pending) {
  background-color: color-mix(in srgb, ${BADGE_COLOR} 18%, transparent);
}
::highlight(paseo-annotation-sent) {
  background-color: color-mix(in srgb, var(--colors-foreground) 8%, transparent);
}
::highlight(paseo-annotation-focus) {
  background-color: color-mix(in srgb, ${BADGE_COLOR} 32%, transparent);
}
[data-paseo-annotations-field]::placeholder { color: var(--colors-foreground-muted); opacity: 1; }
`;

/** Adds the page-level styles to `head`; returns their removal. */
export function installPageStyle(): () => void {
  const style = web.document.createElement("style");
  style.setAttribute("data-paseo-annotations", "");
  style.textContent = PAGE_CSS;
  web.document.head.appendChild(style);
  return () => style.remove();
}

/**
 * Copies the chat's font and the theme's elevation onto `host`. Shadows are
 * the app's medium elevation, which differs between light and dark themes.
 */
export function applyThemeTokens(host: DomElement, reference: DomElement): void {
  host.style.setProperty("--pa-font", web.window.getComputedStyle(reference).fontFamily || "system-ui, sans-serif");
  const surface = web.window.getComputedStyle(web.document.documentElement).getPropertyValue("--colors-surface0");
  host.style.setProperty(
    "--pa-shadow",
    isDark(surface) ? "0 4px 8px rgba(0, 0, 0, 0.2)" : "0 4px 16px rgba(0, 0, 0, 0.04)",
  );
}

function isDark(color: string): boolean {
  const hex = /^#?([0-9a-f]{6})/i.exec(color.trim())?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255 < 0.5;
}

/** A fixed host on `body` with a shadow root; its children position themselves in viewport coordinates. */
export function createLayer(name: string, zIndex: number): { host: DomElement; root: DomShadowRoot } {
  const host = web.document.createElement("div");
  host.setAttribute(`data-paseo-annotations-${name}`, "");
  for (const [property, value] of [
    ["position", "fixed"],
    ["top", "0"],
    ["left", "0"],
    ["width", "0"],
    ["height", "0"],
    ["overflow", "visible"],
    ["z-index", String(zIndex)],
    ["margin", "0"],
    ["padding", "0"],
  ] as const) {
    host.style.setProperty(property, value, "important");
  }
  const root = host.attachShadow({ mode: "open" });
  web.document.body.appendChild(host);
  return { host, root };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
