<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { formatCollection } from "@/lib/format";
import type { Track } from "@/lib/types";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";
import PlaylistCover from "@/components/PlaylistCover.vue";
import TrackRow from "@/components/TrackRow.vue";

const props = defineProps<{ id: string }>();
const library = useLibraryStore();
const player = usePlayerStore();
const playlists = usePlaylistsStore();
const ui = useUiStore();

const playlist = computed(() => playlists.byId(props.id));
const tracks = computed(
  () => (playlist.value?.track_ids.map((id) => library.byId(id)).filter(Boolean) as Track[]) ?? [],
);
const ids = computed(() => tracks.value.map((t) => t.id));
const duration = computed(() => tracks.value.reduce((s, t) => s + t.duration_secs, 0));

const editing = ref(false);
const draft = ref("");
const input = ref<HTMLInputElement | null>(null);
async function startEdit() {
  draft.value = playlist.value?.name ?? "";
  editing.value = true;
  await nextTick();
  input.value?.select();
}
async function commitEdit() {
  if (!editing.value) return;
  editing.value = false;
  const name = draft.value.trim();
  if (name && name !== playlist.value?.name) await playlists.rename(props.id, name);
}
async function remove() {
  if (!playlist.value) return;
  if (!window.confirm(`Supprimer la playlist « ${playlist.value.name} » ? Les morceaux restent dans la bibliothèque.`)) return;
  await playlists.remove(props.id);
  ui.go({ name: "recent" });
}
</script>

<template>
  <div v-if="playlist" class="page">
    <header class="hero">
      <button type="button" class="cover" title="Personnaliser la jaquette" @click="ui.playlistDialog = { mode: 'edit', id: playlist.id }">
        <PlaylistCover :name="playlist.name" :theme="playlist.theme" :radius="10" />
        <span class="cover-edit">Personnaliser</span>
      </button>
      <div class="info">
        <p class="kicker">Playlist</p>
        <input v-if="editing" ref="input" v-model="draft" class="title-input" aria-label="Nom de la playlist" @keydown.enter="commitEdit" @keydown.esc="editing = false" @blur="commitEdit" />
        <h1 v-else title="Cliquer pour renommer" @click="startEdit">{{ playlist.name }}</h1>
        <p class="muted">{{ formatCollection(tracks.length, duration) }}</p>
        <div class="actions">
          <button type="button" class="pill pill-accent" :disabled="!ids.length" @click="player.playQueue(ids, ids[0])"><Icon name="play" :size="14" /> Lire</button>
          <button type="button" class="pill pill-ghost" :disabled="!ids.length" @click="player.playShuffled(ids)"><Icon name="shuffle" :size="15" /> Aléatoire</button>
          <button type="button" class="icon-btn" title="Personnaliser (nom, jaquette)" aria-label="Personnaliser la playlist" @click="ui.playlistDialog = { mode: 'edit', id: playlist.id }"><Icon name="brush" :size="17" /></button>
          <button type="button" class="icon-btn" title="Supprimer la playlist" aria-label="Supprimer la playlist" @click="remove"><Icon name="trash" :size="17" /></button>
        </div>
      </div>
    </header>

    <div v-if="!tracks.length" class="empty">
      <p>Cette playlist est vide.</p>
      <p class="muted">Clic droit (ou «&nbsp;…&nbsp;») sur n'importe quel morceau → «&nbsp;Ajouter à une playlist&nbsp;».</p>
    </div>
    <div v-for="(track, i) in tracks" :key="`${i}-${track.id}`" class="row">
      <TrackRow :track="track" :index="i" variant="playlist" :playlist-id="playlist.id" striped @play="player.playQueue(ids, track.id)" />
    </div>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: flex-end;
  gap: 28px;
  margin-bottom: 28px;
}
.cover {
  position: relative;
  width: 230px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: 10px;
  overflow: hidden;
  background: none;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
}
.cover-edit {
  position: absolute;
  inset: auto 0 0;
  padding: 10px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.55));
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  opacity: 0;
  transition: opacity 0.2s;
}
.cover:hover .cover-edit {
  opacity: 1;
}
.kicker {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
h1,
.title-input {
  margin: 4px 0 4px;
  font-family: var(--font-display);
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
h1 {
  cursor: text;
}
.title-input {
  width: 100%;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-active);
  outline: 2px solid var(--accent);
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}
.pill:disabled {
  opacity: 0.4;
}
.row {
  height: 52px;
}
.empty {
  padding: 40px 0;
  text-align: center;
}
.empty p {
  margin: 4px;
}
@media (max-width: 760px) {
  .hero {
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 16px;
  }
  .hero .actions {
    justify-content: center;
  }
  .art,
  .cover {
    width: min(64vw, 260px);
  }
  h1,
  .title-input {
    font-size: 24px;
  }
}
</style>
