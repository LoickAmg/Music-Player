<script setup lang="ts">
import { computed, ref } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import TrackTable from "./TrackTable.vue";
import type { Track } from "@/lib/types";

const library = useLibraryStore();
const player = usePlayerStore();
const playlists = usePlaylistsStore();

const query = ref("");
type SortKey = "title" | "artist" | "album";
const sortKey = ref<SortKey>("title");

const addMenuTrackId = ref<string | null>(null);

const sorted = computed<Track[]>(() => {
  const filtered = library.filtered(query.value);
  return [...filtered].sort((a, b) => a[sortKey.value].localeCompare(b[sortKey.value], "fr"));
});

function playAll() {
  if (sorted.value.length === 0) return;
  void player.playQueue(sorted.value.map((t) => t.id));
}

function playTrack(trackId: string) {
  void player.playQueue(
    sorted.value.map((t) => t.id),
    trackId,
  );
}

function openAddMenu(trackId: string) {
  addMenuTrackId.value = addMenuTrackId.value === trackId ? null : trackId;
}

function addToPlaylist(playlistId: string) {
  if (!addMenuTrackId.value) return;
  void playlists.addTrack(playlistId, addMenuTrackId.value);
  addMenuTrackId.value = null;
}
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <h1>Bibliothèque</h1>
      <div class="toolbar">
        <input v-model="query" type="search" placeholder="Rechercher titre, artiste, album…" />
        <select v-model="sortKey">
          <option value="title">Trier par titre</option>
          <option value="artist">Trier par artiste</option>
          <option value="album">Trier par album</option>
        </select>
        <button class="primary" :disabled="sorted.length === 0" @click="playAll">▶ Tout lire</button>
      </div>
    </header>

    <div v-if="library.error" class="error-banner">{{ library.error }}</div>

    <div v-if="!library.root" class="empty-state">
      Choisis un dossier de musique dans le panneau de gauche pour commencer.
    </div>

    <div v-else-if="sorted.length === 0 && !library.loading" class="empty-state">
      Aucun morceau ne correspond{{ query ? " à ta recherche" : "" }}.
    </div>

    <div v-else class="table-with-menu">
      <TrackTable
        :tracks="sorted"
        :current-track-id="player.currentTrack?.id ?? null"
        secondary-action-label="+ Playlist"
        @play="playTrack"
        @secondary-action="openAddMenu"
      />

      <div v-if="addMenuTrackId" class="add-menu-overlay" @click.self="addMenuTrackId = null">
        <div class="add-menu">
          <div class="add-menu-title">Ajouter à une playlist</div>
          <div v-if="playlists.items.length === 0" class="empty-state small">
            Crée d'abord une playlist depuis le panneau "Playlists".
          </div>
          <button v-for="p in playlists.items" :key="p.id" class="add-menu-item" @click="addToPlaylist(p.id)">
            {{ p.name }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel {
  padding: 1.5em 1.75em;
  overflow-y: auto;
  height: 100%;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1em;
  margin-bottom: 1.25em;
  flex-wrap: wrap;
}

h1 {
  font-size: 1.15em;
  margin: 0;
}

.toolbar {
  display: flex;
  gap: 0.6em;
  align-items: center;
}

select {
  font-family: inherit;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: var(--radius);
  padding: 0.5em 0.6em;
  font-size: 0.85em;
}

.table-with-menu {
  position: relative;
}

.add-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
}

.add-menu {
  position: absolute;
  top: 2.5em;
  right: 2em;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5em;
  display: flex;
  flex-direction: column;
  gap: 0.2em;
  min-width: 12em;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.add-menu-title {
  font-size: 0.75em;
  color: var(--text-dim);
  padding: 0.3em 0.5em;
}

.add-menu-item {
  text-align: left;
  background: transparent;
  border: none;
}

.add-menu-item:hover {
  background: var(--bg-hover);
}

.empty-state.small {
  padding: 0.5em;
  font-size: 0.8em;
}
</style>
