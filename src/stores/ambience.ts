import { defineStore } from "pinia";
import { coverUrl } from "@/lib/covers";
import { css, paletteFromImage, paletteFromText, type Palette } from "@/lib/palette";
import type { Track } from "@/lib/types";

// Ambiance du morceau en cours : couleurs extraites de sa pochette, exposées en variables
// CSS sur la racine (--amb-*) pour que fonds, halos et paroles suivent la musique. Les
// variables sont déclarées avec @property (style.css), le changement de morceau se fait
// donc en fondu.
export const useAmbienceStore = defineStore("ambience", {
  state: () => ({
    palette: null as Palette | null,
    trackId: null as string | null,
  }),
  actions: {
    async follow(track: Track | null) {
      const id = track?.id ?? null;
      if (id === this.trackId) return;
      this.trackId = id;
      if (!track) {
        this.apply(null);
        return;
      }
      const url = await coverUrl(track);
      const fromCover = url ? await paletteFromImage(url) : null;
      if (this.trackId !== id) return; // un autre morceau a été lancé entre-temps
      this.apply(fromCover ?? paletteFromText(track.album || track.title));
    },
    apply(palette: Palette | null) {
      this.palette = palette;
      const root = document.documentElement.style;
      if (!palette) {
        for (const k of ["primary", "secondary", "glow", "base", "energy"]) root.removeProperty(`--amb-${k}`);
        return;
      }
      root.setProperty("--amb-primary", css(palette.primary));
      root.setProperty("--amb-secondary", css(palette.secondary));
      root.setProperty("--amb-glow", css(palette.glow));
      root.setProperty("--amb-base", css(palette.base));
      root.setProperty("--amb-energy", palette.energy.toFixed(2));
    },
  },
});
