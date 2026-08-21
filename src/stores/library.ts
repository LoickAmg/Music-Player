import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { Track } from "@/lib/types";

export const useLibraryStore = defineStore("library", {
  state: () => ({
    root: null as string | null,
    tracks: [] as Track[],
    loading: false,
    error: null as string | null,
  }),
  getters: {
    // Retourne une fonction de filtrage plutôt qu'un tableau : évite de
    // recalculer un getter par lettre tapée dans le champ de recherche,
    // le composant appelle juste `filtered(query)` dans un computed local.
    filtered:
      (state) =>
      (query: string): Track[] => {
        const q = query.trim().toLowerCase();
        if (!q) return state.tracks;
        return state.tracks.filter((t) =>
          [t.title, t.artist, t.album].some((field) => field.toLowerCase().includes(q)),
        );
      },
    byId: (state) => (id: string) => state.tracks.find((t) => t.id === id) ?? null,
  },
  actions: {
    setFromInitialState(root: string | null, tracks: Track[]) {
      this.root = root;
      this.tracks = tracks;
    },
    async chooseFolderAndScan() {
      const folder = await api.pickLibraryFolder();
      if (!folder) return;
      await this.scan(folder);
    },
    async scan(root: string) {
      this.loading = true;
      this.error = null;
      try {
        this.tracks = await api.scanLibrary(root);
        this.root = root;
      } catch (e) {
        this.error = String(e);
      } finally {
        this.loading = false;
      }
    },
  },
});
