import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES, contrast, isLight, parseHex, parseThemeFile, themeFile, themeVariables } from "./themes";

describe("thèmes", () => {
  it("dérive toutes les variables, voiles foncés sur thème clair", () => {
    const papier = BUILTIN_THEMES.find((t) => t.id === "papier")!;
    const neon = BUILTIN_THEMES.find((t) => t.id === "neon")!;
    expect(isLight(papier)).toBe(true);
    expect(isLight(neon)).toBe(false);
    const light = themeVariables(papier);
    expect(light["--fg-rgb"]).toBe("36, 33, 28");
    expect(light["--accent"]).toBe("#2f6fdb");
    expect(themeVariables(neon)["--fg-rgb"]).toBe("246, 236, 255");
  });

  it("choisit un texte lisible sur l'accent", () => {
    const cyber = BUILTIN_THEMES.find((t) => t.id === "cyberpunk")!;
    expect(themeVariables(cyber)["--on-accent"]).toBe("#0c0c10");
    expect(themeVariables(BUILTIN_THEMES.find((t) => t.id === "theatre")!)["--on-accent"]).toBe("#0c0c10");
    expect(themeVariables(BUILTIN_THEMES.find((t) => t.id === "papier")!)["--on-accent"]).toBe("#fff");
  });

  it("les thèmes fournis ont un texte lisible", () => {
    for (const t of BUILTIN_THEMES) {
      expect(contrast(parseHex(t.colors.bg)!, parseHex(t.colors.text)!), t.name).toBeGreaterThan(7);
    }
  });

  it("exporte puis réimporte un thème, et rejette un fichier douteux", () => {
    const galaxie = BUILTIN_THEMES.find((t) => t.id === "galaxie")!;
    const back = parseThemeFile(themeFile(galaxie))!;
    expect(back.colors).toEqual(galaxie.colors);
    expect(back.fonts).toEqual(galaxie.fonts);
    expect(back.id).not.toBe(galaxie.id);
    expect(parseThemeFile("pas du json")).toBeNull();
    expect(parseThemeFile(JSON.stringify({ colors: { bg: "red", surface: "#000", text: "#fff", accent: "#fff" } }))).toBeNull();
    const hostile = parseThemeFile(JSON.stringify({ name: "x", colors: { bg: "#000", surface: "#111", text: "#fff", accent: "#0f0" }, radius: 999, fonts: { ui: "url(evil)" } }))!;
    expect(hostile.radius).toBe(20);
    expect(hostile.fonts).toBeUndefined();
  });
});
