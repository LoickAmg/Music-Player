import { defineStore } from "pinia";
import { api } from "@/lib/api";

export const BAND_LABELS = ["Basses", "Médiums", "Aigus"] as const;

export const useEqStore = defineStore("eq", {
  state: () => ({
    gains: [0, 0, 0] as [number, number, number],
  }),
  actions: {
    setFromInitialState(gains: [number, number, number]) {
      this.gains = gains;
    },
    async setGain(index: 0 | 1 | 2, value: number) {
      const next: [number, number, number] = [...this.gains];
      next[index] = value;
      this.gains = next;
      await api.setEqGains(next);
    },
    async reset() {
      this.gains = [0, 0, 0];
      await api.setEqGains(this.gains);
    },
  },
});
