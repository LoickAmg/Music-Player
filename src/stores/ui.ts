import { defineStore } from "pinia";

export type Route =
  | { name: "recent" }
  | { name: "albums" }
  | { name: "artists"; artist?: string }
  | { name: "songs" }
  | { name: "album"; key: string }
  | { name: "playlist"; id: string }
  | { name: "search"; query: string }
  | { name: "playlists" }
  | { name: "settings" };

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
    /** Écran de téléphone : navigation par onglets en bas, lecteur compact. */
    isMobile: false,
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
      this.nowPlayingOpen = false;
    },
    back() {
      const previous = this.history.pop();
      if (previous) this.route = previous;
    },
    togglePanel(panel: Exclude<SidePanel, null>) {
      this.panel = this.panel === panel ? null : panel;
    },
    setSearch(query: string) {
      this.search = query;
      if (query.trim()) {
        if (this.route.name === "search") this.route = { name: "search", query };
        else this.go({ name: "search", query });
      } else if (this.route.name === "search") {
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
