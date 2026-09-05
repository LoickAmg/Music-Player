<script setup lang="ts">
import { formatDuration } from "@/lib/format";
import type { Track } from "@/lib/types";

const props = defineProps<{
  tracks: Track[];
  currentTrackId: string | null;
  /** Libellé du bouton d'action secondaire par ligne (ex: "Retirer", "+ Playlist"). Omis = pas de bouton. */
  secondaryActionLabel?: string;
}>();

const emit = defineEmits<{
  (e: "play", trackId: string): void;
  (e: "secondary-action", trackId: string): void;
}>();

function onRowActivate(track: Track) {
  emit("play", track.id);
}
</script>

<template>
  <div class="track-table">
    <div v-if="props.tracks.length === 0" class="empty-state">Aucune piste à afficher.</div>
    <table v-else>
      <thead>
        <tr>
          <th class="col-index"></th>
          <th>Titre</th>
          <th>Artiste</th>
          <th>Album</th>
          <th class="col-duration">Durée</th>
          <th v-if="props.secondaryActionLabel" class="col-action"></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(track, i) in props.tracks"
          :key="track.id"
          :class="{ current: track.id === props.currentTrackId }"
          @dblclick="onRowActivate(track)"
        >
          <td class="col-index">
            <button class="icon play-row" title="Lire" @click="onRowActivate(track)">
              {{ track.id === props.currentTrackId ? "▶" : i + 1 }}
            </button>
          </td>
          <td class="title-cell">{{ track.title }}</td>
          <td>{{ track.artist }}</td>
          <td>{{ track.album }}</td>
          <td class="col-duration">{{ formatDuration(track.duration_secs) }}</td>
          <td v-if="props.secondaryActionLabel" class="col-action">
            <button class="secondary small" @click="emit('secondary-action', track.id)">
              {{ props.secondaryActionLabel }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.track-table {
  width: 100%;
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}

thead th {
  text-align: left;
  color: var(--text-dim);
  font-weight: 500;
  font-size: 0.8em;
  padding: 0.4em 0.6em;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
}

tbody tr {
  border-bottom: 1px solid var(--row-border-subtle);
  cursor: default;
}

tbody tr:hover {
  background: var(--bg-hover);
}

tbody tr.current {
  color: var(--accent);
}

td {
  padding: 0.45em 0.6em;
}

.col-index {
  width: 2.4em;
  text-align: center;
  color: var(--text-dim);
}

.col-duration {
  width: 4.5em;
  color: var(--text-dim);
  text-align: right;
}

.col-action {
  width: 1%;
  white-space: nowrap;
}

.title-cell {
  font-weight: 500;
}

button.play-row {
  background: transparent;
  border: none;
  width: 2em;
  height: 2em;
  color: inherit;
}

button.play-row:hover {
  background: var(--bg-hover);
  border-radius: 999px;
}

button.secondary.small {
  padding: 0.25em 0.6em;
  font-size: 0.8em;
}
</style>
