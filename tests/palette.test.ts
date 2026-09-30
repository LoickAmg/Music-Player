import { describe, expect, it } from "vitest";
import { hslToRgb, paletteFromPixels, rgbToHsl, type Rgb } from "@/lib/palette";
import { customTheme, themeFor, titleScale } from "@/lib/playlistThemes";

function pixels(colors: [Rgb, number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [[r, g, b], n] of colors) for (let i = 0; i < n; i++) out.push(r, g, b, 255);
  return new Uint8ClampedArray(out);
}

describe("palette de pochette", () => {
  it("HSL ↔ RGB aller-retour", () => {
    const [h, s, l] = rgbToHsl([200, 60, 90]);
    const back = hslToRgb(h, s, l);
    back.forEach((v, i) => expect(Math.abs(v - [200, 60, 90][i])).toBeLessThanOrEqual(1));
  });

  it("la teinte dominante vient de la couleur la plus présente", () => {
    const p = paletteFromPixels(pixels([[[220, 30, 40], 600], [[30, 60, 200], 150], [[5, 5, 5], 500]]));
    const [h] = rgbToHsl(p.primary);
    expect(h < 20 || h > 340).toBe(true); // rouge
    const [h2] = rgbToHsl(p.secondary);
    expect(h2).toBeGreaterThan(200); // bleu
    expect(h2).toBeLessThan(260);
  });

  it("une pochette en noir et blanc donne une ambiance neutre", () => {
    const p = paletteFromPixels(pixels([[[20, 20, 20], 500], [[230, 230, 230], 500], [[128, 128, 128], 200]]));
    expect(rgbToHsl(p.glow)[1]).toBeLessThan(0.3);
  });

  it("une pochette vive a plus d'énergie qu'une pochette sombre", () => {
    const vive = paletteFromPixels(pixels([[[255, 200, 0], 800]]));
    const sombre = paletteFromPixels(pixels([[[40, 20, 50], 800]]));
    expect(vive.energy).toBeGreaterThan(sombre.energy);
  });
});

describe("thèmes de playlist", () => {
  it("retombe sur le thème par défaut pour un identifiant inconnu", () => {
    expect(themeFor("nope").id).toBe("aurora");
    expect(themeFor(null).id).toBe("aurora");
  });

  it("une couleur personnalisée claire donne un texte foncé", () => {
    expect(customTheme("#fff3a0").ink).not.toBe("#fff");
    expect(customTheme("#202060").ink).toBe("#fff");
    expect(themeFor("custom:#202060").background).toContain("#202060");
  });

  it("les noms longs s'écrivent plus petit", () => {
    expect(titleScale("Chill")).toBeGreaterThan(titleScale("Mes morceaux préférés de l'été 2026"));
    expect(titleScale("Anticonstitutionnellement")).toBeLessThanOrEqual(6);
  });
});
