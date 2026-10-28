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

/** Couleur des visuels (visualiseur, vinyle, CD, barre) : celle de la pochette ou du thème. */
export type VisualColors = "pochette" | "theme";
export type VinylColor = "noir" | "teinte";

interface Saved {
  artStyle: ArtStyle;
  discDesign: DiscDesign;
  visualizer: boolean;
  colors: VisualColors;
  vinyl: VinylColor;
}

function load(): Saved {
  const base: Saved = { artStyle: "auto", discDesign: "pochette", visualizer: true, colors: "pochette", vinyl: "noir" };
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
        const { artStyle, discDesign, visualizer, colors, vinyl } = this;
        localStorage.setItem(KEY, JSON.stringify({ artStyle, discDesign, visualizer, colors, vinyl }));
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
    setColors(colors: VisualColors) {
      this.colors = colors;
      this.save();
    },
    setVinyl(vinyl: VinylColor) {
      this.vinyl = vinyl;
      this.save();
    },
    setVisualizer(on: boolean) {
      this.visualizer = on;
      this.save();
    },
  },
});
