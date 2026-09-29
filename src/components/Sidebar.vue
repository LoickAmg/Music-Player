<script setup lang="ts">
import { computed, ref } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

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

async function newPlaylist() {
  const id = await playlists.create(`Nouvelle playlist ${playlists.items.length + 1}`);
  if (id) ui.go({ name: "playlist", id });
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <img src="/logo.png" alt="" />
      <span>Music<br /><b>Player</b></span>
    </div>
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
        <Icon name="playlist" :size="17" class="ico" />
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
  padding: 16px 12px 10px;
  background: linear-gradient(180deg, rgba(3, 11, 34, 0.95), rgba(2, 7, 22, 0.97));
  border-right: 1px solid rgba(63, 224, 255, 0.18);
  box-shadow: 1px 0 0 rgba(31, 107, 255, 0.2), 8px 0 30px rgba(0, 0, 0, 0.35);
  position: relative;
  z-index: 6;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 4px 18px;
}
.brand img {
  width: 44px;
  height: 44px;
  clip-path: polygon(14% 0, 100% 0, 86% 100%, 0 100%);
  filter: drop-shadow(3px 3px 0 var(--blue));
}
.brand span {
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 700;
  font-size: 15px;
  line-height: 0.95;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-2);
}
.brand b {
  font-weight: 800;
  font-size: 22px;
  color: var(--text);
  text-shadow: 2px 2px 0 var(--blue);
}
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 9px;
  margin: 0 4px 18px;
  clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
  background: rgba(31, 107, 255, 0.18);
  color: var(--text-2);
}
.search:focus-within {
  background: rgba(63, 224, 255, 0.2);
  color: var(--text);
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
  font-family: var(--font-display);
  font-style: italic;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cyan);
  opacity: 0.75;
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
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 12px;
  border: 0;
  background: none;
  text-align: left;
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 600;
  font-size: 17px;
  letter-spacing: 0.03em;
  min-width: 0;
  transition: color 0.15s, transform 0.2s var(--ease);
}
.nav-item::before {
  content: "";
  position: absolute;
  inset: 2px 0;
  z-index: -1;
  transform: skewX(-16deg);
  transition: background 0.15s, box-shadow 0.2s var(--ease);
}
.nav-item:hover {
  transform: translateX(3px);
}
.nav-item:hover::before {
  background: var(--bg-hover);
}
/* Sélection façon menu P3R : barre blanche inclinée, texte bleu nuit, ombre cyan décalée */
.nav-item.active {
  color: var(--ink);
}
.nav-item.active::before {
  background: #fff;
  box-shadow: 5px 4px 0 var(--cyan);
}
.nav-item.active .ico {
  color: var(--blue);
}
.ico {
  flex: none;
  color: var(--cyan);
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
