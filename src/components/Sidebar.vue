<script setup lang="ts">
import { computed, ref } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";
import PlaylistCover from "./PlaylistCover.vue";

const ui = useUiStore();
const library = useLibraryStore();
const playlists = usePlaylistsStore();
const searchInput = ref<HTMLInputElement | null>(null);

defineExpose({ focusSearch: () => searchInput.value?.focus() });

const nav = [
  { name: "recent", label: "Ajouts récents", icon: "clock" },
  { name: "artists", label: "Artistes", icon: "artist" },
  { name: "albums", label: "Albums", icon: "album" },
  { name: "songs", label: "Morceaux", icon: "songs" },
] as const;

const progress = computed(() => {
  const p = library.progress;
  if (!p || !p.total) return null;
  return Math.round((p.done / p.total) * 100);
});

function newPlaylist() {
  ui.playlistDialog = { mode: "create" };
}
</script>

<template>
  <aside class="sidebar">
    <label class="search">
      <Icon name="search" :size="15" />
      <input
        ref="searchInput"
        :value="ui.search"
        type="search"
        placeholder="Rechercher"
        aria-label="Rechercher dans la bibliothèque"
        @input="ui.setSearch(($event.target as HTMLInputElement).value)"
        @keydown.esc="ui.setSearch(''); ($event.target as HTMLInputElement).blur()"
      />
    </label>

    <nav class="section" aria-label="Bibliothèque">
      <p class="section-title">Bibliothèque</p>
      <button
        v-for="item in nav"
        :key="item.name"
        type="button"
        class="nav-item"
        :class="{ active: ui.route.name === item.name }"
        @click="ui.go({ name: item.name })"
      >
        <Icon :name="item.icon" :size="17" class="ico" />
        {{ item.label }}
      </button>
    </nav>

    <nav class="section playlists" aria-label="Playlists">
      <p class="section-title">
        Playlists
        <button type="button" class="add" title="Nouvelle playlist" aria-label="Nouvelle playlist" @click="newPlaylist">
          <Icon name="plus" :size="15" />
        </button>
      </p>
      <button
        v-for="p in playlists.items"
        :key="p.id"
        type="button"
        class="nav-item"
        :class="{ active: ui.route.name === 'playlist' && ui.route.id === p.id }"
        @click="ui.go({ name: 'playlist', id: p.id })"
      >
        <PlaylistCover :name="p.name" :theme="p.theme" :radius="4" mini class="pl-thumb" />
        <span class="ellipsis">{{ p.name }}</span>
      </button>
      <p v-if="!playlists.items.length" class="empty">Aucune playlist pour l'instant.</p>
    </nav>

    <div class="foot">
      <div v-if="library.scanning" class="scan" role="status">
        <span class="spinner" />
        <span>
          Analyse de la bibliothèque<span v-if="progress !== null"> · {{ progress }} %</span>
        </span>
      </div>
      <button
        type="button"
        class="nav-item"
        :class="{ active: ui.route.name === 'settings' }"
        @click="ui.go({ name: 'settings' })"
      >
        <Icon name="settings" :size="17" class="ico" />
        Réglages
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px 10px 10px;
  background: linear-gradient(180deg, #06122f 0%, #040b20 100%);
  border-right: 1px solid var(--separator);
}
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 9px;
  margin: 0 4px 18px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-2);
  box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.06);
}
.search:focus-within {
  box-shadow: 0 0 0 2px var(--accent);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  font-size: 13px;
}
.search input::-webkit-search-cancel-button {
  filter: invert(1) opacity(0.5);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 18px;
}
.playlists {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 10px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
}
.add {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--text-2);
}
.add:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: none;
  text-align: left;
  font-size: 13.5px;
  min-width: 0;
}
.nav-item:hover {
  background: var(--bg-hover);
}
.nav-item.active {
  background: var(--bg-active);
}
.ico {
  flex: none;
  color: var(--accent);
}
.pl-thumb {
  flex: none;
  width: 20px;
}
.ellipsis {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.empty {
  margin: 2px 10px;
  font-size: 12px;
  color: var(--text-3);
}
.foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--separator);
}
.scan {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-2);
}
.spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.15);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
