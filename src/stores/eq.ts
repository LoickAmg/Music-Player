import { defineStore } from "pinia";
import { api } from "@/lib/api";

export const BAND_LABELS = ["Basses", "Médiums", "Aigus"] as const;

type Gains = [number, number, number];

export const EQ_PRESETS: { name: string; gains: Gains }[] = [
  { name: "Neutre", gains: [0, 0, 0] },
  { name: "Basses +", gains: [6, 0, -1] },
  { name: "Voix", gains: [-2, 4, 1] },
  { name: "Aigus +", gains: [-1, 0, 5] },
  { name: "Loudness", gains: [5, -1, 4] },
  { name: "Acoustique", gains: [2, 2, 3] },
];

export const useEqStore = defineStore("eq", {
  state: () => ({
    gains: [0, 0, 0] as Gains,
  }),
  getters: {
    activePreset: (state) =>
      EQ_PRESETS.find((p) => p.gains.every((g, i) => g === state.gains[i]))?.name ?? null,
  },
  actions: {
    setFromInitialState(gains: Gains) {
      this.gains = gains;
    },
    async setGain(index: 0 | 1 | 2, value: number) {
      const next: Gains = [...this.gains];
      next[index] = value;
      this.gains = next;
      await api.setEqGains(next);
    },
    async applyPreset(gains: Gains) {
      this.gains = [...gains];
      await api.setEqGains(this.gains);
    },
    async reset() {
      await this.applyPreset([0, 0, 0]);
    },
  },
});
