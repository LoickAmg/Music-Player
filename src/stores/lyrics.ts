import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { LyricLine, Lyrics } from "@/lib/types";

const ONLINE_KEY = "mp:lyrics-online";

function readOnlinePref(): boolean | null {
  try {
    const v = localStorage.getItem(ONLINE_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
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
    /** null = l'utilisateur n'a pas encore choisi (on lui pose la question une fois). */
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
    async load(trackId: string | null, force = false) {
      if (!force && trackId === this.trackId) return;
      this.trackId = trackId;
      this.lyrics = null;
      this.error = null;
      if (!trackId) return;
      this.loading = true;
      try {
        const lyrics = await api.getLyrics(trackId, this.allowOnline === true);
        if (this.trackId === trackId) this.lyrics = lyrics;
      } catch (e) {
        if (this.trackId === trackId) this.error = String(e);
      } finally {
        if (this.trackId === trackId) this.loading = false;
      }
    },
  },
});
