import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { LyricLine, Lyrics } from "@/lib/types";

// Recherche en ligne activée d'office (l'utilisateur n'a rien à faire) ; désactivable
// dans les Réglages. Nouvelle clé : l'ancien choix « Non merci » ne s'applique plus.
const ONLINE_KEY = "mp:lyrics-online-auto";
// Décalage des paroles synchronisées, réglé à la main morceau par morceau (en ms ; positif :
// les paroles s'affichent plus tôt).
const OFFSET_KEY = "mp:lyrics-offset:";
/** Service de paroles surchargé : nouvelles tentatives automatiques, de plus en plus espacées. */
const RETRY_DELAYS = [6000, 20000, 60000];

function readOnlinePref(): boolean {
  try {
    return localStorage.getItem(ONLINE_KEY) !== "0";
  } catch {
    return true;
  }
}

function readOffset(trackId: string | null): number {
  if (!trackId) return 0;
  try {
    return Number(localStorage.getItem(OFFSET_KEY + trackId)) || 0;
  } catch {
    return 0;
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

let retryTimer: ReturnType<typeof setTimeout> | undefined;

export const useLyricsStore = defineStore("lyrics", {
  state: () => ({
    trackId: null as string | null,
    lyrics: null as Lyrics | null,
    loading: false,
    error: null as string | null,
    /** Nombre de nouvelles tentatives automatiques déjà faites pour ce morceau. */
    retries: 0,
    offsetMs: 0,
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
    /** Nouvelle recherche en ligne, sans tenir compte du cache ni d'un choix précédent. */
    retry() {
      if (this.trackId) void this.load(this.trackId, true, true);
    },
    async load(trackId: string | null, force = false, refresh = false) {
      if (!force && trackId === this.trackId) return;
      if (trackId !== this.trackId) {
        this.retries = 0;
        this.offsetMs = readOffset(trackId);
      }
      clearTimeout(retryTimer);
      this.trackId = trackId;
      this.lyrics = null;
      this.error = null;
      if (!trackId) return;
      this.loading = true;
      try {
        const lyrics = await api.getLyrics(trackId, this.allowOnline, refresh);
        if (this.trackId === trackId) this.lyrics = lyrics;
      } catch (e) {
        if (this.trackId === trackId) {
          this.error = String(e);
          // Service momentanément surchargé ou réseau coupé : on réessaie tout seul.
          const delay = RETRY_DELAYS[this.retries];
          if (delay !== undefined) {
            retryTimer = setTimeout(() => {
              if (this.trackId !== trackId || this.lyrics) return;
              this.retries += 1;
              void this.load(trackId, true, refresh);
            }, delay);
          }
        }
      } finally {
        if (this.trackId === trackId) this.loading = false;
      }
    },
    /** Paroles choisies dans la recherche manuelle (retenues pour ce morceau). */
    async choose(lyricsId: number) {
      const trackId = this.trackId;
      if (!trackId) return;
      const lyrics = await api.chooseLyrics(trackId, lyricsId);
      if (this.trackId === trackId) {
        clearTimeout(retryTimer);
        this.lyrics = lyrics;
        this.error = null;
        this.setOffset(0);
      }
    },
    /** « Ces paroles ne correspondent pas » : plus rien d'affiché pour ce morceau. */
    async dismiss() {
      const trackId = this.trackId;
      if (!trackId) return;
      await api.dismissLyrics(trackId);
      if (this.trackId === trackId) {
        this.lyrics = null;
        this.error = null;
        this.setOffset(0);
      }
    },
    setOffset(ms: number) {
      this.offsetMs = Math.max(-30000, Math.min(30000, Math.round(ms)));
      if (!this.trackId) return;
      try {
        if (this.offsetMs) localStorage.setItem(OFFSET_KEY + this.trackId, String(this.offsetMs));
        else localStorage.removeItem(OFFSET_KEY + this.trackId);
      } catch {
        // réglage valable pour la session
      }
    },
    /** Prépare en arrière-plan les paroles d'un morceau à venir (mises en cache côté Rust). */
    prefetch(trackId: string | null | undefined) {
      if (trackId && this.allowOnline) void api.getLyrics(trackId, true).catch(() => {});
    },
  },
});
