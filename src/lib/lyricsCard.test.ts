import { describe, expect, it } from "vitest";
import { CARD_FORMATS, luminance, wrap } from "./lyricsCard";

describe("carte de paroles", () => {
  const measure = (t: string) => t.length * 10;

  it("coupe entre les mots, sans dépasser", () => {
    const rows = wrap(measure, "un deux trois quatre cinq", 110);
    expect(rows).toEqual(["un deux", "trois", "quatre cinq"]);
    expect(rows.every((r) => measure(r) <= 110)).toBe(true);
  });

  it("garde un mot trop long sur sa propre ligne", () => {
    expect(wrap(measure, "court supercalifragilistique fin", 80)).toEqual(["court", "supercalifragilistique", "fin"]);
  });

  it("ignore les espaces en trop", () => {
    expect(wrap(measure, "  a   b ", 100)).toEqual(["a b"]);
    expect(wrap(measure, "   ", 100)).toEqual([]);
  });

  it("choisit un texte sombre sur une couleur claire, clair sur une couleur sombre", () => {
    expect(luminance([240, 230, 120])).toBeGreaterThan(0.6);
    expect(luminance([30, 20, 60])).toBeLessThan(0.2);
  });

  it("propose les formats des réseaux (carré, portrait 4:5, story 9:16)", () => {
    expect(CARD_FORMATS.map((f) => [f.id, f.height])).toEqual([["carre", 1080], ["portrait", 1350], ["story", 1920]]);
  });
});
