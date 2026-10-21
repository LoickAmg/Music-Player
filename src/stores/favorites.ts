import { defineStore } from "pinia";
import { api } from "@/lib/api";

export const useFavoritesStore = defineStore("favorites", {
  state: () => ({
    ids: new Set<string>() as Set<string>,
  }),
  getters: {
    isFavorite: (state) => (trackId: string) => state.ids.has(trackId),
    count: (state) => state.ids.size,
  },
  actions: {
    setFromInitialState(trackIds: string[]) {
      this.ids = new Set(trackIds);
    },
    async toggle(trackId: string): Promise<boolean> {
      const now = await api.toggleFavorite(trackId);
      const next = new Set(this.ids);
      if (now) next.add(trackId);
      else next.delete(trackId);
      this.ids = next;
      return now;
    },
  },
});
