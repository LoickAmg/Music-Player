import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { Listen } from "@/lib/recap";

/** Journal d'écoute, relu à chaque ouverture de « Mon écoute » ou de la rétrospective. */
export const useListeningStore = defineStore("listening", {
  state: () => ({
    listens: [] as Listen[],
    loaded: false,
    loading: false,
  }),
  getters: {
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
