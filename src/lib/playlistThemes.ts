// Thèmes des jaquettes de playlist : pas d'image, un fond coloré et le nom de la playlist
// écrit dessus. Un thème est soit un identifiant de la liste ci-dessous, soit une couleur
// choisie librement, enregistrée sous la forme « custom:#rrggbb ».

import { hslToRgb, rgbToHsl, type Rgb } from "./palette";

export interface PlaylistTheme {
  id: string;
  label: string;
  /** Fond de la jaquette (dégradé CSS). */
  background: string;
  /** Couleur du texte. */
  ink: string;
  /** Couleur des motifs décoratifs. */
  glow: string;
}

export const PLAYLIST_THEMES: PlaylistTheme[] = [
  { id: "aurora", label: "Aurore", background: "linear-gradient(145deg, #7b5cff 0%, #c04bd8 55%, #ff6fa0 100%)", ink: "#fff", glow: "#ffd1f0" },
  { id: "sunset", label: "Couchant", background: "linear-gradient(145deg, #ffb347 0%, #ff6a4d 50%, #c2275f 100%)", ink: "#fff", glow: "#ffe0a8" },
  { id: "ocean", label: "Océan", background: "linear-gradient(145deg, #1fd1c1 0%, #1b86d9 55%, #20308f 100%)", ink: "#fff", glow: "#b6fff6" },
  { id: "midnight", label: "Minuit", background: "linear-gradient(150deg, #1f6bff 0%, #0b2766 50%, #030a1f 100%)", ink: "#fff", glow: "#3fe0ff" },
  { id: "forest", label: "Forêt", background: "linear-gradient(145deg, #a8e063 0%, #3fa35b 50%, #124a3a 100%)", ink: "#fff", glow: "#e5ffb8" },
  { id: "ember", label: "Braise", background: "linear-gradient(145deg, #ff4b4b 0%, #a3122e 55%, #3a0612 100%)", ink: "#fff", glow: "#ffb3a1" },
  { id: "sakura", label: "Sakura", background: "linear-gradient(145deg, #fff0f5 0%, #ffc2d9 55%, #f78fb3 100%)", ink: "#5a1834", glow: "#ffffff" },
  { id: "lemon", label: "Citron", background: "linear-gradient(145deg, #fff7a8 0%, #ffd83d 50%, #f5a623 100%)", ink: "#4a3000", glow: "#ffffff" },
  { id: "lavender", label: "Lavande", background: "linear-gradient(145deg, #e8e0ff 0%, #b8a4ff 55%, #7d6ae0 100%)", ink: "#2a1d63", glow: "#ffffff" },
  { id: "graphite", label: "Graphite", background: "linear-gradient(145deg, #5a5a64 0%, #2c2c33 55%, #141417 100%)", ink: "#fff", glow: "#c9c9d6" },
  { id: "mint", label: "Menthe", background: "linear-gradient(145deg, #e0fff4 0%, #7de8c3 55%, #2bb38f 100%)", ink: "#0d3d30", glow: "#ffffff" },
  { id: "noir", label: "Noir & or", background: "linear-gradient(145deg, #2a2418 0%, #121010 60%, #050505 100%)", ink: "#f4d58d", glow: "#f4d58d" },
];

export const DEFAULT_THEME = "aurora";

function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: Rgb) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function customTheme(hex: string): PlaylistTheme {
  const rgb = hexToRgb(hex) ?? [123, 92, 255];
  const [h, s, l] = rgbToHsl(rgb);
  const light = hslToRgb(h - 12, Math.min(1, s * 1.05), Math.min(0.85, l + 0.18));
  const dark = hslToRgb(h + 18, Math.min(1, s * 1.1), Math.max(0.1, l - 0.3));
  const toCss = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`;
  const bright = luminance(rgb) > 0.62;
  return {
    id: `custom:${hex}`,
    label: "Personnalisée",
    background: `linear-gradient(145deg, ${toCss(light)} 0%, ${hex} 50%, ${toCss(dark)} 100%)`,
    ink: bright ? toCss(hslToRgb(h, 0.6, 0.16)) : "#fff",
    glow: bright ? "#ffffff" : toCss(hslToRgb(h, 0.9, 0.85)),
  };
}

export function themeFor(id: string | null | undefined): PlaylistTheme {
  if (id?.startsWith("custom:")) return customTheme(id.slice(7));
  return PLAYLIST_THEMES.find((t) => t.id === id) ?? PLAYLIST_THEMES[0];
}

/** Taille du nom sur la jaquette, en % de sa largeur, selon la longueur du texte. */
export function titleScale(name: string): number {
  const longestWord = Math.max(...name.split(/\s+/).map((w) => w.length), 1);
  const byLength = name.length <= 8 ? 15 : name.length <= 16 ? 12.5 : name.length <= 28 ? 10.5 : 8.5;
  // Un mot très long ne doit jamais déborder de la jaquette.
  return Math.min(byLength, 150 / Math.max(longestWord, 6));
}
