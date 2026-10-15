import { describe, expect, it } from "vitest";

import { activeItemIndex, buildItems, progress, splitWords, syllables } from "./lyricsTiming";

describe("rythme des paroles", () => {
  it("compte les syllabes approximativement", () => {
    expect(syllables("de")).toBe(1);
    expect(syllables("mélancolie")).toBe(4);
    expect(syllables("yeah")).toBe(1);
    expect(syllables("愛してる")).toBe(4);
    expect(syllables("—")).toBe(0);
  });

  it("garde les espaces avec les mots", () => {
    expect(splitWords("  Il  pleut encore ")).toEqual(["Il  ", "pleut ", "encore"]);
  });

  it("répartit la ligne entre ses mots selon leurs syllabes", () => {
    const items = buildItems([
      { time_ms: 10_000, text: "Je marche lentement" },
      { time_ms: 13_000, text: "Suite" },
    ]);
    // Dix secondes avant le premier vers : une pause d'intro passe devant.
    expect(items[0].kind).toBe("pause");
    const line = items[1];
    expect(line.kind).toBe("line");
    expect(line.words.map((w) => w.text.trim())).toEqual(["Je", "marche", "lentement"]);
    expect(line.words[0].start).toBe(10_000);
    // « lentement » (3 syllabes) dure plus longtemps que « Je » (1).
    const length = (w: { start: number; end: number }) => w.end - w.start;
    expect(length(line.words[2])).toBeGreaterThan(length(line.words[0]) * 2);
    expect(line.words[2].end).toBeLessThanOrEqual(13_000);
  });

  it("utilise le minutage exact des mots quand il existe", () => {
    const [line] = buildItems([
      {
        time_ms: 1000,
        text: "Il pleut",
        words: [
          { time_ms: 1000, text: "Il " },
          { time_ms: 1600, text: "pleut" },
        ],
      },
      { time_ms: 4000, text: "Suite" },
    ]);
    expect(line.words.map((w) => [w.start, w.end])).toEqual([
      [1000, 1600],
      [1600, line.end],
    ]);
  });

  it("signale l'intro et les longs passages sans voix, pas les simples respirations", () => {
    const items = buildItems([
      { time_ms: 12_000, text: "Premier vers" },
      { time_ms: 14_500, text: "Deuxième vers" },
      { time_ms: 40_000, text: "Après le solo" },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["pause", "line", "line", "pause", "line"]);
    expect(items[0]).toMatchObject({ start: 0, end: 12_000 });
    expect(items[3].end).toBe(40_000);
  });

  it("transforme les lignes « ♪ » en pause jusqu'à la ligne suivante", () => {
    const items = buildItems([
      { time_ms: 0, text: "Début" },
      { time_ms: 3000, text: "♪" },
      { time_ms: 20_000, text: "Retour" },
    ]);
    expect(items[1]).toMatchObject({ kind: "pause", start: 3000, end: 20_000 });
  });

  it("trouve l'élément en cours et son avancement", () => {
    const items = buildItems([
      { time_ms: 1000, text: "Un" },
      { time_ms: 3000, text: "Deux" },
    ]);
    expect(activeItemIndex(items, 500)).toBe(-1);
    expect(activeItemIndex(items, 3500)).toBe(1);
    expect(progress(1000, 2000, 1500)).toBe(0.5);
    expect(progress(1000, 2000, 5000)).toBe(1);
  });
});
