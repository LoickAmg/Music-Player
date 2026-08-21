<script setup lang="ts">
import { computed } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { formatDuration } from "@/lib/format";

const emit = defineEmits<{
  (e: "close"): void;
}>();

const library = useLibraryStore();
const player = usePlayerStore();

const queueTracks = computed(() =>
  player.queueIds.map((id, index) => ({ index, track: library.byId(id) })).filter((entry) => entry.track !== null),
);

function jumpTo(trackId: string) {
  void player.playTrackNow(trackId);
}

function remove(index: number) {
  void player.removeFromQueue(index);
}
</script>

<template>
  <aside class="queue-drawer">
    <header>
      <h2>File d'attente</h2>
      <button class="icon" title="Fermer" @click="emit('close')">✕</button>
    </header>

    <div v-if="queueTracks.length === 0" class="empty-state">La file d'attente est vide.</div>

    <ul v-else class="queue-list">
      <li
        v-for="entry in queueTracks"
        :key="`${entry.index}-${entry.track!.id}`"
        class="queue-item"
        :class="{ current: entry.index === player.queuePosition }"
      >
        <button class="track-button" @dblclick="jumpTo(entry.track!.id)" @click="jumpTo(entry.track!.id)">
          <div class="title">{{ entry.track!.title }}</div>
          <div class="meta">{{ entry.track!.artist }} · {{ formatDuration(entry.track!.duration_secs) }}</div>
        </button>
        <button class="icon remove" title="Retirer de la file" @click="remove(entry.index)">✕</button>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.queue-drawer {
  width: 20em;
  border-left: 1px solid var(--border);
  background: var(--bg-elevated);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1em 1.1em;
  border-bottom: 1px solid var(--border);
}

h2 {
  font-size: 0.95em;
  margin: 0;
}

.queue-list {
  list-style: none;
  margin: 0;
  padding: 0.5em;
  overflow-y: auto;
  flex: 1;
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 0.3em;
  border-radius: var(--radius);
}

.queue-item:hover {
  background: var(--bg-hover);
}

.queue-item.current {
  color: var(--accent);
}

.track-button {
  flex: 1;
  text-align: left;
  background: transparent;
  border: none;
  padding: 0.5em 0.6em;
  min-width: 0;
}

.title {
  font-size: 0.85em;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  font-size: 0.75em;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queue-item.current .meta {
  color: inherit;
  opacity: 0.75;
}

button.remove {
  background: transparent;
  border: none;
  flex-shrink: 0;
}
</style>
