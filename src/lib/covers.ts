// Pochettes : le Rust les extrait dans un dossier cache et renvoie un chemin de fichier,
// servi par le protocole « asset » de Tauri (le navigateur gère décodage et cache). Les
// demandes sont mises en commun par piste et limitées en parallèle pour rester fluide
// quand une grille de centaines d'albums défile.

import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./api";
import type { Track } from "./types";

const cache = new Map<string, Promise<string | null>>();
const MAX_PARALLEL = 6;
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function coverUrl(track: Track | null): Promise<string | null> {
  if (!track || !track.has_cover) return Promise.resolve(null);
  let pending = cache.get(track.id);
  if (!pending) {
    pending = slot(async () => {
      try {
        const file = await api.getCover(track.path, track.id);
        return file ? convertFileSrc(file) : null;
      } catch {
        return null;
      }
    });
    cache.set(track.id, pending);
  }
  return pending;
}
