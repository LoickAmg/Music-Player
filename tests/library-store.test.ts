import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { groupAlbums, groupArtists, useLibraryStore, UNKNOWN_ALBUM } from "@/stores/library";
import { api } from "@/lib/api";
import type { Track } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  api: {
    pickLibraryFolder: vi.fn(),
    scanLibrary: vi.fn(),
  },
}));

let n = 0;
function track(overrides: Partial<Track>): Track {
  n++;
  return {
    id: `t${n}`,
    path: `/musique/t${n}.mp3`,
    title: "Titre",
    artist: "Artiste",
    album: "Album",
    album_artist: overrides.artist ?? "Artiste",
    track_no: 1,
    disc_no: null,
    year: null,
    genre: null,
    duration_secs: 180,
    has_cover: false,
    added_secs: 100,
    ...overrides,
  };
}

describe("regroupements", () => {
  it("groupAlbums réunit les pistes d'un album, les ordonne, et ignore « Album inconnu »", () => {
    const tracks = [
      track({ title: "B", album: "Horizon", artist: "Camille", track_no: 2, added_secs: 50 }),
      track({ title: "A", album: "Horizon", artist: "Camille", track_no: 1, has_cover: true, year: 2019, added_secs: 90 }),
      track({ title: "Seul", album: UNKNOWN_ALBUM }),
    ];
    const albums = groupAlbums(tracks);
    expect(albums).toHaveLength(1);
    expect(albums[0].tracks.map((t) => t.title)).toEqual(["A", "B"]);
    expect(albums[0].coverTrack?.title).toBe("A");
    expect(albums[0].year).toBe(2019);
    expect(albums[0].addedSecs).toBe(90);
    expect(albums[0].durationSecs).toBe(360);
  });

  it("groupAlbums distingue deux albums homonymes d'artistes différents", () => {
    const albums = groupAlbums([
      track({ album: "Greatest Hits", artist: "Queen" }),
      track({ album: "Greatest Hits", artist: "ABBA" }),
    ]);
    expect(albums.map((a) => a.artist)).toEqual(["ABBA", "Queen"]);
  });

  it("groupArtists trie par nom (accents compris) et range « Artiste inconnu » à la fin", () => {
    const tracks = [
      track({ artist: "Artiste inconnu" }),
      track({ artist: "Élodie" }),
      track({ artist: "damso" }),
    ];
    const names = groupArtists(tracks, groupAlbums(tracks)).map((a) => a.name);
    expect(names).toEqual(["damso", "Élodie", "Artiste inconnu"]);
  });
});

describe("library store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("search() trouve par mots dans titre, artiste et album, insensible à la casse", () => {
    const store = useLibraryStore();
    store.tracks = [
      track({ title: "Nuit Blanche", artist: "Camille", album: "Horizon" }),
      track({ title: "Autre chose", artist: "STUDIO SUD", album: "Petites Machines" }),
    ];
    expect(store.search("nuit camille").tracks).toHaveLength(1);
    expect(store.search("studio").artists).toEqual(["STUDIO SUD"]);
    expect(store.search("petites").albums.map((a) => a.title)).toEqual(["Petites Machines"]);
    expect(store.search("   ").tracks).toHaveLength(0);
  });

  it("byId et albumByKey retrouvent leurs éléments", () => {
    const store = useLibraryStore();
    const t = track({ album: "Horizon", artist: "Camille" });
    store.tracks = [t];
    expect(store.byId(t.id)?.id).toBe(t.id);
    expect(store.byId("nope")).toBeNull();
    expect(store.albumByKey(store.albums[0].key)?.title).toBe("Horizon");
  });

  it("scan() met à jour les pistes, et l'erreur en cas d'échec", async () => {
    const store = useLibraryStore();
    vi.mocked(api.scanLibrary).mockResolvedValueOnce([track({})]);
    await store.scan("/musique");
    expect(store.root).toBe("/musique");
    expect(store.tracks).toHaveLength(1);
    expect(store.scanning).toBe(false);

    vi.mocked(api.scanLibrary).mockRejectedValueOnce(new Error("dossier introuvable"));
    await store.scan("/inexistant");
    expect(store.error).toContain("introuvable");
    expect(store.scanning).toBe(false);
  });

  it("les événements de scan mettent à jour la progression puis le résultat", () => {
    const store = useLibraryStore();
    store.applyProgress({ done: 64, total: 128 });
    expect(store.scanning).toBe(true);
    store.applyScanResult([track({})]);
    expect(store.scanning).toBe(false);
    expect(store.progress).toBeNull();
    expect(store.tracks).toHaveLength(1);
  });

  it("chooseFolderAndScan() ne scanne pas si l'utilisateur annule", async () => {
    const store = useLibraryStore();
    vi.mocked(api.pickLibraryFolder).mockResolvedValueOnce(null);
    await store.chooseFolderAndScan();
    expect(api.scanLibrary).not.toHaveBeenCalled();
  });
});
