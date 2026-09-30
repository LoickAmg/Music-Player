import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { usePlaylistsStore } from "@/stores/playlists";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    listPlaylists: vi.fn(),
    createPlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    renamePlaylist: vi.fn(),
    addToPlaylist: vi.fn(),
    removeFromPlaylist: vi.fn(),
    moveTrackInPlaylist: vi.fn(),
    setPlaylistTheme: vi.fn(),
  },
}));

describe("playlists store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("create() crée puis recharge la liste", async () => {
    const store = usePlaylistsStore();
    vi.mocked(api.createPlaylist).mockResolvedValueOnce("pl-1");
    vi.mocked(api.listPlaylists).mockResolvedValueOnce([{ id: "pl-1", name: "Route", track_ids: [], theme: "aurora" }]);

    await store.create("Route", "ocean");

    expect(api.createPlaylist).toHaveBeenCalledWith("Route", "ocean");
    expect(store.items).toHaveLength(1);
    expect(store.items[0].name).toBe("Route");
  });

  it("byId retrouve une playlist par id", () => {
    const store = usePlaylistsStore();
    store.items = [{ id: "a", name: "A", track_ids: [], theme: "aurora" }];
    expect(store.byId("a")?.name).toBe("A");
    expect(store.byId("nope")).toBeNull();
  });

  it("remove() supprime puis recharge, et expose une erreur en cas d'échec", async () => {
    const store = usePlaylistsStore();
    vi.mocked(api.deletePlaylist).mockRejectedValueOnce(new Error("réseau"));
    await store.remove("pl-1");
    expect(store.error).toContain("réseau");
  });

  it("addTrack() propage l'ajout puis rafraîchit", async () => {
    const store = usePlaylistsStore();
    vi.mocked(api.addToPlaylist).mockResolvedValueOnce(undefined);
    vi.mocked(api.listPlaylists).mockResolvedValueOnce([{ id: "pl-1", name: "Route", track_ids: ["t1"] }]);

    await store.addTrack("pl-1", "t1");

    expect(api.addToPlaylist).toHaveBeenCalledWith("pl-1", "t1");
    expect(store.items[0].track_ids).toEqual(["t1"]);
  });

  it("setTheme() enregistre le thème puis recharge", async () => {
    const store = usePlaylistsStore();
    vi.mocked(api.listPlaylists).mockResolvedValueOnce([{ id: "a", name: "A", track_ids: [], theme: "ember" }]);
    await store.setTheme("a", "ember");
    expect(api.setPlaylistTheme).toHaveBeenCalledWith("a", "ember");
    expect(store.items[0].theme).toBe("ember");
  });
});
