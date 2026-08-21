import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { Playlist } from "@/lib/types";

export const usePlaylistsStore = defineStore("playlists", {
  state: () => ({
    items: [] as Playlist[],
    error: null as string | null,
  }),
  getters: {
    byId: (state) => (id: string) => state.items.find((p) => p.id === id) ?? null,
  },
  actions: {
    setFromInitialState(playlists: Playlist[]) {
      this.items = playlists;
    },
    async fetchAll() {
      this.items = await api.listPlaylists();
    },
    async create(name: string) {
      this.error = null;
      try {
        await api.createPlaylist(name);
        await this.fetchAll();
      } catch (e) {
        this.error = String(e);
      }
    },
    async remove(id: string) {
      this.error = null;
      try {
        await api.deletePlaylist(id);
        await this.fetchAll();
      } catch (e) {
        this.error = String(e);
      }
    },
    async rename(id: string, name: string) {
      this.error = null;
      try {
        await api.renamePlaylist(id, name);
        await this.fetchAll();
      } catch (e) {
        this.error = String(e);
      }
    },
    async addTrack(playlistId: string, trackId: string) {
      this.error = null;
      try {
        await api.addToPlaylist(playlistId, trackId);
        await this.fetchAll();
      } catch (e) {
        this.error = String(e);
      }
    },
    async removeTrack(playlistId: string, trackId: string) {
      this.error = null;
      try {
        await api.removeFromPlaylist(playlistId, trackId);
        await this.fetchAll();
      } catch (e) {
        this.error = String(e);
      }
    },
    async moveTrack(playlistId: string, from: number, to: number) {
      this.error = null;
      try {
        await api.moveTrackInPlaylist(playlistId, from, to);
        await this.fetchAll();
      } catch (e) {
        this.error = String(e);
      }
    },
  },
});
