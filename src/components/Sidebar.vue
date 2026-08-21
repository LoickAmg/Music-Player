<script setup lang="ts">
import { computed } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";

type View = "library" | "playlists" | "equalizer";

const props = defineProps<{
  activeView: View;
  activePlaylistId: string | null;
}>();

const emit = defineEmits<{
  (e: "navigate", view: View): void;
  (e: "open-playlist", id: string): void;
}>();

const library = useLibraryStore();
const playlists = usePlaylistsStore();

const rootLabel = computed(() => {
  if (!library.root) return "Aucun dossier choisi";
  const parts = library.root.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : library.root;
});
</script>

<template>
  <aside class="sidebar">
    <div class="brand">🎵 Music Player</div>

    <div class="library-block">
      <div class="library-root" :title="library.root ?? ''">{{ rootLabel }}</div>
      <button class="secondary" :disabled="library.loading" @click="library.chooseFolderAndScan()">
        {{ library.loading ? "Analyse en cours…" : "Choisir un dossier" }}
      </button>
    </div>

    <nav class="nav">
      <button
        class="nav-item"
        :class="{ active: props.activeView === 'library' }"
        @click="emit('navigate', 'library')"
      >
        📚 Bibliothèque
        <span class="count">{{ library.tracks.length }}</span>
      </button>
      <button
        class="nav-item"
        :class="{ active: props.activeView === 'playlists' && !props.activePlaylistId }"
        @click="emit('navigate', 'playlists')"
      >
        🎧 Playlists
        <span class="count">{{ playlists.items.length }}</span>
      </button>
      <button
        class="nav-item"
        :class="{ active: props.activeView === 'equalizer' }"
        @click="emit('navigate', 'equalizer')"
      >
        🎚️ Égaliseur
      </button>
    </nav>

    <div class="playlists-block">
      <div class="section-title">Playlists</div>
      <div v-if="playlists.items.length === 0" class="empty-state small">Aucune playlist pour l'instant.</div>
      <ul class="playlist-list">
        <li v-for="p in playlists.items" :key="p.id">
          <button
            class="nav-item"
            :class="{ active: props.activeView === 'playlists' && props.activePlaylistId === p.id }"
            @click="emit('open-playlist', p.id)"
          >
            🎧 {{ p.name }}
            <span class="count">{{ p.track_ids.length }}</span>
          </button>
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 1.25em;
  padding: 1.25em 1em;
  border-right: 1px solid var(--border);
  background: var(--bg-elevated);
  overflow-y: auto;
}

.brand {
  font-weight: 700;
  font-size: 1.05em;
}

.library-block {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
}

.library-root {
  font-size: 0.8em;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

button.secondary {
  width: 100%;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 0.25em;
}

.nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5em;
  width: 100%;
  text-align: left;
  background: transparent;
  border-color: transparent;
}

.nav-item:hover {
  background: var(--bg-hover);
}

.nav-item.active {
  background: rgba(242, 184, 75, 0.12);
  border-color: var(--accent-dim);
  color: var(--accent);
}

.count {
  font-size: 0.75em;
  color: var(--text-dim);
}

.nav-item.active .count {
  color: inherit;
  opacity: 0.8;
}

.section-title {
  font-size: 0.75em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
  margin-bottom: 0.4em;
}

.playlist-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2em;
}

.empty-state.small {
  padding: 0.5em 0;
  font-size: 0.8em;
  text-align: left;
}
</style>
