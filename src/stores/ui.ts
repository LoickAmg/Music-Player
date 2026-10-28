import { defineStore } from "pinia";

export type Route =
  | { name: "recent" }
  | { name: "albums" }
  | { name: "artists"; artist?: string }
  | { name: "songs" }
  | { name: "favorites" }
  | { name: "voices" }
  | { name: "duplicates" }
  | { name: "friends" }
  | { name: "spotify" }
  | { name: "avis" }
  | { name: "album"; key: string }
  | { name: "playlist"; id: string }
  | { name: "search"; query: string }
  | { name: "playlists" }
  | { name: "settings" }
  | { name: "appearance" }
  | { name: "stats" };

export type SidePanel = "lyrics" | "queue" | null;

export interface TrackMenu {
  x: number;
  y: number;
  trackId: string;
  /** Renseigné quand le menu est ouvert depuis une playlist (permet « Retirer »). */
  playlistId?: string;
}

/** Fenêtre de création / personnalisation d'une playlist. */
export type PlaylistDialog = { mode: "create"; addTrackId?: string } | { mode: "edit"; id: string };

// Chaque page et l'écran « À l'écoute » ajoutent une entrée à l'historique de la vue web :
// le bouton retour d'Android (et la souris) y reviennent au lieu de quitter l'application.
type Entry = "route" | "np";

function top(): Entry | null {
  return (window.history.state as { mp?: Entry } | null)?.mp ?? null;
}

/**
 * Champ de recherche vidé : on revient à la page d'avant par l'historique, ce qui prend un
 * instant. Si l'on se remet à taper entre-temps, ce retour arrivait après coup et ramenait sur
 * l'ancienne page, la nouvelle recherche restant dans le champ sans résultats (il fallait
 * retaper). `leaving` : retour demandé ; `revived` : la recherche a repris, retour à ignorer.
 */
const searchExit = { leaving: false, revived: false };

function push(kind: Entry, replace = false) {
  try {
    if (replace) window.history.replaceState({ mp: kind }, "");
    else window.history.pushState({ mp: kind }, "");
  } catch {
    // historique indisponible : la navigation interne suffit
  }
}

export const useUiStore = defineStore("ui", {
  state: () => ({
    route: { name: "recent" } as Route,
    history: [] as Route[],
    panel: null as SidePanel,
    nowPlayingOpen: false,
    search: "",
    toast: null as string | null,
    menu: null as TrackMenu | null,
    playlistDialog: null as PlaylistDialog | null,
    /** Fenêtre « Un avis ? » ouverte. */
    feedback: false,
    /** Sauvegarde ouverte avec l'appli, à proposer de restaurer (contenu du fichier). */
    backupToRestore: null as string | null,
    /** Playlist dans laquelle on choisit des morceaux à ajouter (sélecteur plein écran). */
    trackPicker: null as string | null,
    /** Recherche manuelle de paroles ouverte (pour le morceau en cours). */
    lyricsSearch: false,
    /** Écran de téléphone : navigation par onglets en bas, lecteur compact. */
    isMobile: false,
    /** Écran tactile (téléphone, tablette, pliable ouvert) : un appui lance un morceau. */
    isTouch: false,
  }),
  getters: {
    canGoBack: (state) => state.history.length > 0,
  },
  actions: {
    go(route: Route) {
      if (JSON.stringify(route) === JSON.stringify(this.route)) return;
      this.history.push(this.route);
      if (this.history.length > 50) this.history.shift();
      this.route = route;
      // Quitter « À l'écoute » vers une page : l'entrée de l'écran devient celle de la page.
      push("route", this.nowPlayingOpen && top() === "np");
      this.nowPlayingOpen = false;
    },
    back() {
      if (top() === "route") window.history.back();
      else this.popRoute();
    },
    popRoute() {
      const previous = this.history.pop();
      if (previous) this.route = previous;
    },
    openNowPlaying() {
      if (this.nowPlayingOpen) return;
      this.nowPlayingOpen = true;
      push("np");
    },
    closeNowPlaying() {
      if (!this.nowPlayingOpen) return;
      if (top() === "np") window.history.back();
      else this.nowPlayingOpen = false;
    },
    /** Retour arrière (bouton retour d'Android, geste, souris). */
    onPopState() {
      if (searchExit.leaving) {
        searchExit.leaving = false;
        if (searchExit.revived) {
          // On s'est remis à taper avant la fin du retour : on reste sur les résultats, et
          // l'entrée d'historique consommée est remise (le bouton retour garde son effet).
          searchExit.revived = false;
          push("route");
          return;
        }
      }
      if (this.menu || this.playlistDialog || this.trackPicker || this.lyricsSearch) {
        // Un menu ou une fenêtre ouverte se ferme sans changer de page.
        this.menu = null;
        this.playlistDialog = null;
        this.trackPicker = null;
        this.lyricsSearch = false;
        push(this.nowPlayingOpen ? "np" : "route");
        return;
      }
      if (this.nowPlayingOpen) {
        this.nowPlayingOpen = false;
        return;
      }
      this.popRoute();
    },
    togglePanel(panel: Exclude<SidePanel, null>) {
      this.panel = this.panel === panel ? null : panel;
    },
    setSearch(query: string) {
      this.search = query;
      if (query.trim()) {
        if (searchExit.leaving) searchExit.revived = true;
        if (this.route.name === "search") this.route = { name: "search", query };
        else this.go({ name: "search", query });
      } else if (this.route.name === "search") {
        // Retour déjà en route (champ revidé avant qu'il arrive) : on ne le redemande pas.
        if (searchExit.leaving) {
          searchExit.revived = false;
          return;
        }
        if (top() === "route") searchExit.leaving = true;
        this.back();
      }
    },
    notify(message: string) {
      this.toast = message;
      setTimeout(() => {
        if (this.toast === message) this.toast = null;
      }, 3200);
    },
  },
});
