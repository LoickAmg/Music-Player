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
/** Paroles sans minutage : recherche d'une version synchronisée tout de suite, puis (si LRCLIB
 *  était surchargé) deux nouvelles passes pendant l'écoute. */
const UPGRADE_DELAYS = [20000, 90000];

/** Synchronisation automatique par reconnaissance vocale : à activer (téléchargement du modèle). */
const ALIGN_KEY = "mp:lyrics-align";

function readOnlinePref(): boolean {
  try {
    return localStorage.getItem(ONLINE_KEY) !== "0";
  } catch {
    return true;
  }
}

function readAlignPref(): boolean {
  try {
    return localStorage.getItem(ALIGN_KEY) === "1";
  } catch {
    return false;
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
let upgradeTimer: ReturnType<typeof setTimeout> | undefined;

/** Paroles affichées sans minutage (texte seul) : à améliorer. */
export function needsTiming(lyrics: Lyrics | null): boolean {
  return !!lyrics && !lyrics.synced && !lyrics.instrumental && !!lyrics.plain?.trim();
}

/** Morceau dont la synchronisation attend la fin (ou l'arrêt) du calcul en cours. */
let pendingAlign: string | null = null;

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
    /** Amélioration en cours en arrière-plan : recherche d'une version synchronisée. */
    upgrading: false,
    /** Synchronisation automatique par reconnaissance vocale activée. */
    alignEnabled: readAlignPref(),
    /** Modèle de reconnaissance : installé ? taille du téléchargement (null : pas encore lu). */
    model: null as { installed: boolean; bytes: number } | null,
    /** Téléchargement du modèle en cours (0 à 1), ou null. */
    installing: null as number | null,
    installError: null as string | null,
    /** Synchronisation automatique en cours : morceau et avancement (0 à 1). */
    /** Synchronisation en cours : morceau, avancement (0 à 1), début (ms, Date.now). */
    aligning: null as { trackId: string; fraction: number; startedAt: number } | null,
    /** Échec de la synchronisation automatique pour le morceau affiché. */
    alignError: null as string | null,
  }),
  actions: {
    async refreshModel() {
      try {
        this.model = await api.alignmentModelStatus();
      } catch {
        this.model = null;
      }
    },
    /** Active la synchronisation automatique : télécharge le modèle s'il le faut, puis
     *  synchronise les paroles affichées. */
    async enableAlign() {
      this.alignEnabled = true;
      try {
        localStorage.setItem(ALIGN_KEY, "1");
      } catch {
        // choix valable pour la session
      }
      await this.refreshModel();
      if (!this.model?.installed && !(await this.installModel())) return;
      if (this.trackId && needsTiming(this.lyrics)) void this.align(this.trackId);
    },
    disableAlign() {
      this.alignEnabled = false;
      try {
        localStorage.setItem(ALIGN_KEY, "0");
      } catch {
        // choix valable pour la session
      }
    },
    async installModel(): Promise<boolean> {
      if (this.installing !== null) return false;
      this.installing = 0;
      this.installError = null;
      try {
        await api.installAlignmentModel();
        await this.refreshModel();
        return !!this.model?.installed;
      } catch (e) {
        this.installError = String(e);
        return false;
      } finally {
        this.installing = null;
      }
    },
    async removeModel() {
      await api.removeAlignmentModel();
      await this.refreshModel();
    },
    onModelProgress(done: number, total: number) {
      if (this.installing !== null && total > 0) this.installing = done / total;
    },
    onAlignProgress(trackId: string, fraction: number) {
      this.aligning = { trackId, fraction, startedAt: this.aligning?.startedAt ?? Date.now() };
    },
    /** Synchronisation automatique des paroles affichées sans minutage (calcul local). */
    async align(trackId: string) {
      if (this.aligning) {
        // Calcul en cours pour un autre morceau : arrêté, celui-ci passe juste après (avant,
        // la demande était ignorée et la synchronisation du morceau affiché ne partait jamais).
        if (this.aligning.trackId !== trackId) {
          pendingAlign = trackId;
          void api.cancelAlign().catch(() => {});
        }
        return;
      }
      this.aligning = { trackId, fraction: 0, startedAt: Date.now() };
      this.alignError = null;
      try {
        const synced = await api.alignLyrics(trackId);
        if (synced && this.trackId === trackId) this.lyrics = synced;
      } catch (e) {
        if (this.trackId === trackId) this.alignError = String(e);
      } finally {
        this.aligning = null;
        const next = pendingAlign;
        pendingAlign = null;
        if (next && next === this.trackId && needsTiming(this.lyrics)) void this.align(next);
      }
    },
    /** Dernier recours pour des paroles sans minutage : la synchronisation automatique, si
     *  elle est activée et que le modèle est là. */
    async alignIfWanted(trackId: string) {
      if (!this.alignEnabled || this.trackId !== trackId || !needsTiming(this.lyrics)) return;
      if (!this.model) await this.refreshModel();
      if (this.model?.installed) void this.align(trackId);
    },
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
      clearTimeout(upgradeTimer);
      this.trackId = trackId;
      this.lyrics = null;
      this.error = null;
      this.upgrading = false;
      this.alignError = null;
      if (!trackId) return;
      this.loading = true;
      try {
        const lyrics = await api.getLyrics(trackId, this.allowOnline, refresh);
        if (this.trackId === trackId) {
          this.lyrics = lyrics;
          if (needsTiming(lyrics)) void this.upgrade(trackId, 0);
        }
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
    /** Passe automatique : version synchronisée cherchée en arrière-plan, sans action de
     *  l'utilisateur ; le texte reste affiché pendant ce temps. `pass` : 0 à la première écoute,
     *  puis nouvelles passes si LRCLIB était surchargé. */
    async upgrade(trackId: string, pass: number) {
      if (this.trackId !== trackId) return;
      if (!this.allowOnline) {
        void this.alignIfWanted(trackId);
        return;
      }
      this.upgrading = true;
      let more = false;
      try {
        const result = await api.upgradeLyrics(trackId, pass > 0);
        if (this.trackId !== trackId) return;
        if (result.lyrics) {
          this.lyrics = result.lyrics;
          return;
        }
        const delay = result.retry ? UPGRADE_DELAYS[pass] : undefined;
        if (delay !== undefined) {
          more = true;
          upgradeTimer = setTimeout(() => void this.upgrade(trackId, pass + 1), delay);
        }
      } catch {
        // réseau coupé : le texte reste affiché, une prochaine écoute réessaiera
      } finally {
        if (this.trackId === trackId) this.upgrading = false;
      }
      // Aucune version synchronisée en ligne (et plus de passe prévue) : synchronisation
      // automatique sur l'audio, si elle est activée.
      if (!more) void this.alignIfWanted(trackId);
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
