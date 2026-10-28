<script setup lang="ts">
import { computed } from "vue";
import type { Playlist } from "@/lib/types";
import { useFavoritesStore } from "@/stores/favorites";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useShareStore } from "@/stores/share";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";
import PlaylistCover from "@/components/PlaylistCover.vue";

// Liste des playlists (onglet « Playlists » sur téléphone).
const playlists = usePlaylistsStore();
const share = useShareStore();
const ui = useUiStore();
const library = useLibraryStore();
const favorites = useFavoritesStore();
// Titres aimés, présentés comme une playlist (mêmes morceaux que la page « Titres aimés »).
const liked = computed(() => library.tracks.filter((t) => favorites.isFavorite(t.id)).length);

/** Morceaux réellement présents (sans les fichiers déplacés ou supprimés). */
function present(p: Playlist): number {
  return p.track_ids.filter((id) => library.byId(id)).length;
}
</script>

<template>
  <div class="page">
    <div class="head">
      <h1 class="page-title">Playlists</h1>
      <div class="head-actions">
        <button type="button" class="pill pill-ghost" @click="share.receiving = true"><Icon name="import" :size="15" /> Recevoir</button>
        <button type="button" class="pill pill-accent" @click="ui.playlistDialog = { mode: 'create' }"><Icon name="plus" :size="15" /> Nouvelle</button>
      </div>
    </div>
    <div class="grid">
      <button type="button" class="card" @click="ui.go({ name: 'favorites' })">
        <span class="liked-cover"><Icon name="heart" :size="44" style="--icon-fill: currentColor" /></span>
        <span class="name">Titres aimés</span>
        <span class="count">{{ liked }} morceau{{ liked > 1 ? "x" : "" }}</span>
      </button>
      <button v-for="p in playlists.items" :key="p.id" type="button" class="card" @click="ui.go({ name: 'playlist', id: p.id })">
        <PlaylistCover :name="p.name" :theme="p.theme" :styling="p.style" :radius="10" />
        <span class="name">{{ p.name }}</span>
        <span class="count">{{ present(p) }} morceau{{ present(p) > 1 ? "x" : "" }}</span>
      </button>
    </div>
    <div v-if="!playlists.items.length" class="empty">
      <p>Aucune playlist pour l'instant.</p>
      <p class="muted">Crée-en une ici, ou via « … » sur n'importe quel morceau → « Ajouter à une playlist ».</p>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.head-actions {
  display: flex;
  gap: 8px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 18px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
}
.card :deep(.pl-cover) {
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
}
.liked-cover {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  border-radius: 10px;
  background: linear-gradient(135deg, #5b2bd6, var(--like) 70%, #ffb38a);
  color: #fff;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
}
.name {
  margin-top: 6px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.count {
  font-size: 12.5px;
  color: var(--text-2);
}
.empty {
  padding: 40px 0;
  text-align: center;
}
</style>
