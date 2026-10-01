import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { LyricLine, Lyrics } from "@/lib/types";

// Recherche en ligne activée d'office (l'utilisateur n'a rien à faire) ; désactivable
// dans les Réglages. Nouvelle clé : l'ancien choix « Non merci » ne s'applique plus.
const ONLINE_KEY = "mp:lyrics-online-auto";

function readOnlinePref(): boolean {
  try {
    return localStorage.getItem(ONLINE_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Indice de la ligne en cours (la dernière dont l'horodatage est passé), ou -1. */
export function activeLineIndex(lines: LyricLine[], positionMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time_ms <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export const useLyricsStore = defineStore("lyrics", {
  state: () => ({
    trackId: null as string | null,
    lyrics: null as Lyrics | null,
    loading: false,
    error: null as string | null,
    allowOnline: readOnlinePref(),
  }),
  actions: {
    setAllowOnline(on: boolean) {
      this.allowOnline = on;
      try {
        localStorage.setItem(ONLINE_KEY, on ? "1" : "0");
      } catch {
        // stockage indisponible : le choix vaut pour la session
      }
      if (this.trackId) void this.load(this.trackId, true);
    },
    /** Nouvelle recherche en ligne, sans tenir compte du cache. */
    retry() {
      if (this.trackId) void this.load(this.trackId, true, true);
    },
    async load(trackId: string | null, force = false, refresh = false) {
      if (!force && trackId === this.trackId) return;
      this.trackId = trackId;
      this.lyrics = null;
      this.error = null;
      if (!trackId) return;
      this.loading = true;
      try {
        const lyrics = await api.getLyrics(trackId, this.allowOnline, refresh);
        if (this.trackId === trackId) this.lyrics = lyrics;
      } catch (e) {
        if (this.trackId === trackId) this.error = String(e);
      } finally {
        if (this.trackId === trackId) this.loading = false;
      }
    },
    /** Prépare en arrière-plan les paroles d'un morceau à venir (mises en cache côté Rust). */
    prefetch(trackId: string | null | undefined) {
      if (trackId && this.allowOnline) void api.getLyrics(trackId, true).catch(() => {});
    },
  },
});
