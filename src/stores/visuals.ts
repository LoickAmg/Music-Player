import { defineStore } from "pinia";

// Visuels de « À l'écoute » (par appareil) : présentation de la pochette, motif du disque,
// visualiseur.

export type ArtStyle = "auto" | "cover" | "vinyl" | "cd";
export type DiscDesign = "pochette" | "argent" | "noir" | "couleur";
export const DISC_DESIGNS: { id: DiscDesign; label: string }[] = [
  { id: "pochette", label: "Pochette imprimée" },
  { id: "argent", label: "Argent" },
  { id: "noir", label: "Noir mat" },
  { id: "couleur", label: "Couleurs de la pochette" },
];

const KEY = "mp:visuels";

interface Saved {
  artStyle: ArtStyle;
  discDesign: DiscDesign;
  visualizer: boolean;
}

function load(): Saved {
  const base: Saved = { artStyle: "auto", discDesign: "pochette", visualizer: true };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<Saved>) } : base;
  } catch {
    return base;
  }
}

export const useVisualsStore = defineStore("visuals", {
  state: () => ({ ...load(), cdOpen: false }),
  actions: {
    save() {
      try {
        const { artStyle, discDesign, visualizer } = this;
        localStorage.setItem(KEY, JSON.stringify({ artStyle, discDesign, visualizer }));
      } catch {
        // réglage valable pour la session
      }
    },
    /** Style réellement affiché : « auto » = vinyle sur téléphone, CD sur grand écran. */
    resolved(narrow: boolean): Exclude<ArtStyle, "auto"> {
      if (this.artStyle !== "auto") return this.artStyle;
      return narrow ? "vinyl" : "cd";
    },
    setArtStyle(style: ArtStyle) {
      this.artStyle = style;
      this.save();
    },
    setDiscDesign(design: DiscDesign) {
      this.discDesign = design;
      this.save();
    },
    setVisualizer(on: boolean) {
      this.visualizer = on;
      this.save();
    },
  },
});
