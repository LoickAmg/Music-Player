import { describe, expect, it } from "vitest";
import { CODE_PATTERN, newCode, parseCode, relayBase } from "./friendsApi";

describe("codes d'ami", () => {
  it("génère des codes valides, sans caractères ambigus", () => {
    for (let i = 0; i < 200; i++) {
      const code = newCode();
      expect(code).toMatch(CODE_PATTERN);
      expect(code).not.toMatch(/[01IO]/);
    }
  });

  it("accepte une saisie libre", () => {
    expect(parseCode("k7qm 2d9x")).toBe("K7QM-2D9X");
    expect(parseCode("K7QM2D9X")).toBe("K7QM-2D9X");
    expect(parseCode(" k7qm-2d9x ")).toBe("K7QM-2D9X");
    expect(parseCode("K7QM-2D9")).toBeNull();
    expect(parseCode("K7QM-2D90")).toBeNull();
  });

  it("adresse du relais en https", () => {
    expect(relayBase("wss://relais.example.dev/")).toBe("https://relais.example.dev");
    expect(relayBase("https://relais.example.dev")).toBe("https://relais.example.dev");
  });
});
