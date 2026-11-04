// Taille de l'icône du profil, en haut de l'écran (réglée sur la page « Mon profil »).

export const ICON_SIZES = [
  { id: "petite", label: "Petite", px: 30 },
  { id: "normale", label: "Normale", px: 36 },
  { id: "grande", label: "Grande", px: 44 },
] as const;

export type IconSize = (typeof ICON_SIZES)[number]["id"];

export const ICON_SIZE_KEY = "mp:taille-profil";

export function applyIconSize(id: string | null) {
  const size = ICON_SIZES.find((s) => s.id === id);
  if (size) document.documentElement.style.setProperty("--me-size", `${size.px}px`);
}

/** Taille choisie, appliquée au lancement. */
export function restoreIconSize() {
  try {
    applyIconSize(localStorage.getItem(ICON_SIZE_KEY));
  } catch {
    // stockage indisponible : taille normale
  }
}
