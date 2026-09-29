import { defineStore } from "pinia";
import { api } from "@/lib/api";
import { collator } from "@/lib/format";
import type { Album, Artist, ScanProgress, Track } from "@/lib/types";

export const UNKNOWN_ALBUM = "Album inconnu";
export const UNKNOWN_ARTIST = "Artiste inconnu";

export function albumKey(t: Track): string {
  return `${t.album_artist.toLowerCase()}\u0000${t.album.toLowerCase()}`;
}

/** Regroupe les pistes en albums (les pistes sans album n'en forment pas un faux). */
export function groupAlbums(tracks: Track[]): Album[] {
  const map = new Map<string, Album>();
  for (const t of tracks) {
    if (t.album === UNKNOWN_ALBUM) continue;
    const key = albumKey(t);
    let album = map.get(key);
    if (!album) {
      album = {
        key,
        title: t.album,
        artist: t.album_artist,
        year: t.year,
        tracks: [],
        coverTrack: null,
        addedSecs: 0,
        durationSecs: 0,
      };
      map.set(key, album);
    }
    album.tracks.push(t);
    album.durationSecs += t.duration_secs;
    album.addedSecs = Math.max(album.addedSecs, t.added_secs);
    if (!album.year && t.year) album.year = t.year;
    if (!album.coverTrack && t.has_cover) album.coverTrack = t;
  }
  for (const album of map.values()) {
    album.tracks.sort(
      (a, b) =>
        (a.disc_no ?? 1) - (b.disc_no ?? 1) ||
        (a.track_no ?? 999) - (b.track_no ?? 999) ||
        collator.compare(a.title, b.title),
    );
  }
  return [...map.values()].sort(
    (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title),
  );
}

export function groupArtists(tracks: Track[], albums: Album[]): Artist[] {
  const map = new Map<string, Artist>();
  const get = (name: string) => {
    let artist = map.get(name.toLowerCase());
    if (!artist) {
      artist = { name, albums: [], tracks: [] };
      map.set(name.toLowerCase(), artist);
    }
    return artist;
  };
  for (const t of tracks) get(t.artist).tracks.push(t);
  for (const a of albums) get(a.artist).albums.push(a);
  return [...map.values()]
    .filter((a) => a.tracks.length > 0)
    .sort((a, b) => {
      if (a.name === UNKNOWN_ARTIST) return 1;
      if (b.name === UNKNOWN_ARTIST) return -1;
      return collator.compare(a.name, b.name);
    });
}

function matches(t: Track, words: string[]): boolean {
  const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const useLibraryStore = defineStore("library", {
  state: () => ({
    root: null as string | null,
    tracks: [] as Track[],
    scanning: false,
    progress: null as ScanProgress | null,
    error: null as string | null,
  }),
  getters: {
    albums: (state): Album[] => groupAlbums(state.tracks),
    trackIndex: (state) => new Map(state.tracks.map((t) => [t.id, t])),
    totalDuration: (state) => state.tracks.reduce((s, t) => s + t.duration_secs, 0),
    artists(): Artist[] {
      return groupArtists(this.tracks, this.albums);
    },
    albumIndex(): Map<string, Album> {
      return new Map(this.albums.map((a) => [a.key, a]));
    },
  },
  actions: {
    byId(id: string): Track | null {
      return this.trackIndex.get(id) ?? null;
    },
    albumByKey(key: string): Album | null {
      return this.albumIndex.get(key) ?? null;
    },
    search(query: string) {
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return { tracks: [], albums: [], artists: [] as string[] };
      const tracks = this.tracks.filter((t) => matches(t, words));
      const albums = this.albums.filter((a) =>
        words.every((w) => `${a.title} ${a.artist}`.toLowerCase().includes(w)),
      );
      const artists = [...new Set(tracks.map((t) => t.artist))].filter((name) =>
        words.every((w) => name.toLowerCase().includes(w)),
      );
      return { tracks: tracks.slice(0, 200), albums: albums.slice(0, 24), artists: artists.slice(0, 12) };
    },
    setFromInitialState(root: string | null, tracks: Track[], scanning = false) {
      this.root = root;
      this.tracks = tracks;
      this.scanning = scanning;
    },
    applyProgress(p: ScanProgress) {
      this.scanning = true;
      this.progress = p;
    },
    applyScanResult(tracks: Track[]) {
      this.tracks = tracks;
      this.scanning = false;
      this.progress = null;
    },
    async chooseFolderAndScan() {
      const folder = await api.pickLibraryFolder();
      if (!folder) return;
      await this.scan(folder);
    },
    async scan(root: string) {
      this.scanning = true;
      this.error = null;
      try {
        const tracks = await api.scanLibrary(root);
        this.root = root;
        this.applyScanResult(tracks);
      } catch (e) {
        this.error = String(e);
        this.scanning = false;
      }
    },
  },
});
