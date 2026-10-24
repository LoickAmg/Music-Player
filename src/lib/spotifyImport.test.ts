// @vitest-environment node
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { LibraryMatcher, matchPlaylist, missingText, parseCsv, readExportFile } from "./spotifyImport";
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
    album_artist: o.artist ?? "Artiste",
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

const playlistJson = {
  playlists: [
    {
      name: "Soirée",
      lastModifiedDate: "2026-09-01",
      items: [
        { track: { trackName: "Papaoutai", artistName: "Stromae", albumName: "Racine carrée" } },
        { track: { trackName: "Djadja (feat. Maluma)", artistName: "Aya Nakamura", albumName: "Nakamura" } },
        { track: null, episode: { episodeName: "Podcast" } },
        { track: { trackName: "Introuvable", artistName: "Personne", albumName: "" } },
      ],
    },
    { name: "Vide", items: [] },
  ],
};
const libraryJson = { tracks: [{ artist: "Stromae", album: "Racine carrée", track: "Formidable", uri: "spotify:track:x" }] };

describe("lecture de l'export Spotify", () => {
  it("lit l'archive de l'export (playlists et titres likés)", () => {
    const zip = zipSync({
      "Spotify Account Data/Playlist1.json": strToU8(JSON.stringify(playlistJson)),
      "Spotify Account Data/YourLibrary.json": strToU8(JSON.stringify(libraryJson)),
      "Spotify Account Data/Userdata.json": strToU8("{}"),
    });
    const out = readExportFile("my_spotify_data.zip", zip);
    expect(out.playlists.map((p) => p.name)).toEqual(["Soirée"]);
    expect(out.playlists[0].tracks).toHaveLength(3);
    expect(out.liked).toEqual([{ title: "Formidable", artist: "Stromae", album: "Racine carrée" }]);
  });

  it("lit un CSV d'Exportify", () => {
    const csv = String.fromCharCode(0xfeff) + 'Track URI,Track Name,Artist Name(s),Album Name\nx,"Hello, world","Adele, Someone",25\ny,Skyfall,Adele,Skyfall\n';
    const p = parseCsv(csv, "Ma_playlist.csv");
    expect(p?.name).toBe("Ma playlist");
    expect(p?.tracks).toEqual([
      { title: "Hello, world", artist: "Adele", album: "25" },
      { title: "Skyfall", artist: "Adele", album: "Skyfall" },
    ]);
  });
});

describe("correspondance avec la bibliothèque", () => {
  const lib = [
    track({ title: "Papaoutai", artist: "Stromae", album: "Racine carrée" }),
    track({ title: "Djadja", artist: "Aya Nakamura", album: "Nakamura" }),
    track({ title: "Hello", artist: "Lionel Richie" }),
    track({ title: "Formidable", artist: "Artiste inconnu" }),
  ];
  const matcher = new LibraryMatcher(lib);

  it("retrouve les morceaux malgré les mentions (feat., clip…)", () => {
    const m = matchPlaylist(matcher, readExportFile("Playlist1.json", strToU8(JSON.stringify(playlistJson))).playlists[0]);
    expect(m.found.map((t) => t.title)).toEqual(["Papaoutai", "Djadja"]);
    expect(missingText(m.missing)).toBe("Personne — Introuvable");
  });

  it("refuse un autre artiste, accepte un fichier sans artiste au titre unique", () => {
    expect(matcher.find({ title: "Hello", artist: "Adele", album: "25" })).toBeNull();
    expect(matcher.find({ title: "Formidable", artist: "Stromae", album: "" })?.title).toBe("Formidable");
  });
});
