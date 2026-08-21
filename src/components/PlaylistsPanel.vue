<script setup lang="ts">
import { computed, ref } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import TrackTable from "./TrackTable.vue";

const props = defineProps<{
  activePlaylistId: string | null;
}>();

const emit = defineEmits<{
  (e: "open-playlist", id: string | null): void;
}>();

const library = useLibraryStore();
const player = usePlayerStore();
const playlists = usePlaylistsStore();

const newPlaylistName = ref("");
const renamingId = ref<string | null>(null);
const renameDraft = ref("");

const activePlaylist = computed(() => playlists.byId(props.activePlaylistId ?? ""));

const activeTracks = computed(() => {
  const playlist = activePlaylist.value;
  if (!playlist) return [];
  return playlist.track_ids.map((id) => library.byId(id)).filter((t): t is NonNullable<typeof t> => t !== null);
});

async function createPlaylist() {
  const name = newPlaylistName.value.trim();
  if (!name) return;
  await playlists.create(name);
  newPlaylistName.value = "";
}

function startRename(id: string, currentName: string) {
  renamingId.value = id;
  renameDraft.value = currentName;
}

async function confirmRename() {
  if (!renamingId.value) return;
  const name = renameDraft.value.trim();
  if (name) await playlists.rename(renamingId.value, name);
  renamingId.value = null;
}

async function deletePlaylist(id: string) {
  await playlists.remove(id);
  if (props.activePlaylistId === id) emit("open-playlist", null);
}

function playAll() {
  if (activeTracks.value.length === 0) return;
  void player.playQueue(activeTracks.value.map((t) => t.id));
}

function playTrack(trackId: string) {
  void player.playQueue(
    activeTracks.value.map((t) => t.id),
    trackId,
  );
}

function removeFromPlaylist(trackId: string) {
  if (!activePlaylist.value) return;
  void playlists.removeTrack(activePlaylist.value.id, trackId);
}
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <h1>{{ activePlaylist ? activePlaylist.name : "Playlists" }}</h1>
      <button v-if="activePlaylist" class="secondary" @click="emit('open-playlist', null)">← Toutes les playlists</button>
    </header>

    <div v-if="playlists.error" class="error-banner">{{ playlists.error }}</div>

    <template v-if="!activePlaylist">
      <form class="new-playlist" @submit.prevent="createPlaylist">
        <input v-model="newPlaylistName" type="text" placeholder="Nom de la nouvelle playlist" />
        <button class="primary" type="submit">Créer</button>
      </form>

      <div v-if="playlists.items.length === 0" class="empty-state">
        Aucune playlist. Crée la première ci-dessus, puis ajoute des morceaux depuis la bibliothèque.
      </div>

      <ul v-else class="playlist-cards">
        <li v-for="p in playlists.items" :key="p.id" class="playlist-card">
          <div class="card-main" @click="emit('open-playlist', p.id)">
            <div class="card-name">
              <template v-if="renamingId === p.id">
                <input
                  v-model="renameDraft"
                  type="text"
                  class="rename-input"
                  @click.stop
                  @keyup.enter="confirmRename"
                  @keyup.esc="renamingId = null"
                  @blur="confirmRename"
                />
              </template>
              <template v-else>🎧 {{ p.name }}</template>
            </div>
            <div class="card-count">{{ p.track_ids.length }} piste(s)</div>
          </div>
          <div class="card-actions">
            <button class="icon" title="Renommer" @click.stop="startRename(p.id, p.name)">✎</button>
            <button class="icon" title="Supprimer" @click.stop="deletePlaylist(p.id)">🗑</button>
          </div>
        </li>
      </ul>
    </template>

    <template v-else>
      <div class="toolbar">
        <button class="primary" :disabled="activeTracks.length === 0" @click="playAll">▶ Tout lire</button>
      </div>
      <TrackTable
        :tracks="activeTracks"
        :current-track-id="player.currentTrack?.id ?? null"
        secondary-action-label="Retirer"
        @play="playTrack"
        @secondary-action="removeFromPlaylist"
      />
    </template>
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
}

h1 {
  font-size: 1.15em;
  margin: 0;
}

.toolbar {
  margin-bottom: 1em;
}

.new-playlist {
  display: flex;
  gap: 0.6em;
  margin-bottom: 1.5em;
}

.new-playlist input {
  flex: 1;
  max-width: 24em;
}

.playlist-cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5em;
}

.playlist-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1em;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.7em 1em;
}

.card-main {
  flex: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1em;
}

.card-name {
  font-weight: 500;
}

.card-count {
  font-size: 0.8em;
  color: var(--text-dim);
}

.card-actions {
  display: flex;
  gap: 0.3em;
}

.rename-input {
  font-size: 1em;
}
</style>
