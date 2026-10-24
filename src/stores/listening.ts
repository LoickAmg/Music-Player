import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { Listen } from "@/lib/recap";
import { useLibraryStore } from "./library";

/** Journal d'écoute, relu à chaque ouverture de « Mon écoute » ou de la rétrospective. */
export const useListeningStore = defineStore("listening", {
  state: () => ({
    listens: [] as Listen[],
    loaded: false,
    loading: false,
  }),
  getters: {
    /** Écoutes de musique seulement : les vocaux et enregistrements n'entrent pas dans les bilans. */
    music: (state): Listen[] => {
      const voices = new Set(useLibraryStore().voices.map((t) => t.id));
      return voices.size ? state.listens.filter((l) => !voices.has(l.track_id)) : state.listens;
    },
    /** Première écoute enregistrée (null tant que rien n'a été écouté). */
    since: (state): Date | null => (state.listens.length ? new Date(state.listens[0].started * 1000) : null),
  },
  actions: {
    async load() {
      if (this.loading) return;
      this.loading = true;
      try {
        this.listens = await api.getListens();
        this.loaded = true;
      } catch {
        // journal illisible : rétrospective vide plutôt qu'une erreur
        this.loaded = true;
      } finally {
        this.loading = false;
      }
    },
  },
});
