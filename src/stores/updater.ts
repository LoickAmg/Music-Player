import { defineStore } from "pinia";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import type { UpdateInfo } from "@/lib/types";

// Mise à jour : vérifiée au démarrage, installée en un clic. Ordinateur : par Tauri
// (installateur signé, redémarrage). Android : l'activité télécharge l'APK puis ouvre
// l'installateur d'Android (window.AndroidUpdate).
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
  }),
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
    async install() {
      this.installing = true;
      this.progress = null;
      this.message = null;
      const url = this.available?.url;
      if (url && window.AndroidUpdate) {
        window.__mpUpdate = (stage, value) => {
          if (stage === "progress") {
            this.progress = Number(value) >= 0 ? Number(value) : null;
          } else if (stage === "permission") {
            this.message =
              "Autorise « Installer des applis inconnues » pour Music Player, puis reviens : l'installation reprendra.";
          } else if (stage === "ready") {
            this.installing = false;
            this.message = "Installation lancée : confirme « Mettre à jour » dans la fenêtre d'Android.";
          } else if (stage === "error") {
            this.installing = false;
            this.message = `Téléchargement impossible : ${value}`;
          }
        };
        window.AndroidUpdate.install(url);
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
