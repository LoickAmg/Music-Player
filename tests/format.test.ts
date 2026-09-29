import { describe, it, expect } from "vitest";
import { formatCollection, formatDuration } from "@/lib/format";

describe("formatDuration", () => {
  it("formate les secondes en m:ss avec zéro de tête", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(5)).toBe("0:05");
  });

  it("passe aux heures au-delà de 60 minutes", () => {
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  it("tronque les fractions de seconde", () => {
    expect(formatDuration(59.9)).toBe("0:59");
  });

  it("traite les valeurs négatives ou non finies comme 0:00", () => {
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(NaN)).toBe("0:00");
    expect(formatDuration(Infinity)).toBe("0:00");
  });

  it("résume une collection en morceaux et durée", () => {
    expect(formatCollection(1, 180)).toBe("1 morceau, 3 min");
    expect(formatCollection(12, 48 * 60)).toBe("12 morceaux, 48 min");
    expect(formatCollection(230, 14 * 3600 + 120)).toBe("230 morceaux, 14 h 2 min");
  });
});