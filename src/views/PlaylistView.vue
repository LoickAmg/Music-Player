<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { formatCollection } from "@/lib/format";
import type { Track } from "@/lib/types";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Artwork from "@/components/Artwork.vue";
import Icon from "@/components/Icon.vue";
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
// Mosaïque de 4 pochettes différentes, comme les playlists d'Apple Music.
const mosaic = computed(() => {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const t of tracks.value) {
    if (!t.has_cover || seen.has(t.album)) continue;
    seen.add(t.album);
    out.push(t);
    if (out.length === 4) break;
  }
  return out;
});

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
      <div class="cover" :class="{ grid: mosaic.length === 4 }">
        <template v-if="mosaic.length === 4">
          <Artwork v-for="t in mosaic" :key="t.id" :track="t" :radius="0" />
        </template>
        <Artwork v-else :track="mosaic[0] ?? null" :label="playlist.name" :radius="10" />
      </div>
      <div class="info">
        <p class="kicker">Playlist</p>
        <input v-if="editing" ref="input" v-model="draft" class="title-input" aria-label="Nom de la playlist" @keydown.enter="commitEdit" @keydown.esc="editing = false" @blur="commitEdit" />
        <h1 v-else title="Cliquer pour renommer" @click="startEdit">{{ playlist.name }}</h1>
        <p class="muted">{{ formatCollection(tracks.length, duration) }}</p>
        <div class="actions">
          <button type="button" class="pill pill-accent" :disabled="!ids.length" @click="player.playQueue(ids, ids[0])"><Icon name="play" :size="14" /> Lire</button>
          <button type="button" class="pill pill-ghost" :disabled="!ids.length" @click="player.playShuffled(ids)"><Icon name="shuffle" :size="15" /> Aléatoire</button>
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
  width: 230px;
  flex: none;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
}
.cover.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
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
</style>
