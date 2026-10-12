import { defineStore } from "pinia";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/lib/api";
import { ensureFont, fontStack, SYSTEM_FONT, type CustomFont } from "@/lib/fonts";
import { BUILTIN_THEMES, DEFAULT_THEME_ID, isLight, themeVariables, type FontRole, type Theme } from "@/lib/themes";

// Personnalisation de l'application : thème de couleurs, polices, taille des paroles.
// Enregistrée côté Rust (appearance.json, survit à une réinstallation de la vue web) et
// recopiée dans le stockage local pour être appliquée dès le lancement, sans éclair aux
// couleurs d'origine (voir applyCachedAppearance).

export interface AppearanceSettings {
  themeId: string;
  customThemes: Theme[];
  fonts: Record<FontRole, string>;
  customFonts: CustomFont[];
  /** Taille des paroles (multiplicateur, 0,8 à 1,4). */
  lyricsScale: number;
  /** Couleur d'accent tirée de la pochette en cours. */
  followArtwork: boolean;
}

const CACHE_KEY = "mp:appearance-vars";

export function defaultAppearance(): AppearanceSettings {
  return {
    themeId: DEFAULT_THEME_ID,
    customThemes: [],
    fonts: { ui: SYSTEM_FONT, display: SYSTEM_FONT, lyrics: SYSTEM_FONT },
    customFonts: [],
    lyricsScale: 1,
    followArtwork: false,
  };
}

/** Réglages lus depuis le disque, complétés et vérifiés (fichier éventuellement ancien). */
function normalize(raw: unknown): AppearanceSettings {
  const base = defaultAppearance();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Partial<AppearanceSettings>;
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  return {
    themeId: typeof o.themeId === "string" ? o.themeId : base.themeId,
    customThemes: Array.isArray(o.customThemes) ? o.customThemes.filter((t) => t && t.id && t.colors) : [],
    fonts: { ...base.fonts, ...(o.fonts ?? {}) },
    customFonts: Array.isArray(o.customFonts) ? o.customFonts.filter((f) => f && f.id && f.file) : [],
    lyricsScale: num(o.lyricsScale, 0.8, 1.4, 1),
    followArtwork: o.followArtwork === true,
  };
}

/** Applique au lancement les variables du dernier thème, avant même le premier rendu. */
export function applyCachedAppearance() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as { vars: Record<string, string>; light: boolean } | null;
    if (!cached) return;
    setVariables(cached.vars, cached.light);
  } catch {
    // stockage indisponible : le thème s'appliquera à la lecture des réglages
  }
}

let appliedKeys: string[] = [];

function setVariables(vars: Record<string, string>, light: boolean) {
  const root = document.documentElement;
  for (const key of appliedKeys) if (!(key in vars)) root.style.removeProperty(key);
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  appliedKeys = Object.keys(vars);
  const themed = Object.keys(vars).some((k) => k === "--bg");
  if (themed) root.dataset.themed = "1";
  else delete root.dataset.themed;
  root.dataset.scheme = light ? "light" : "dark";
  root.style.colorScheme = light ? "light" : "dark";
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useAppearanceStore = defineStore("appearance", {
  state: () => ({
    settings: defaultAppearance(),
    customDir: "",
    /** Le dernier enregistrement a échoué (affiché dans la personnalisation). */
    saveError: null as string | null,
  }),
  getters: {
    themes(state): Theme[] {
      return [...BUILTIN_THEMES, ...state.settings.customThemes];
    },
    theme(): Theme {
      return this.themes.find((t) => t.id === this.settings.themeId) ?? BUILTIN_THEMES[0];
    },
  },
  actions: {
    setFromInitialState(raw: unknown, customDir: string) {
      this.settings = normalize(raw);
      this.customDir = customDir;
      this.apply();
    },
    /** Adresse d'un fichier importé (police, image), servie par le protocole « asset ». */
    assetUrl(file: string): string {
      const sep = this.customDir.includes("\\") ? "\\" : "/";
      return convertFileSrc(`${this.customDir}${sep}${file}`);
    },
    fontStackFor(id: string | null | undefined, fallback: "ui" | "display" = "display"): string {
      return fontStack(id, fallback);
    },
    loadFont(id: string | null | undefined): Promise<void> {
      return ensureFont(id, (file) => this.assetUrl(file), this.settings.customFonts);
    },
    /** Calcule et pose toutes les variables CSS (thème, polices, paroles). */
    apply() {
      const s = this.settings;
      const theme = this.theme;
      const vars: Record<string, string> = theme.id === DEFAULT_THEME_ID ? {} : themeVariables(theme);
      if (s.followArtwork) {
        const fallback = vars["--accent"] ?? "#3aa8ff";
        vars["--accent"] = `var(--amb-glow, ${fallback})`;
        vars["--accent-soft"] = `color-mix(in srgb, var(--amb-glow, ${fallback}) 16%, transparent)`;
      }
      if (s.fonts.ui !== SYSTEM_FONT) vars["--font"] = fontStack(s.fonts.ui, "ui");
      if (s.fonts.display !== SYSTEM_FONT) vars["--font-display"] = fontStack(s.fonts.display, "display");
      if (s.fonts.lyrics !== SYSTEM_FONT) vars["--font-lyrics"] = fontStack(s.fonts.lyrics, "display");
      if (s.lyricsScale !== 1) vars["--lyrics-scale"] = s.lyricsScale.toFixed(2);
      for (const id of Object.values(s.fonts)) void this.loadFont(id);
      const light = theme.id !== DEFAULT_THEME_ID && isLight(theme);
      setVariables(vars, light);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ vars, light }));
      } catch {
        // pas de cache : simple éclair aux couleurs d'origine au prochain lancement
      }
    },
    /** Applique tout de suite, enregistre un peu plus tard (curseurs, pipettes). */
    changed() {
      this.apply();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        api
          .setAppearance(JSON.parse(JSON.stringify(this.settings)))
          .then(() => (this.saveError = null))
          .catch((e) => (this.saveError = String(e)));
      }, 400);
    },
    selectTheme(id: string, withFonts = false) {
      this.settings.themeId = id;
      const theme = this.theme;
      if (withFonts && theme.fonts) {
        for (const role of ["ui", "display", "lyrics"] as FontRole[]) {
          this.settings.fonts[role] = theme.fonts[role] ?? SYSTEM_FONT;
        }
      }
      this.changed();
    },
    saveTheme(theme: Theme) {
      const list = this.settings.customThemes;
      const i = list.findIndex((t) => t.id === theme.id);
      if (i >= 0) list.splice(i, 1, theme);
      else list.push(theme);
      this.settings.themeId = theme.id;
      this.changed();
    },
    deleteTheme(id: string) {
      this.settings.customThemes = this.settings.customThemes.filter((t) => t.id !== id);
      if (this.settings.themeId === id) this.settings.themeId = DEFAULT_THEME_ID;
      this.changed();
    },
    setFont(role: FontRole, id: string) {
      this.settings.fonts[role] = id;
      this.changed();
    },
    /** Importe un fichier de police ; renvoie son identifiant (« custom:… »). */
    async importFont(file: File): Promise<string> {
      const ext = (file.name.split(".").pop() ?? "").toLowerCase();
      const name = await api.importAsset("font", ext, new Uint8Array(await file.arrayBuffer()));
      const id = `custom:${name}`;
      const label = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Ma police";
      this.settings.customFonts.push({ id, label, file: name });
      this.changed();
      return id;
    },
    async removeCustomFont(id: string) {
      const font = this.settings.customFonts.find((f) => f.id === id);
      this.settings.customFonts = this.settings.customFonts.filter((f) => f.id !== id);
      for (const role of ["ui", "display", "lyrics"] as FontRole[]) {
        if (this.settings.fonts[role] === id) this.settings.fonts[role] = SYSTEM_FONT;
      }
      this.changed();
      if (font) await api.deleteAsset(font.file).catch(() => {});
    },
    reset() {
      const keep = this.settings.customThemes;
      const fonts = this.settings.customFonts;
      this.settings = { ...defaultAppearance(), customThemes: keep, customFonts: fonts };
      this.changed();
    },
  },
});
