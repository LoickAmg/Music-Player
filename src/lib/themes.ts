// Thèmes de couleurs : un thème se résume à quatre couleurs (fond, surface, texte, accent)
// et deux réglages (arrondi, intensité des effets) ; toutes les variables CSS de
// l'application en sont dérivées, pour les thèmes sombres comme pour les clairs.
// « Nuit bleue », le thème d'origine, ne redéfinit rien : la feuille de style s'applique telle
// quelle.

export interface ThemeColors {
  bg: string;
  surface: string;
  text: string;
  accent: string;
  /** Seconde couleur des halos (facultative, sinon dérivée de l'accent). */
  accent2?: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
  /** Arrondi des coins, en pixels (4 à 20). */
  radius: number;
  /** Intensité des halos et lueurs, de 0 (aucun) à 1. */
  glow: number;
  /** Polices assorties au thème, proposées quand on le choisit. */
  fonts?: Partial<Record<FontRole, string>>;
  builtin?: boolean;
}

export type FontRole = "ui" | "display" | "lyrics";

export const DEFAULT_THEME_ID = "nuit";

export const BUILTIN_THEMES: Theme[] = [
  { id: "nuit", name: "Nuit bleue", colors: { bg: "#050d24", surface: "#0c1d45", text: "#eef5ff", accent: "#3aa8ff", accent2: "#3fe0ff" }, radius: 10, glow: 1, builtin: true },
  { id: "oled", name: "Noir OLED", colors: { bg: "#000000", surface: "#121214", text: "#f2f2f2", accent: "#5ac8fa" }, radius: 10, glow: 0.4, builtin: true },
  { id: "neon", name: "Néon", colors: { bg: "#0b0614", surface: "#1b0f30", text: "#f6ecff", accent: "#ff2fd6", accent2: "#00f0ff" }, radius: 6, glow: 1, fonts: { display: "orbitron", lyrics: "oxanium" }, builtin: true },
  { id: "cyberpunk", name: "Cyberpunk", colors: { bg: "#0c0c0e", surface: "#1d1c16", text: "#f8f4d2", accent: "#fcee0a", accent2: "#00e1ff" }, radius: 2, glow: 0.8, fonts: { display: "rajdhani", lyrics: "chakra-petch", ui: "rajdhani" }, builtin: true },
  { id: "galaxie", name: "Galaxie", colors: { bg: "#08031c", surface: "#1a0f3f", text: "#ece6ff", accent: "#9b6bff", accent2: "#ff7ad9" }, radius: 14, glow: 1, fonts: { display: "space-grotesk", lyrics: "space-grotesk" }, builtin: true },
  { id: "espace", name: "Espace", colors: { bg: "#02060c", surface: "#0d1824", text: "#e4eef8", accent: "#7fd4ff", accent2: "#f2f7ff" }, radius: 8, glow: 0.6, fonts: { display: "michroma", lyrics: "exo-2" }, builtin: true },
  { id: "ocean", name: "Océan", colors: { bg: "#031a24", surface: "#08303f", text: "#e3f8ff", accent: "#1fd1c1", accent2: "#1b86d9" }, radius: 12, glow: 0.9, builtin: true },
  { id: "foret", name: "Forêt", colors: { bg: "#06130c", surface: "#10271a", text: "#e8f5ea", accent: "#4cd27f", accent2: "#c8f56a" }, radius: 12, glow: 0.7, builtin: true },
  { id: "braise", name: "Braise", colors: { bg: "#140806", surface: "#2a120c", text: "#ffece4", accent: "#ff6a3d", accent2: "#ffb347" }, radius: 10, glow: 0.9, builtin: true },
  { id: "theatre", name: "Théâtre", colors: { bg: "#12050a", surface: "#2a0c15", text: "#f6e6d8", accent: "#d9a54a", accent2: "#a3122e" }, radius: 4, glow: 0.7, fonts: { display: "cinzel", lyrics: "playfair-display" }, builtin: true },
  { id: "arcade", name: "Arcade", colors: { bg: "#08081a", surface: "#16163a", text: "#e9ffe6", accent: "#39ff14", accent2: "#ff2fd6" }, radius: 0, glow: 1, fonts: { display: "press-start-2p", lyrics: "vt323" }, builtin: true },
  { id: "japon", name: "Japon", colors: { bg: "#110b0b", surface: "#241717", text: "#f7ece6", accent: "#e8384f", accent2: "#f5c6cf" }, radius: 8, glow: 0.6, fonts: { display: "dela-gothic-one", lyrics: "zen-maru-gothic" }, builtin: true },
  { id: "sakura", name: "Sakura (clair)", colors: { bg: "#fff5f8", surface: "#ffffff", text: "#3a1d2a", accent: "#e2507d", accent2: "#ffb3cb" }, radius: 14, glow: 0.5, fonts: { display: "zen-maru-gothic" }, builtin: true },
  { id: "papier", name: "Papier (clair)", colors: { bg: "#f4f1ea", surface: "#fffdf8", text: "#24211c", accent: "#2f6fdb", accent2: "#9fc0ff" }, radius: 8, glow: 0.3, fonts: { display: "lora", lyrics: "lora" }, builtin: true },
  { id: "croquis", name: "Croquis (clair)", colors: { bg: "#fbfaf6", surface: "#ffffff", text: "#2b2b2b", accent: "#d95800", accent2: "#3aa0ff" }, radius: 16, glow: 0.2, fonts: { display: "permanent-marker", lyrics: "caveat", ui: "patrick-hand" }, builtin: true },
];

// ------------------------------------------------------------------ couleurs

type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Luminance relative (WCAG), de 0 (noir) à 1 (blanc). */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const channels = (c: Rgb) => c.map((v) => Math.round(v)).join(", ");
const rgba = (c: Rgb, a: number) => `rgba(${channels(c)}, ${a})`;

export function isLight(theme: Theme): boolean {
  return luminance(parseHex(theme.colors.bg) ?? [0, 0, 0]) > 0.45;
}

/** Variables CSS d'un thème. */
export function themeVariables(theme: Theme): Record<string, string> {
  const black: Rgb = [0, 0, 0];
  const white: Rgb = [255, 255, 255];
  const bg = parseHex(theme.colors.bg) ?? [5, 13, 36];
  const surface = parseHex(theme.colors.surface) ?? mix(bg, white, 0.06);
  const text = parseHex(theme.colors.text) ?? white;
  const accent = parseHex(theme.colors.accent) ?? [58, 168, 255];
  const accent2 = parseHex(theme.colors.accent2 ?? "") ?? mix(accent, white, 0.35);
  const light = luminance(bg) > 0.45;
  // Sur fond clair, les voiles et séparateurs sont foncés : on part de la couleur du texte.
  const sidebar = light ? mix(bg, black, 0.035) : mix(bg, black, 0.25);
  const content = mix(bg, surface, light ? 0.25 : 0.35);
  const bar = light ? mix(bg, white, 0.5) : mix(bg, black, 0.15);
  const separatorBase = mix(text, accent, 0.4);
  // Texte posé sur l'accent (boutons pleins) : blanc ou noir selon le meilleur contraste.
  const onAccent = contrast(accent, white) >= contrast(accent, [12, 12, 16]) ? "#fff" : "#0c0c10";
  const glow = Math.max(0, Math.min(1, theme.glow));
  return {
    "--bg": hex(bg),
    "--bg-content": hex(content),
    "--bg-sidebar": hex(sidebar),
    "--bg-elevated": hex(surface),
    "--bg-hover": rgba(accent, light ? 0.1 : 0.08),
    "--bg-active": rgba(accent, light ? 0.18 : 0.16),
    "--text": hex(text),
    "--text-2": rgba(text, light ? 0.72 : 0.66),
    "--text-3": rgba(text, light ? 0.5 : 0.42),
    "--separator": rgba(separatorBase, light ? 0.16 : 0.13),
    "--accent": hex(accent),
    "--accent-soft": rgba(accent, 0.16),
    "--accent-2": hex(accent2),
    // Accent lisible sur fond sombre (écran « À l'écoute », toujours sur la pochette).
    "--accent-on-dark": hex(light ? readableOn(accent, [14, 14, 20], 4.5, false) : accent),
    "--on-accent": onAccent,
    "--fg-rgb": channels(text),
    "--surface-rgb": channels(surface),
    "--bar-rgb": channels(bar),
    "--radius": `${theme.radius}px`,
    "--radius-sm": `${Math.round(theme.radius * 0.6)}px`,
    "--glow": glow.toFixed(2),
    "--shadow": light ? "0 10px 30px rgba(40, 30, 20, 0.16)" : "0 10px 30px rgba(0, 0, 0, 0.45)",
    "--home-bg": [
      `radial-gradient(ellipse 70% 50% at 90% -5%, ${rgba(accent, 0.42 * glow)}, transparent 70%)`,
      `radial-gradient(ellipse 55% 45% at 0% 105%, ${rgba(accent2, 0.16 * glow)}, transparent 70%)`,
      `linear-gradient(165deg, ${hex(mix(bg, accent, light ? 0.06 : 0.12))} 0%, ${hex(bg)} 45%, ${hex(mix(bg, black, light ? 0.02 : 0.35))} 100%)`,
    ].join(", "),
  };
}

/** Accent éclairci ou foncé jusqu'à rester lisible sur le fond (contraste minimal). */
function readableOn(accent: Rgb, bg: Rgb, min: number, light: boolean): Rgb {
  let c = accent;
  for (let i = 0; i < 20 && contrast(c, bg) < min; i++) c = mix(c, light ? [0, 0, 0] : [255, 255, 255], 0.1);
  return c;
}

/** Le thème dans le mode demandé : tel quel s'il y est déjà, sinon sa version claire ou
 *  sombre, calculée à partir de ses couleurs (même accent, fond et texte inversés). */
export function withScheme(theme: Theme, light: boolean): Theme {
  if (isLight(theme) === light) return theme;
  const accent = parseHex(theme.colors.accent) ?? [58, 168, 255];
  const accent2 = parseHex(theme.colors.accent2 ?? "") ?? mix(accent, [255, 255, 255], 0.35);
  let colors: ThemeColors;
  if (light) {
    const bg = mix([250, 250, 252], accent, 0.05);
    colors = {
      bg: hex(bg),
      surface: "#ffffff",
      text: hex(mix([22, 24, 30], accent, 0.12)),
      accent: hex(readableOn(accent, bg, 3.2, true)),
      accent2: hex(accent2),
    };
  } else {
    const bg = mix([6, 8, 14], accent, 0.08);
    colors = {
      bg: hex(bg),
      surface: hex(mix(bg, [255, 255, 255], 0.07)),
      text: hex(mix([240, 243, 248], accent, 0.05)),
      accent: hex(readableOn(accent, bg, 4, false)),
      accent2: hex(accent2),
    };
  }
  return { ...theme, colors };
}

/** Thème neuf, copie modifiable d'un autre. */
export function cloneTheme(theme: Theme, name: string): Theme {
  return {
    id: `perso-${Date.now().toString(36)}`,
    name,
    colors: { ...theme.colors },
    radius: theme.radius,
    glow: theme.glow,
    fonts: theme.fonts ? { ...theme.fonts } : undefined,
  };
}

/** Thème lu depuis un fichier importé : vérifié champ par champ (fichier partagé, non fiable). */
export function parseThemeFile(source: string): Theme | null {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return null;
  }
  const t = (data as { theme?: unknown })?.theme ?? data;
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  const c = (o.colors ?? {}) as Record<string, unknown>;
  const color = (v: unknown) => (typeof v === "string" && parseHex(v) ? v : null);
  const [bg, surface, text, accent] = [color(c.bg), color(c.surface), color(c.text), color(c.accent)];
  if (!bg || !surface || !text || !accent) return null;
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  const fonts: Partial<Record<FontRole, string>> = {};
  if (o.fonts && typeof o.fonts === "object") {
    for (const role of ["ui", "display", "lyrics"] as FontRole[]) {
      const f = (o.fonts as Record<string, unknown>)[role];
      if (typeof f === "string" && /^[a-z0-9-]{1,40}$/.test(f)) fonts[role] = f;
    }
  }
  return {
    id: `perso-${Date.now().toString(36)}`,
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 40) : "Thème importé",
    colors: { bg, surface, text, accent, accent2: color(c.accent2) ?? undefined },
    radius: num(o.radius, 0, 20, 10),
    glow: num(o.glow, 0, 1, 0.8),
    fonts: Object.keys(fonts).length ? fonts : undefined,
  };
}

export function themeFile(theme: Theme): string {
  const { name, colors, radius, glow, fonts } = theme;
  return JSON.stringify({ format: "music-player-theme", version: 1, theme: { name, colors, radius, glow, fonts } }, null, 2);
}
