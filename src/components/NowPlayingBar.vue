<script setup lang="ts">
import { computed, ref } from "vue";
import { usePlayerStore } from "@/stores/player";
import { formatDuration } from "@/lib/format";

const emit = defineEmits<{
  (e: "toggle-queue"): void;
}>();

const player = usePlayerStore();

const duration = computed(() => player.currentTrack?.duration_secs ?? 0);

const seekDraft = ref<number | null>(null);
const displayedPosition = computed(() => seekDraft.value ?? player.positionSecs);

function onSeekInput(event: Event) {
  seekDraft.value = Number((event.target as HTMLInputElement).value);
}

function onSeekCommit(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  seekDraft.value = null;
  void player.seek(value);
}

function onVolumeInput(event: Event) {
  void player.setVolume(Number((event.target as HTMLInputElement).value));
}

function cycleRepeat() {
  const order: Array<typeof player.repeat> = ["off", "all", "one"];
  const next = order[(order.indexOf(player.repeat) + 1) % order.length];
  void player.setRepeat(next);
}
</script>

<template>
  <footer class="now-playing">
    <div class="track-info">
      <div class="cover-placeholder">🎵</div>
      <div class="text">
        <div class="title">{{ player.currentTrack?.title ?? "Aucune lecture en cours" }}</div>
        <div class="artist">{{ player.currentTrack?.artist ?? "—" }}</div>
      </div>
    </div>

    <div class="center">
      <div class="controls">
        <button
          class="icon"
          :class="{ active: player.shuffle }"
          title="Lecture aléatoire"
          @click="player.setShuffle(!player.shuffle)"
        >
          🔀
        </button>
        <button class="icon" title="Précédent" :disabled="!player.currentTrack" @click="player.previous()">⏮</button>
        <button class="icon play-pause" title="Lecture / Pause" :disabled="!player.currentTrack" @click="player.togglePlayPause()">
          {{ player.isPaused ? "▶" : "⏸" }}
        </button>
        <button class="icon" title="Suivant" :disabled="!player.currentTrack" @click="player.next()">⏭</button>
        <button
          class="icon"
          :class="{ active: player.repeat !== 'off' }"
          :title="`Répétition : ${player.repeat}`"
          @click="cycleRepeat"
        >
          {{ player.repeat === "one" ? "🔂" : "🔁" }}
        </button>
      </div>
      <div class="progress-row">
        <span class="time">{{ formatDuration(displayedPosition) }}</span>
        <input
          type="range"
          min="0"
          :max="duration || 0"
          step="1"
          :value="displayedPosition"
          :disabled="!player.currentTrack"
          @input="onSeekInput"
          @change="onSeekCommit"
        />
        <span class="time">{{ formatDuration(duration) }}</span>
      </div>
    </div>

    <div class="right">
      <button class="icon" title="File d'attente" @click="emit('toggle-queue')">📜</button>
      <span class="volume-icon">🔊</span>
      <input type="range" min="0" max="1" step="0.01" :value="player.volume" class="volume" @input="onVolumeInput" />
    </div>
  </footer>
</template>

<style scoped>
.now-playing {
  display: grid;
  grid-template-columns: 1fr 2fr 1fr;
  align-items: center;
  gap: 1.5em;
  padding: 0.75em 1.5em;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
}

.track-info {
  display: flex;
  align-items: center;
  gap: 0.75em;
  min-width: 0;
}

.cover-placeholder {
  width: 2.6em;
  height: 2.6em;
  border-radius: 6px;
  background: var(--bg-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1em;
  flex-shrink: 0;
}

.text {
  min-width: 0;
}

.title {
  font-weight: 600;
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.artist {
  font-size: 0.8em;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3em;
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.4em;
}

.play-pause {
  background: var(--accent);
  border-color: var(--accent);
  color: #241b04;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 0.6em;
  width: 100%;
  max-width: 32em;
}

.progress-row input[type="range"] {
  flex: 1;
}

.time {
  font-size: 0.75em;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  width: 2.6em;
  text-align: center;
}

.right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.6em;
}

.volume {
  width: 6em;
}

.volume-icon {
  font-size: 0.9em;
}
</style>
