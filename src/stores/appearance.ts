import { defineStore } from "pinia";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "@/lib/api";
import { ensureFont, fontStack, SYSTEM_FONT, type CustomFont } from "@/lib/fonts";
import { BUILTIN_THEMES, DEFAULT_THEME_ID, isLight, themeVariables, withScheme, type FontRole, type Theme } from "@/lib/themes";

// Personnalisation de l'application : thème et mode clair / sombre, polices, boutons et
// champs, icônes, profil, icône de l'application. Enregistrée côté Rust (appearance.json,
// survit à une réinstallation de la vue web) et recopiée dans le stockage local pour être
// appliquée dès le lancement, sans éclair aux couleurs d'origine (applyCachedAppearance).

/** « theme » : le mode du thème choisi ; « auto » : celui du système. */
export type SchemeMode = "theme" | "light" | "dark" | "auto";
export type ButtonShape = "pill" | "round" | "square";
export type ButtonStyle = "gradient" | "flat" | "outline" | "glass";
export type FieldShape = "round" | "pill" | "square";
export type FieldStyle = "filled" | "outline" | "underline";
export type IconStyle = "classic" | "thin" | "bold" | "square" | "duo";

export interface AppearanceSettings {
  themeId: string;
  customThemes: Theme[];
  mode: SchemeMode;
  fonts: Record<FontRole, string>;
  customFonts: CustomFont[];
  /** Taille des paroles (multiplicateur, 0,8 à 1,4). */
  lyricsScale: number;
  /** Couleur d'accent tirée de la pochette en cours. */
  followArtwork: boolean;
  buttons: { shape: ButtonShape; style: ButtonStyle };
  fields: { shape: FieldShape; style: FieldStyle };
  icons: IconStyle;
  profile: { name: string; avatar: string | null };
  /** Icône de l'application : variante dessinée (public/app-icons) ou « photo ». */
  appIcon: string;
  /** Photo choisie comme icône de fenêtre (ordinateur). */
  appIconImage: string | null;
}

const CACHE_KEY = "mp:appearance-vars";
const ON_ANDROID = /Android/i.test(navigator.userAgent);

export function defaultAppearance(): AppearanceSettings {
  return {
    themeId: DEFAULT_THEME_ID,
    customThemes: [],
    mode: "theme",
    fonts: { ui: SYSTEM_FONT, display: SYSTEM_FONT, lyrics: SYSTEM_FONT },
    customFonts: [],
    lyricsScale: 1,
    followArtwork: false,
    buttons: { shape: "round", style: "gradient" },
    fields: { shape: "round", style: "filled" },
    icons: "classic",
    profile: { name: "", avatar: null },
    appIcon: "origine",
    appIconImage: null,
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Réglages lus depuis le disque, complétés et vérifiés (fichier éventuellement ancien). */
function normalize(raw: unknown): AppearanceSettings {
  const base = defaultAppearance();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Partial<AppearanceSettings>;
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    themeId: typeof o.themeId === "string" ? o.themeId : base.themeId,
    customThemes: Array.isArray(o.customThemes) ? o.customThemes.filter((t) => t && t.id && t.colors) : [],
    mode: oneOf(o.mode, ["theme", "light", "dark", "auto"] as const, base.mode),
    fonts: { ...base.fonts, ...(o.fonts ?? {}) },
    customFonts: Array.isArray(o.customFonts) ? o.customFonts.filter((f) => f && f.id && f.file) : [],
    lyricsScale: num(o.lyricsScale, 0.8, 1.4, 1),
    followArtwork: o.followArtwork === true,
    buttons: {
      shape: oneOf(o.buttons?.shape, ["pill", "round", "square"] as const, base.buttons.shape),
      style: oneOf(o.buttons?.style, ["gradient", "flat", "outline", "glass"] as const, base.buttons.style),
    },
    fields: {
      shape: oneOf(o.fields?.shape, ["round", "pill", "square"] as const, base.fields.shape),
      style: oneOf(o.fields?.style, ["filled", "outline", "underline"] as const, base.fields.style),
    },
    icons: oneOf(o.icons, ["classic", "thin", "bold", "square", "duo"] as const, base.icons),
    profile: {
      name: typeof o.profile?.name === "string" ? o.profile.name.slice(0, 40) : "",
      avatar: str(o.profile?.avatar),
    },
    appIcon: typeof o.appIcon === "string" && /^[a-z]{2,20}$/.test(o.appIcon) ? o.appIcon : base.appIcon,
    appIconImage: str(o.appIconImage),
  };
}

type Applied = { vars: Record<string, string>; light: boolean; attrs: Record<string, string> };

/** Applique au lancement le dernier rendu, avant même le premier affichage. */
export function applyCachedAppearance() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Applied | null;
    if (cached) setVariables(cached);
  } catch {
    // stockage indisponible : l'apparence s'appliquera à la lecture des réglages
  }
}

let appliedKeys: string[] = [];

function setVariables({ vars, light, attrs }: Applied) {
  const root = document.documentElement;
  for (const key of appliedKeys) if (!(key in vars)) root.style.removeProperty(key);
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  appliedKeys = Object.keys(vars);
  if ("--bg" in vars) root.dataset.themed = "1";
  else delete root.dataset.themed;
  root.dataset.scheme = light ? "light" : "dark";
  root.style.colorScheme = light ? "light" : "dark";
  for (const [key, value] of Object.entries(attrs ?? {})) root.dataset[key] = value;
}

/** Le système est-il en mode sombre ? (Android le dit directement : la vue web ne suit pas
 *  toujours le réglage du téléphone.) */
function systemPrefersDark(): boolean {
  const android = window.AndroidLook?.systemDark?.();
  if (typeof android === "boolean") return android;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useAppearanceStore = defineStore("appearance", {
  state: () => ({
    settings: defaultAppearance(),
    customDir: "",
    systemDark: true,
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
    /** Mode clair effectivement affiché. */
    light(): boolean {
      const mode = this.settings.mode;
      if (mode === "light") return true;
      if (mode === "dark") return false;
      if (mode === "auto") return !this.systemDark;
      return isLight(this.theme);
    },
    /** Le thème dans le mode affiché (version claire ou sombre calculée au besoin). */
    effectiveTheme(): Theme {
      return withScheme(this.theme, this.light);
    },
  },
  actions: {
    setFromInitialState(raw: unknown, customDir: string) {
      this.settings = normalize(raw);
      this.customDir = customDir;
      this.systemDark = systemPrefersDark();
      // Mode « automatique » : suit le système quand il change (coucher du soleil…).
      window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => this.onSystemScheme());
      window.__mpSystemDark = (dark: boolean) => this.onSystemScheme(dark);
      this.apply();
      void this.applyWindowIcon();
    },
    onSystemScheme(dark?: boolean) {
      this.systemDark = dark ?? systemPrefersDark();
      if (this.settings.mode === "auto") this.apply();
    },
    /** Adresse d'un fichier importé (police, image), servie par le protocole « asset ». */
    assetUrl(file: string): string {
      return convertFileSrc(this.assetPath(file));
    },
    assetPath(file: string): string {
      const sep = this.customDir.includes("\\") ? "\\" : "/";
      return `${this.customDir}${sep}${file}`;
    },
    fontStackFor(id: string | null | undefined, fallback: "ui" | "display" = "display"): string {
      return fontStack(id, fallback);
    },
    loadFont(id: string | null | undefined): Promise<void> {
      return ensureFont(id, (file) => this.assetUrl(file), this.settings.customFonts);
    },
    /** Calcule et pose toutes les variables CSS et attributs de la racine. */
    apply() {
      const s = this.settings;
      const theme = this.effectiveTheme;
      // Thème d'origine en sombre : la feuille de style s'applique telle quelle.
      const original = theme.id === DEFAULT_THEME_ID && theme === this.theme && !this.light;
      const vars: Record<string, string> = original ? {} : themeVariables(theme);
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
      const applied: Applied = {
        vars,
        light: this.light,
        attrs: {
          btnShape: s.buttons.shape,
          btnStyle: s.buttons.style,
          fieldShape: s.fields.shape,
          fieldStyle: s.fields.style,
          icons: s.icons,
        },
      };
      setVariables(applied);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(applied));
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
    setMode(mode: SchemeMode) {
      this.settings.mode = mode;
      this.changed();
    },
    /** Bouton soleil / lune : bascule immédiate entre clair et sombre. */
    toggleScheme() {
      this.setMode(this.light ? "dark" : "light");
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
    /** Enregistre une image (photo de profil, icône) et renvoie son nom ; l'ancienne est
     *  supprimée. */
    async replaceImage(blob: Blob, previous: string | null): Promise<string> {
      const name = await api.importAsset("image", blob.type === "image/png" ? "png" : "jpg", new Uint8Array(await blob.arrayBuffer()));
      if (previous && previous !== name) void api.deleteAsset(previous).catch(() => {});
      return name;
    },
    async setAvatar(blob: Blob | null) {
      const previous = this.settings.profile.avatar;
      if (!blob) {
        this.settings.profile.avatar = null;
        if (previous) void api.deleteAsset(previous).catch(() => {});
      } else {
        this.settings.profile.avatar = await this.replaceImage(blob, previous);
      }
      this.changed();
    },
    /** Icône de la fenêtre (ordinateur) : barre des tâches, Alt+Tab, titre de la fenêtre. */
    async applyWindowIcon() {
      if (ON_ANDROID || !("__TAURI_INTERNALS__" in window)) return;
      const s = this.settings;
      if (s.appIcon === "origine" && !s.appIconImage) return;
      try {
        const url = s.appIcon === "photo" && s.appIconImage ? this.assetUrl(s.appIconImage) : `/app-icons/${s.appIcon}.png`;
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setIcon(bytes);
      } catch {
        // icône d'origine conservée
      }
    },
    /** Change l'icône de l'application. Android : l'icône de l'écran d'accueil (variantes
     *  dessinées uniquement) ; ordinateur : celle de la fenêtre, photo comprise. */
    async setAppIcon(id: string, photo?: Blob): Promise<boolean> {
      if (photo) {
        this.settings.appIconImage = await this.replaceImage(photo, this.settings.appIconImage);
      }
      if (ON_ANDROID) {
        const ok = window.AndroidLook?.setIcon?.(id) ?? false;
        if (!ok) return false;
      }
      this.settings.appIcon = id;
      this.changed();
      await this.applyWindowIcon();
      return true;
    },
    reset() {
      const keep = this.settings.customThemes;
      const fonts = this.settings.customFonts;
      const profile = this.settings.profile;
      const appIcon = this.settings.appIcon;
      const appIconImage = this.settings.appIconImage;
      this.settings = { ...defaultAppearance(), customThemes: keep, customFonts: fonts, profile, appIcon, appIconImage };
      this.changed();
    },
  },
});
