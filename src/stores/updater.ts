import { defineStore } from "pinia";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import type { UpdateInfo } from "@/lib/types";

// Mise à jour : vérifiée au démarrage, installée en un clic. Ordinateur : par Tauri
// (installateur signé, redémarrage). Android : le service de téléchargement d'Android
// récupère l'APK (connexion lente, coupure, nouvel essai), puis l'installateur d'Android
// s'ouvre (window.AndroidUpdate). Android vérifie aussi en arrière-plan, appli fermée.
export const useUpdaterStore = defineStore("updater", {
  state: () => ({
    available: null as UpdateInfo | null,
    /** Bandeau fermé (« plus tard ») pour cette session. */
    dismissed: false,
    checking: false,
    installing: false,
    /** Part téléchargée (0 à 1), ou null si la taille est inconnue. */
    progress: null as number | null,
    message: null as string | null,
    /** Le téléchargement a échoué : « Réessayer » ou « Télécharger avec le navigateur ». */
    failed: false,
  }),
  getters: {
    /** Taille lisible de l'APK (« 17 Mo »), si connue. */
    sizeLabel: (state) =>
      state.available?.size ? `${Math.max(1, Math.round(state.available.size / 1_000_000))} Mo` : null,
  },
  actions: {
    async check(manual = false) {
      this.checking = true;
      this.message = null;
      try {
        this.available = await api.checkUpdate();
        if (manual) {
          this.dismissed = false;
          if (!this.available) this.message = "Music Player est à jour.";
        }
      } catch (e) {
        // Vérification silencieuse au démarrage (hors ligne…), message si demandée.
        if (manual) this.message = String(e);
      } finally {
        this.checking = false;
      }
    },
    /** Secours : téléchargement de l'APK par le navigateur. */
    openInBrowser() {
      const url = this.available?.url;
      if (url) window.AndroidUpdate?.openInBrowser(url);
    },
    async install() {
      this.installing = true;
      this.progress = null;
      this.message = null;
      this.failed = false;
      const url = this.available?.url;
      if (url && window.AndroidUpdate) {
        window.__mpUpdate = (stage, value) => {
          if (stage === "progress") {
            this.progress = Number(value) >= 0 ? Number(value) : null;
            this.message = null;
          } else if (stage === "waiting") {
            this.message = String(value);
          } else if (stage === "permission") {
            this.message =
              "Autorise « Installer des applis inconnues » pour Music Player, puis reviens : l'installation reprendra.";
          } else if (stage === "ready") {
            this.installing = false;
            this.message = "Installation lancée : confirme « Mettre à jour » dans la fenêtre d'Android.";
          } else if (stage === "error") {
            this.installing = false;
            this.failed = true;
            this.message = `Téléchargement impossible : ${value}`;
          }
        };
        window.AndroidUpdate.download(url, this.available?.version ?? "");
        return;
      }
      let off: UnlistenFn | null = null;
      try {
        off = await listen<[number, number | null]>("update-progress", (e) => {
          const [received, total] = e.payload;
          this.progress = total ? Math.min(1, received / total) : null;
        });
        // En cas de succès, l'application redémarre sur la nouvelle version.
        await api.installUpdate();
      } catch (e) {
        this.message = String(e);
        this.installing = false;
      } finally {
        off?.();
      }
    },
  },
});
