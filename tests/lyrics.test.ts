import { describe, it, expect } from "vitest";
import { activeLineIndex } from "@/stores/lyrics";

const lines = [0, 4000, 9000, 15000].map((time_ms, i) => ({ time_ms, text: `ligne ${i}` }));

describe("activeLineIndex", () => {
  it("renvoie -1 avant la première ligne", () => {
    expect(activeLineIndex([{ time_ms: 2000, text: "x" }], 500)).toBe(-1);
  });
  it("renvoie la dernière ligne déjà commencée", () => {
    expect(activeLineIndex(lines, 0)).toBe(0);
    expect(activeLineIndex(lines, 3999)).toBe(0);
    expect(activeLineIndex(lines, 4000)).toBe(1);
    expect(activeLineIndex(lines, 12000)).toBe(2);
    expect(activeLineIndex(lines, 999999)).toBe(3);
  });
  it("gère une liste vide", () => {
    expect(activeLineIndex([], 1000)).toBe(-1);
  });
});
