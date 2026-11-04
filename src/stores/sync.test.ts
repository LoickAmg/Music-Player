import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import worker, { Profil } from "../../relay/src/index.js";
import { encrypt, newSyncKey } from "@/lib/sync";
import type { Playlist, Track } from "@/lib/types";

// Le moteur de l'appli, réduit à ce que la synchronisation utilise.
const engine = vi.hoisted(() => ({ playlists: [] as Playlist[], favorites: new Set<string>(), listens: [] as unknown[] }));
vi.mock("@/lib/api", () => ({
  api: {
    getListens: async () => engine.listens,
    importListens: async (l: unknown[]) => {
      engine.listens.push(...l);
      return l.length;
    },
    listPlaylists: async () => engine.playlists.map((p) => ({ ...p })),
    createPlaylist: async (name: string, theme: string) => {
      engine.playlists.push({ id: `id-${name}`, name, theme, style: null, track_ids: [] });
      return `id-${name}`;
    },
    deletePlaylist: async (id: string) => {
      engine.playlists = engine.playlists.filter((p) => p.id !== id);
    },
    addTracksToPlaylist: async (id: string, ids: string[]) => {
      engine.playlists.find((p) => p.id === id)!.track_ids.push(...ids);
      return ids.length;
    },
    removeFromPlaylist: async (id: string, trackId: string) => {
      const p = engine.playlists.find((x) => x.id === id)!;
      p.track_ids = p.track_ids.filter((t) => t !== trackId);
    },
    addFavorites: async (ids: string[]) => {
      ids.forEach((i) => engine.favorites.add(i));
      return ids.length;
    },
    listFavorites: async () => [...engine.favorites],
    toggleFavorite: async (id: string) => {
      if (engine.favorites.delete(id)) return false;
      engine.favorites.add(id);
      return true;
    },
    defaultRelay: async () => "https://relais.test",
    nearbyStart: async () => {},
    remoteReceive: async () => ({ name: "Lien", kind: "sauvegarde", added_tracks: 0, skipped_tracks: 0, playlist_id: null }),
  },
}));

import { useFriendsStore } from "./friends";
import { useLibraryStore } from "./library";
import { usePlaylistsStore } from "./playlists";
import { useShareStore } from "./share";
import { parseLink, useSyncStore } from "./sync";

class Storage {
  map = new Map<string, unknown>();
  async get(k: string) {
    return this.map.get(k);
  }
  async put(k: string, v: unknown) {
    this.map.set(k, v);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
}
let profiles: Map<string, Profil>;
const env = {
  PROFILS: {
    idFromName: (n: string) => n,
    get: (id: string) => {
      if (!profiles.has(id)) profiles.set(id, new Profil({ storage: new Storage() }));
      return profiles.get(id)!;
    },
  },
};
const BASE = "https://relais.test";
const CODE = "K7QM-2D9X";
const SECRET = "a".repeat(64);
const post = (action: string, body: unknown) => worker.fetch(new Request(`${BASE}/v1/profil/${CODE}/${action}`, { method: "POST", body: JSON.stringify(body) }), env);
const stored = () => (profiles.get(CODE) as unknown as { state: { storage: Storage } }).state.storage.map;

function track(id: string, title: string): Track {
  return { id, path: `/m/${id}.mp3`, title, artist: "Artiste", album: "Album", album_artist: "Artiste", track_no: null, disc_no: null, year: null, genre: null, duration_secs: 200, has_cover: false, added_secs: 0 };
}

beforeEach(async () => {
  profiles = new Map();
  localStorage.clear();
  engine.playlists = [];
  engine.favorites = new Set();
  engine.listens = [];
  setActivePinia(createPinia());
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env));
  useShareStore().relay = BASE;
  useLibraryStore().tracks = [track("a", "Lemon"), track("b", "Redo")];
  await post("profil", { secret: SECRET, nom: "A" });
});

describe("mise à jour depuis l'ancien compte", () => {
  async function oldAccount(key: string, cle: string) {
    await post("compte", { secret: SECRET, cle });
    const backup = {
      format: "music-player-sauvegarde",
      playlists: [{ name: "Soir", theme: "ocean", style: null, tracks: [{ title: "Redo", artist: "Artiste", album: "Album", duration: 200 }] }],
      favorites: [{ title: "Lemon", artist: "Artiste", album: "Album", duration: 200 }],
      listens: [],
      prefs: { "mp:proches": JSON.stringify({ me: { code: CODE, secret: SECRET }, enabled: true, friends: [] }) },
    };
    await post("envoyer", { cle, n: 0, total: 1, data: await encrypt(key, JSON.stringify(backup)) });
    localStorage.setItem("mp:compte", JSON.stringify({ code: CODE, keys: { cle, key }, lastUpload: 0 }));
  }

  it("reprend la sauvegarde, garde l'appareil lié, puis efface l'ancien compte du relais", async () => {
    const key = newSyncKey();
    await oldAccount(key, "c".repeat(64));
    const sync = useSyncStore();
    await sync.migrateAccount();
    const friends = useFriendsStore();
    friends.stop();
    expect(friends.me?.code).toBe(CODE);
    expect(sync.linked).toBe(true);
    expect(sync.saved?.key).toBe(key);
    // Rien de perdu si l'appli se ferme avant la fusion : l'ancien compte reste noté.
    expect(localStorage.getItem("mp:compte")).not.toBeNull();

    expect(await sync.run()).toBe(true);
    await vi.waitFor(() => expect(stored().has("compte")).toBe(false));
    expect(usePlaylistsStore().items.map((p) => p.name)).toEqual(["Soir"]);
    expect(usePlaylistsStore().items[0].track_ids).toEqual(["b"]);
    expect([...engine.favorites]).toEqual(["a"]);
    expect(stored().has("sauvegarde")).toBe(false);
    expect(localStorage.getItem("mp:compte")).toBeNull();
    expect(stored().has("synchro")).toBe(true);
  });

  it("un deuxième appareil du même compte rejoint le même état, sans rien refaire", async () => {
    const key = newSyncKey();
    await oldAccount(key, "c".repeat(64));
    const first = useSyncStore();
    await first.migrateAccount();
    useFriendsStore().stop();
    await first.run();
    await vi.waitFor(() => expect(stored().has("compte")).toBe(false));

    // Deuxième appareil : même clé de compte, sauvegarde déjà effacée.
    setActivePinia(createPinia());
    engine.playlists = [];
    engine.favorites = new Set();
    localStorage.clear();
    localStorage.setItem("mp:compte", JSON.stringify({ code: CODE, keys: { cle: "c".repeat(64), key }, lastUpload: 0 }));
    localStorage.setItem("mp:proches", JSON.stringify({ me: { code: CODE, secret: SECRET }, enabled: true, friends: [] }));
    useShareStore().relay = BASE;
    useLibraryStore().tracks = [track("x", "Lemon"), track("y", "Redo")];
    const second = useSyncStore();
    await second.migrateAccount();
    expect(second.linked).toBe(true);
    expect(localStorage.getItem("mp:compte")).toBeNull();
    expect(await second.run()).toBe(true);
    expect(usePlaylistsStore().items[0].track_ids).toEqual(["y"]);
    expect([...engine.favorites]).toEqual(["x"]);
  });

  it("garde l'ancien compte noté si le relais est injoignable", async () => {
    await oldAccount(newSyncKey(), "c".repeat(64));
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("hors ligne");
    });
    const sync = useSyncStore();
    await sync.migrateAccount();
    expect(sync.linked).toBe(false);
    expect(localStorage.getItem("mp:compte")).not.toBeNull();
  });
});

describe("liaison", () => {
  const link = { format: "music-player-lien", key: "k", from: "PC", proches: { me: { code: CODE, secret: SECRET }, enabled: false, shareListening: true, friends: [], outgoing: [], incoming: [] }, mots: { conversations: {} } };

  it("ne prend un lien que si cet appareil en attend un", () => {
    const sync = useSyncStore();
    const parsed = parseLink(JSON.stringify(link))!;
    expect(sync.onLink(parsed)).toBe(false);
    expect(sync.pendingLink).toBeNull();
    sync.awaitingLink = true;
    expect(sync.onLink(parsed)).toBe(true);
    expect(sync.linked).toBe(false); // rien n'est appliqué avant la confirmation
  });

  it("reconnaît un lien et rien d'autre", () => {
    expect(parseLink(JSON.stringify(link))).not.toBeNull();
    expect(parseLink('{"format":"music-player-sauvegarde"}')).toBeNull();
    expect(parseLink("pas du json")).toBeNull();
  });

  it("délier oublie la clé, le profil et les conversations", () => {
    const friends = useFriendsStore();
    friends.me = { code: CODE, secret: SECRET };
    friends.conversations = { x: [{ mine: true, texte: "privé", piece: null, at: 1 }] };
    friends.saveWords();
    const sync = useSyncStore();
    sync.saved = { key: "k", lastSync: 0 };
    sync.unlink();
    expect(sync.linked).toBe(false);
    expect(friends.me).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain(SECRET);
    expect(JSON.stringify(localStorage)).not.toContain("privé");
  });
});
