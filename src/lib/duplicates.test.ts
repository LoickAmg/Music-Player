import { describe, expect, it } from "vitest";
import { findDuplicates, normalize } from "./duplicates";
import type { Track } from "./types";

let n = 0;
function track(o: Partial<Track>): Track {
  n++;
  return {
    id: `t${n}`,
    path: `/m/t${n}.mp3`,
    title: "Titre",
    artist: "Artiste",
    album: "Album",
    album_artist: "Artiste",
    track_no: null,
    disc_no: null,
    year: null,
    genre: null,
    duration_secs: 200,
    has_cover: false,
    added_secs: 0,
    ...o,
  };
}

describe("normalize", () => {
  it("efface les mentions de mise en ligne et les accents", () => {
    expect(normalize("Ta fête (Official Video)")).toBe("ta fete");
    expect(normalize("01 - Alors on danse")).toBe("alors on danse");
    expect(normalize("Djadja (feat. Maluma)")).toBe("djadja");
    expect(normalize("Formidable (1)")).toBe("formidable");
    expect(normalize("Bohemian Rhapsody - Remastered 2011")).toBe("bohemian rhapsody");
  });
});

describe("findDuplicates", () => {
  it("regroupe les copies d'un même morceau et propose la meilleure", () => {
    const mp3 = track({ title: "Papaoutai", artist: "Stromae", path: "/m/Papaoutai.mp3", duration_secs: 232 });
    const flac = track({ title: "Papaoutai (Clip officiel)", artist: "Stromae", path: "/m/a/Papaoutai.flac", duration_secs: 233, has_cover: true });
    const other = track({ title: "Formidable", artist: "Stromae", duration_secs: 214 });
    const groups = findDuplicates([mp3, flac, other]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tracks.map((t) => t.id).sort()).toEqual([mp3.id, flac.id].sort());
    expect(groups[0].keep).toBe(flac.id);
  });

  it("ne confond pas deux versions de durées différentes", () => {
    const studio = track({ title: "Tous les mêmes", artist: "Stromae", duration_secs: 210 });
    const live = track({ title: "Tous les mêmes", artist: "Stromae", duration_secs: 290 });
    expect(findDuplicates([studio, live])).toHaveLength(0);
  });

  it("ne mélange pas deux artistes", () => {
    const a = track({ title: "Hello", artist: "Adele", duration_secs: 295 });
    const b = track({ title: "Hello", artist: "Lionel Richie", duration_secs: 295 });
    expect(findDuplicates([a, b])).toHaveLength(0);
  });
});
