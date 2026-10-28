import { describe, expect, it } from "vitest";
import { buildBackup, parseBackup, planRestore } from "./backup";
import type { Playlist, Track } from "./types";

function track(id: string, title: string, artist: string, path = `/m/${id}.mp3`): Track {
  return {
    id,
    path,
    title,
    artist,
    album: "Album",
    album_artist: artist,
    track_no: null,
    disc_no: null,
    year: null,
    genre: null,
    duration_secs: 200,
    has_cover: false,
    added_secs: 0,
  };
}

describe("sauvegarde", () => {
  it("restaure playlists, titres aimés et écoute sur un autre appareil", () => {
    // Appareil d'origine.
    const pc = [track("pc1", "Papaoutai", "Stromae"), track("pc2", "Djadja", "Aya Nakamura"), track("pc3", "Rare", "Inconnu")];
    const byId = (id: string) => pc.find((t) => t.id === id) ?? null;
    const playlist: Playlist = { id: "p", name: "Soirée", track_ids: ["pc1", "pc2", "pc3", "disparu"], theme: "ocean", style: { image: "photo.jpg", dim: 0.3 } };
    const backup = buildBackup({
      device: "PC",
      playlists: [playlist],
      favoriteIds: ["pc2"],
      byId,
      listens: [{ track_id: "pc1", title: "Papaoutai", artist: "Stromae", album: "Album", started: 1, secs: 120, duration_secs: 200 }],
      appearance: { themeId: "aurore" },
    });
    expect(backup.playlists[0].tracks).toHaveLength(3);
    expect(backup.playlists[0].style?.image).toBeNull();

    // Téléphone : autres identifiants, mêmes morceaux (sauf un).
    const phone = [track("tel1", "Papaoutai", "Stromae", "/sd/a.m4a"), track("tel2", "Djadja", "Aya Nakamura", "/sd/b.m4a")];
    const plan = planRestore(parseBackup(JSON.stringify(backup)), phone);
    expect(plan.playlists[0].found.map((t) => t.id)).toEqual(["tel1", "tel2"]);
    expect(plan.playlists[0].missing.map((t) => t.title)).toEqual(["Rare"]);
    expect(plan.favorites.map((t) => t.id)).toEqual(["tel2"]);
    expect(plan.listens[0].track_id).toBe("tel1");
  });

  it("refuse un fichier qui n'est pas une sauvegarde", () => {
    expect(() => parseBackup("{}")).toThrow();
    expect(() => parseBackup("pas du json")).toThrow();
  });
});

describe("sauvegarde partagée par deux appareils", () => {
  it("fusionne au lieu d'écraser", async () => {
    const { mergeBackups } = await import("./backup");
    const base = { format: "music-player-sauvegarde" as const, version: 1 as const, created: "", device: "", appearance: null };
    const t = (title: string, artist = "A") => ({ title, artist, album: "", duration: 200 });
    const phone = {
      ...base,
      device: "Téléphone",
      playlists: [{ name: "J-Pop", theme: "ocean", style: null, tracks: [t("Lemon")] }, { name: "Funk", theme: "sunset", style: null, tracks: [t("Montagem")] }],
      favorites: [t("Lemon")],
      listens: [{ track_id: "a", title: "Lemon", artist: "A", album: "", started: 1, secs: 100, duration_secs: 200 }],
      prefs: { "mp:proches": '{"me":{"code":"K7QM-2D9X"}}' },
    };
    const pc = {
      ...base,
      device: "PC",
      playlists: [{ name: "funk", theme: "sunset", style: null, tracks: [t("Montagem"), t("Bota")] }, { name: "Re:Zero", theme: "aurora", style: null, tracks: [t("Redo")] }],
      favorites: [t("Redo")],
      listens: [
        { track_id: "b", title: "Lemon", artist: "A", album: "", started: 1, secs: 100, duration_secs: 200 },
        { track_id: "c", title: "Redo", artist: "A", album: "", started: 2, secs: 90, duration_secs: 200 },
      ],
      prefs: {},
    };
    const merged = mergeBackups(pc, phone);
    expect(merged.playlists.map((p) => `${p.name}:${p.tracks.length}`).sort()).toEqual(["J-Pop:1", "Re:Zero:1", "funk:2"]);
    expect(merged.favorites.map((f) => f.title).sort()).toEqual(["Lemon", "Redo"]);
    expect(merged.listens).toHaveLength(2);
    expect(merged.prefs["mp:proches"]).toContain("K7QM-2D9X");
  });
});
