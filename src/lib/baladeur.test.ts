import { describe, expect, it } from "vitest";
import { angleDelta, clock, initialOf, moveSelection, pointAngle, skinById, STEP_DEGREES, wheelSteps, wheelZone, windowTop } from "./baladeur";

describe("molette du baladeur", () => {
  it("reconnaît les quatre boutons de l'anneau et le centre", () => {
    expect(wheelZone(0, -80, 100)).toBe("menu");
    expect(wheelZone(80, 0, 100)).toBe("next");
    expect(wheelZone(0, 80, 100)).toBe("play");
    expect(wheelZone(-80, 0, 100)).toBe("prev");
    expect(wheelZone(10, 10, 100)).toBe("center");
    expect(wheelZone(200, 0, 100)).toBeNull();
  });

  it("mesure les angles dans le sens horaire depuis le haut", () => {
    expect(pointAngle(0, -1)).toBeCloseTo(0);
    expect(pointAngle(1, 0)).toBeCloseTo(90);
    expect(pointAngle(-1, 0)).toBeCloseTo(270);
    // Passage par le haut : 350° → 10° vaut +20°, pas −340°.
    expect(angleDelta(350, 10)).toBeCloseTo(20);
    expect(angleDelta(10, 350)).toBeCloseTo(-20);
  });

  it("compte les crans et garde le reste", () => {
    expect(wheelSteps(0, STEP_DEGREES - 1, 100)).toEqual({ steps: 0, rest: STEP_DEGREES - 1 });
    expect(wheelSteps(STEP_DEGREES - 1, 2, 100)).toEqual({ steps: 1, rest: 1 });
    expect(wheelSteps(0, -STEP_DEGREES, 100).steps).toBe(-1);
  });

  it("accélère quand on tourne vite", () => {
    expect(wheelSteps(0, STEP_DEGREES * 2, 1000).steps).toBe(2);
    expect(wheelSteps(0, STEP_DEGREES * 2, 10).steps).toBe(8);
  });
});

describe("listes du baladeur", () => {
  it("borne la sélection sans revenir au début", () => {
    expect(moveSelection(0, -3, 10)).toBe(0);
    expect(moveSelection(8, 5, 10)).toBe(9);
    expect(moveSelection(3, 2, 0)).toBe(0);
  });

  it("fait suivre la fenêtre visible", () => {
    expect(windowTop(0, 3, 6, 4)).toBe(0);
    expect(windowTop(0, 7, 6, 20)).toBe(2);
    expect(windowTop(5, 2, 6, 20)).toBe(2);
    expect(windowTop(18, 19, 6, 20)).toBe(14);
  });

  it("donne l'initiale sans accent, « # » sinon", () => {
    expect(initialOf("Élodie")).toBe("E");
    expect(initialOf("  zaz")).toBe("Z");
    expect(initialOf("2Pac")).toBe("#");
  });

  it("écrit les durées et les finitions par défaut", () => {
    expect(clock(187)).toBe("3:07");
    expect(clock(-72)).toBe("-1:12");
    expect(skinById("inconnue").id).toBe("craie");
    expect(skinById("ambre").mono).toBe(true);
  });
});
