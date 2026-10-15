import { describe, expect, it } from "vitest";

import { buildRecap, evolution, formatListening, isPlay, previousPeriod, type Listen } from "./recap";

/** Écoute à une date locale donnée. */
function listen(track: string, artist: string, when: Date, secs = 180, extra: Partial<Listen> = {}): Listen {
  return { track_id: track, title: `Titre ${track}`, artist, album: `Album ${artist}`, started: Math.floor(when.getTime() / 1000), secs, duration_secs: 200, ...extra };
}

const oct = (day: number, hour = 14) => new Date(2026, 9, day, hour, 0, 0);

describe("rétrospective", () => {
  it("ne compte que les écoutes de la période, avec le temps réellement écouté", () => {
    const r = buildRecap(
      [listen("a", "Nayte", oct(1)), listen("a", "Nayte", oct(2), 60), listen("b", "Damso", new Date(2026, 8, 30)), listen("c", "Tiakola", new Date(2026, 10, 1))],
      { kind: "month", year: 2026, month: 9 },
    );
    expect(r.totalSecs).toBe(240);
    expect(r.plays).toBe(2);
    expect(r.label).toBe("octobre 2026");
    expect(r.timeline).toHaveLength(31);
    expect(r.timeline[0]).toBe(180);
  });

  it("classe morceaux (écoutes) et artistes (temps)", () => {
    const r = buildRecap(
      [listen("a", "Nayte", oct(1)), listen("a", "Nayte", oct(1)), listen("b", "Damso", oct(2), 600), listen("c", "Damso", oct(3), 20)],
      { kind: "month", year: 2026, month: 9 },
    );
    expect(r.topTracks[0].key).toBe("a");
    expect(r.topTracks[0].plays).toBe(2);
    expect(r.topArtists.map((a) => a.label)).toEqual(["Damso", "Nayte"]);
    expect(r.artistCount).toBe(2);
  });

  it("trouve le meilleur jour, la plus longue série et l'obsession du jour", () => {
    const r = buildRecap(
      [listen("a", "X", oct(4)), listen("a", "X", oct(5)), listen("a", "X", oct(6)), listen("a", "X", oct(6)), listen("a", "X", oct(6)), listen("b", "Y", oct(20))],
      { kind: "month", year: 2026, month: 9 },
    );
    expect(r.longestStreak?.days).toBe(3);
    expect(r.bestDay?.date.getDate()).toBe(6);
    expect(r.obsession?.plays).toBe(3);
    expect(r.activeDays).toBe(4);
  });

  it("repère les artistes découverts quand l'historique remonte avant", () => {
    const all = [listen("a", "Ancien", new Date(2026, 5, 1)), listen("b", "Ancien", oct(1)), listen("c", "Nouveau", oct(2))];
    const r = buildRecap(all, { kind: "month", year: 2026, month: 9 });
    expect(r.discoveries).toEqual(["Nouveau"]);
    const first = buildRecap([listen("c", "Nouveau", oct(2))], { kind: "month", year: 2026, month: 9 });
    expect(first.hasEarlierHistory).toBe(false);
    expect(first.discoveries).toEqual([]);
  });

  it("donne un profil d'écoute (nuit, boucle…) et compare à la période précédente", () => {
    const night = buildRecap(
      [listen("a", "X", oct(1, 23)), listen("b", "Y", oct(2, 1)), listen("c", "Z", oct(3, 14))],
      { kind: "month", year: 2026, month: 9 },
    );
    expect(night.personality.id).toBe("nuit");
    const r = buildRecap([listen("a", "X", new Date(2026, 8, 3)), listen("a", "X", oct(1)), listen("b", "X", oct(2))], { kind: "month", year: 2026, month: 9 });
    expect(evolution(r)).toBe(100);
    expect(previousPeriod({ kind: "month", year: 2026, month: 0 })).toEqual({ kind: "month", year: 2025, month: 11 });
  });

  it("année : chronologie par mois, artistes inconnus écartés", () => {
    const r = buildRecap([listen("a", "Artiste inconnu", new Date(2026, 2, 3)), listen("b", "X", new Date(2026, 11, 3))], { kind: "year", year: 2026 });
    expect(r.timeline).toHaveLength(12);
    expect(r.timeline[2]).toBe(180);
    expect(r.topArtists.map((a) => a.label)).toEqual(["X"]);
  });

  it("formate les durées et reconnaît une écoute complète", () => {
    expect(formatListening(47 * 60)).toBe("47 min");
    expect(formatListening(12 * 3600 + 5 * 60)).toBe("12 h 05");
    expect(isPlay(listen("a", "X", oct(1), 25, { duration_secs: 40 }))).toBe(true);
    expect(isPlay(listen("a", "X", oct(1), 12))).toBe(false);
  });
});
