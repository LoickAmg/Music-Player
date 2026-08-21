import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useLibraryStore } from "@/stores/library";
import { api } from "@/lib/api";
import type { Track } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  api: {
    pickLibraryFolder: vi.fn(),
    scanLibrary: vi.fn(),
  },
}));

function track(overrides: Partial<Track>): Track {
  return {
    id: "t1",
    path: "/musique/t1.mp3",
    title: "Titre",
    artist: "Artiste",
    album: "Album",
    track_no: 1,
    duration_secs: 180,
    has_cover: false,
    ...overrides,
  };
}

describe("library store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("filtered() cherche dans le titre, l'artiste et l'album, insensible à la casse", () => {
    const store = useLibraryStore();
    store.tracks = [
      track({ id: "1", title: "Nuit Blanche", artist: "Camille", album: "Horizon" }),
      track({ id: "2", title: "Autre chose", artist: "STUDIO SUD", album: "Petites Machines" }),
    ];
    expect(store.filtered("nuit").map((t) => t.id)).toEqual(["1"]);
    expect(store.filtered("studio sud").map((t) => t.id)).toEqual(["2"]);
    expect(store.filtered("").map((t) => t.id)).toEqual(["1", "2"]);
    expect(store.filtered("introuvable")).toHaveLength(0);
  });

  it("byId retrouve une piste ou renvoie null", () => {
    const store = useLibraryStore();
    store.tracks = [track({ id: "abc" })];
    expect(store.byId("abc")?.id).toBe("abc");
    expect(store.byId("nope")).toBeNull();
  });

  it("scan() met à jour tracks et root, et error en cas d'échec", async () => {
    const store = useLibraryStore();
    vi.mocked(api.scanLibrary).mockResolvedValueOnce([track({ id: "x" })]);

    await store.scan("/musique");
    expect(store.root).toBe("/musique");
    expect(store.tracks).toHaveLength(1);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();

    vi.mocked(api.scanLibrary).mockRejectedValueOnce(new Error("dossier introuvable"));
    await store.scan("/inexistant");
    expect(store.error).toContain("introuvable");
  });

  it("chooseFolderAndScan() ne scanne pas si l'utilisateur annule la sélection", async () => {
    const store = useLibraryStore();
    vi.mocked(api.pickLibraryFolder).mockResolvedValueOnce(null);
    await store.chooseFolderAndScan();
    expect(api.scanLibrary).not.toHaveBeenCalled();
  });
});
