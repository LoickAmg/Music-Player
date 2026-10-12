// Chargement des polices choisies : celles du catalogue (paquets livrés avec l'application)
// et celles importées par l'utilisateur (fichier copié dans le dossier de l'application,
// chargé avec l'API FontFace). Une police n'est chargée qu'une fois, à la demande.

import { FONTS, type FontChoice } from "./fontCatalog";

export const SYSTEM_FONT = "system";

/** Police importée par l'utilisateur. `id` vaut « custom:<fichier> ». */
export interface CustomFont {
  id: string;
  label: string;
  file: string;
}

const byId = new Map(FONTS.map((f) => [f.id, f]));
const loading = new Map<string, Promise<void>>();

export function catalogFont(id: string): FontChoice | undefined {
  return byId.get(id);
}

/** Nom de famille CSS d'une police importée (unique, sans caractère spécial). */
function customFamily(id: string): string {
  return `MP Custom ${id.slice(7).replace(/[^a-z0-9]/gi, "")}`;
}

/** Valeur `font-family` complète : la police choisie, puis celles du système. */
export function fontStack(id: string | null | undefined, fallback: "ui" | "display"): string {
  const system = fallback === "ui" ? "var(--font-system)" : "var(--font-system-display)";
  if (!id || id === SYSTEM_FONT) return system;
  if (id.startsWith("custom:")) return `"${customFamily(id)}", ${system}`;
  const font = byId.get(id);
  if (!font) return system;
  const generic = font.generic === "sans-serif" ? system : `${system}, ${font.generic}`;
  return `"${font.label}", ${generic}`;
}

/** Charge une police (sans effet si déjà fait). Les erreurs sont silencieuses : la police du
 *  système prend le relais. */
export function ensureFont(id: string | null | undefined, customUrl?: (file: string) => string, custom?: CustomFont[]): Promise<void> {
  if (!id || id === SYSTEM_FONT) return Promise.resolve();
  const known = loading.get(id);
  if (known) return known;
  let task: Promise<void>;
  if (id.startsWith("custom:")) {
    const entry = custom?.find((f) => f.id === id);
    if (!entry || !customUrl || typeof FontFace === "undefined") return Promise.resolve();
    const face = new FontFace(customFamily(id), `url("${customUrl(entry.file)}")`);
    task = face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
      })
      .catch(() => {
        loading.delete(id);
      });
  } else {
    const font = byId.get(id);
    if (!font) return Promise.resolve();
    task = font
      .load()
      .then(() => undefined)
      .catch(() => {
        loading.delete(id);
      });
  }
  loading.set(id, task);
  return task;
}

/** Police importée lue directement depuis le fichier choisi (aperçu avant enregistrement,
 *  et vérification que le fichier est bien une police). */
export async function probeFontFile(file: File): Promise<boolean> {
  if (typeof FontFace === "undefined") return true;
  try {
    const face = new FontFace("MP Probe", await file.arrayBuffer());
    await face.load();
    return true;
  } catch {
    return false;
  }
}
