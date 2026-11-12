import { defineStore } from "pinia";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import type { UpdateInfo } from "@/lib/types";

// Mise à jour : vérifiée au démarrage. Ordinateur : installée en un clic par Tauri
// (installateur signé, redémarrage). Android : l'APK officiel s'ouvre dans le navigateur, qui
// le télécharge et propose l'installation (window.AndroidUpdate). Android vérifie aussi en
// arrière-plan, appli fermée, et prévient par une notification.
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
        // Android : le navigateur télécharge l'APK officiel et propose l'installation. L'appli
        // n'installe rien elle-même : Play Protect la signalait comme dangereuse à chaque mise
        // à jour quand elle le faisait.
        window.AndroidUpdate.openInBrowser(url);
        this.installing = false;
        this.message =
          "Le téléchargement continue dans le navigateur. À la fin, touche « Ouvrir » (ou la notification de téléchargement) puis « Mettre à jour » : tes musiques et réglages sont conservés.";
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
