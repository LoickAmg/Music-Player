import { describe, expect, it } from "vitest";
import { wrap } from "./lyricsCard";

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
});
