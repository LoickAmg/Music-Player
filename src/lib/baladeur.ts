// Mode baladeur (téléphone seulement) : logique pure de la molette, des listes et des
// finitions, testée à part (src/lib/baladeur.test.ts). L'affichage est dans Baladeur.vue.

/** Zone de la molette touchée : les quatre boutons de l'anneau, ou le bouton central. */
export type WheelZone = "menu" | "prev" | "next" | "play" | "center";

/**
 * Zone sous le doigt, d'après sa position relative au centre de la molette (en pixels) et le
 * rayon de la molette. `null` hors de la molette.
 */
export function wheelZone(dx: number, dy: number, radius: number): WheelZone | null {
  const distance = Math.hypot(dx, dy);
  if (distance > radius * 1.04) return null;
  if (distance < radius * 0.36) return "center";
  // Angle depuis le haut, dans le sens des aiguilles d'une montre (0 à 360).
  const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const a = (angle + 360) % 360;
  if (a >= 315 || a < 45) return "menu";
  if (a < 135) return "next";
  if (a < 225) return "play";
  return "prev";
}

/** Angle (degrés, 0 en haut, sens horaire) d'un point autour du centre. */
export function pointAngle(dx: number, dy: number): number {
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/** Écart signé le plus court entre deux angles (−180 à 180). */
export function angleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Degrés de rotation par cran de défilement. */
export const STEP_DEGREES = 18;

/**
 * Crans franchis en tournant : l'angle accumulé, les crans entiers à appliquer et le reste.
 * Une rotation rapide (beaucoup de degrés d'un coup) compte double, puis quadruple : une
 * longue liste se parcourt sans tourner des dizaines de fois.
 */
export function wheelSteps(accumulated: number, delta: number, elapsedMs: number): { steps: number; rest: number } {
  const total = accumulated + delta;
  const raw = Math.trunc(total / STEP_DEGREES);
  if (!raw) return { steps: 0, rest: total };
  const speed = Math.abs(delta) / Math.max(1, elapsedMs); // degrés par milliseconde
  const boost = speed > 1.6 ? 4 : speed > 0.8 ? 2 : 1;
  return { steps: raw * boost, rest: total - raw * STEP_DEGREES };
}

/** Sélection déplacée de `steps`, bornée à la liste (pas de retour au début : comme un vrai). */
export function moveSelection(selected: number, steps: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, selected + steps));
}

/** Première ligne visible pour que la sélection reste à l'écran (`rows` lignes affichées). */
export function windowTop(top: number, selected: number, rows: number, count: number): number {
  if (count <= rows) return 0;
  if (selected < top) return selected;
  if (selected >= top + rows) return selected - rows + 1;
  return Math.min(top, count - rows);
}

/** Initiale affichée en grand pendant un défilement rapide (« # » pour chiffres et signes). */
export function initialOf(label: string): string {
  const first = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .charAt(0)
    .toUpperCase();
  return /[A-Z]/.test(first) ? first : "#";
}

/** Durée « 3:07 » (ou « -1:12 » pour un temps restant). */
export function clock(secs: number): string {
  const negative = secs < 0;
  const s = Math.max(0, Math.round(Math.abs(secs)));
  return `${negative ? "-" : ""}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface Skin {
  id: string;
  name: string;
  /** Écran monochrome (texte d'une seule couleur, pas de pochette en couleur). */
  mono: boolean;
  /** Molette faite de quatre boutons en relief plutôt que d'un anneau lisse. */
  pads: boolean;
}

/** Finitions du boîtier (couleurs dans Baladeur.vue, classe `skin-<id>`). */
export const SKINS: readonly Skin[] = [
  { id: "craie", name: "Craie", mono: false, pads: false },
  { id: "graphite", name: "Graphite", mono: false, pads: false },
  { id: "pistache", name: "Pistache", mono: false, pads: false },
  { id: "lagon", name: "Lagon", mono: false, pads: false },
  { id: "ambre", name: "Ambre", mono: true, pads: true },
];

export function skinById(id: string): Skin {
  return SKINS.find((skin) => skin.id === id) ?? SKINS[0];
}
