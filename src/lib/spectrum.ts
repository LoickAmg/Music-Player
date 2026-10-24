// Spectre du son joué, partagé par tous les visualiseurs affichés : une seule demande au
// moteur audio par image (30 par seconde au plus), lissée (montée franche, retombée douce).

import { onBeforeUnmount } from "vue";
import { api } from "./api";

export const BANDS = 32;
/** Niveaux lissés de 0 à 1, mis à jour en place. */
export const levels = new Float32Array(BANDS);
let users = 0;
let frame = 0;
let last = 0;
let pending = false;

function loop(t: number) {
  frame = requestAnimationFrame(loop);
  if (pending || t - last < 33) return;
  last = t;
  pending = true;
  api
    .getSpectrum()
    .then((bands) => {
      for (let i = 0; i < BANDS; i++) {
        const target = bands.length ? (bands[i] ?? 0) / 255 : 0;
        levels[i] = target > levels[i] ? levels[i] + (target - levels[i]) * 0.6 : levels[i] * 0.86;
      }
    })
    .catch(() => {
      for (let i = 0; i < BANDS; i++) levels[i] *= 0.86;
    })
    .finally(() => (pending = false));
}

/** Abonne le composant au spectre (relevé seulement tant qu'un visualiseur est affiché). */
export function useSpectrum(): Float32Array {
  users += 1;
  if (users === 1) frame = requestAnimationFrame(loop);
  onBeforeUnmount(() => {
    users -= 1;
    if (users === 0) {
      cancelAnimationFrame(frame);
      levels.fill(0);
    }
  });
  return levels;
}

/** Énergie globale (0 à 1), surtout les basses : fait « battre » les visuels. */
export function energy(): number {
  let bass = 0;
  for (let i = 0; i < 8; i++) bass += levels[i];
  let all = 0;
  for (let i = 0; i < BANDS; i++) all += levels[i];
  return Math.min(1, (bass / 8) * 0.65 + (all / BANDS) * 0.35);
}
