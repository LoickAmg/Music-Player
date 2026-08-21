import { describe, it, expect } from "vitest";
import { formatDuration } from "@/lib/format";

describe("formatDuration", () => {
  it("formate les secondes en m:ss avec zéro de tête", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(5)).toBe("0:05");
  });

  it("gère les durées de plusieurs minutes", () => {
    expect(formatDuration(3725)).toBe("62:05");
  });

  it("tronque les fractions de seconde", () => {
    expect(formatDuration(59.9)).toBe("0:59");
  });

  it("traite les valeurs négatives ou non finies comme 0:00", () => {
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(NaN)).toBe("0:00");
    expect(formatDuration(Infinity)).toBe("0:00");
  });
});
