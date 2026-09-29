<script setup lang="ts">
import { computed } from "vue";
import { formatDuration } from "@/lib/format";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Artwork from "./Artwork.vue";
import Icon from "./Icon.vue";
import LyricsView from "./LyricsView.vue";

const ui = useUiStore();
const player = usePlayerStore();
const library = useLibraryStore();

const upNext = computed(() => {
  const start = player.queuePosition === null ? 0 : player.queuePosition + 1;
  return player.queueIds
    .slice(start, start + 300)
    .map((id, i) => ({ index: start + i, track: library.byId(id) }))
    .filter((e) => e.track !== null);
});
const remaining = computed(() => {
  const start = player.queuePosition === null ? 0 : player.queuePosition + 1;
  return Math.max(0, player.queueIds.length - start);
});
</script>

<template>
  <aside class="side-panel" :aria-label="ui.panel === 'lyrics' ? 'Paroles' : 'À suivre'">
    <div class="tabs">
      <button type="button" :class="{ on: ui.panel === 'lyrics' }" @click="ui.panel = 'lyrics'">Paroles</button>
      <button type="button" :class="{ on: ui.panel === 'queue' }" @click="ui.panel = 'queue'">À suivre</button>
      <button type="button" class="icon-btn close" aria-label="Fermer le panneau" @click="ui.panel = null">
        <Icon name="close" :size="15" />
      </button>
    </div>

    <LyricsView v-if="ui.panel === 'lyrics'" />

    <div v-else class="queue">
      <template v-if="player.currentTrack">
        <p class="q-title">En cours de lecture</p>
        <div class="q-item current">
          <Artwork :track="player.currentTrack" :radius="4" />
          <div class="q-text">
            <span class="q-t">{{ player.currentTrack.title }}</span>
            <span class="q-s">{{ player.currentTrack.artist }}</span>
          </div>
        </div>
      </template>
      <p class="q-title">
        À suivre <span class="count">{{ remaining }}</span>
      </p>
      <p v-if="!upNext.length" class="q-empty">Rien d'autre dans la file.</p>
      <div v-for="entry in upNext" :key="`${entry.index}-${entry.track!.id}`" class="q-item" @dblclick="player.playTrackNow(entry.track!.id)">
        <Artwork :track="entry.track" :radius="4" />
        <div class="q-text">
          <span class="q-t">{{ entry.track!.title }}</span>
          <span class="q-s">{{ entry.track!.artist }} · {{ formatDuration(entry.track!.duration_secs) }}</span>
        </div>
        <button type="button" class="icon-btn q-remove" aria-label="Retirer de la file" @click="player.removeFromQueue(entry.index)">
          <Icon name="close" :size="13" />
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.side-panel {
  width: 340px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: linear-gradient(180deg, rgba(4, 16, 46, 0.94), rgba(2, 7, 22, 0.96));
  border-left: 1px solid rgba(63, 224, 255, 0.2);
  animation: slide 0.25s var(--ease);
}
@keyframes slide {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
}
.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 12px 6px;
}
.tabs > button:not(.close) {
  height: 30px;
  padding: 0 16px;
  border: 0;
  clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
  background: none;
  color: var(--text-2);
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.tabs > button.on {
  background: #fff;
  color: var(--ink);
}
.close {
  margin-left: auto;
}
.queue {
  flex: 1;
  overflow-y: auto;
  padding: 6px 10px 20px;
}
.q-title {
  margin: 14px 8px 8px;
  font-size: 13px;
  font-weight: 700;
}
.count {
  margin-left: 4px;
  color: var(--text-3);
  font-weight: 500;
}
.q-empty {
  margin: 0 8px;
  color: var(--text-3);
  font-size: 12px;
}
.q-item {
  display: grid;
  grid-template-columns: 38px 1fr 28px;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  border-radius: 7px;
}
.q-item:hover {
  background: var(--bg-hover);
}
.q-item.current .q-t {
  color: var(--accent);
}
.q-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.q-t,
.q-s {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.q-t {
  font-size: 13px;
}
.q-s {
  font-size: 11.5px;
  color: var(--text-2);
}
.q-remove {
  width: 26px;
  height: 26px;
  opacity: 0;
}
.q-item:hover .q-remove {
  opacity: 1;
}
</style>
