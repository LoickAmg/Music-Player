<script setup lang="ts">
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";
import PlaylistCover from "@/components/PlaylistCover.vue";

// Liste des playlists (onglet « Playlists » sur téléphone).
const playlists = usePlaylistsStore();
const ui = useUiStore();
</script>

<template>
  <div class="page">
    <div class="head">
      <h1 class="page-title">Playlists</h1>
      <button type="button" class="pill pill-accent" @click="ui.playlistDialog = { mode: 'create' }"><Icon name="plus" :size="15" /> Nouvelle</button>
    </div>
    <div v-if="playlists.items.length" class="grid">
      <button v-for="p in playlists.items" :key="p.id" type="button" class="card" @click="ui.go({ name: 'playlist', id: p.id })">
        <PlaylistCover :name="p.name" :theme="p.theme" :radius="10" />
        <span class="name">{{ p.name }}</span>
        <span class="count">{{ p.track_ids.length }} morceau{{ p.track_ids.length > 1 ? "x" : "" }}</span>
      </button>
    </div>
    <div v-else class="empty">
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
