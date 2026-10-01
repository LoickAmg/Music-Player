<script setup lang="ts">
import { computed, ref } from "vue";
import { useFrame, useNow } from "@/lib/clock";
import { formatDuration } from "@/lib/format";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import { albumKey } from "@/stores/library";
import Artwork from "./Artwork.vue";
import Icon from "./Icon.vue";

const player = usePlayerStore();
const ui = useUiStore();
const now = useNow();

const track = computed(() => player.currentTrack);
const duration = computed(() => track.value?.duration_secs ?? 0);
const dragging = ref<number | null>(null);
// À la seconde près : le texte ne change qu'une fois par seconde (pas de rendu à chaque image).
const position = computed(() => Math.floor(dragging.value ?? player.positionAt(now.value)));
// La barre, elle, avance à chaque image, mise à jour directement.
const fill = ref<HTMLElement | null>(null);
useFrame((t) => {
  if (!fill.value) return;
  const pos = dragging.value ?? player.positionAt(t);
  fill.value.style.transform = `scaleX(${duration.value > 0 ? Math.min(1, pos / duration.value) : 0})`;
});

const bar = ref<HTMLElement | null>(null);
function ratioFromEvent(e: PointerEvent) {
  const rect = bar.value!.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}
function startSeek(e: PointerEvent) {
  if (!track.value || !duration.value) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragging.value = ratioFromEvent(e) * duration.value;
}
function moveSeek(e: PointerEvent) {
  if (dragging.value !== null) dragging.value = ratioFromEvent(e) * duration.value;
}
async function endSeek() {
  if (dragging.value === null) return;
  const target = dragging.value;
  await player.seek(target);
  dragging.value = null;
}

const lastVolume = ref(1);
function toggleMute() {
  if (player.volume > 0) {
    lastVolume.value = player.volume;
    void player.setVolume(0);
  } else {
    void player.setVolume(lastVolume.value || 1);
  }
}
</script>

<template>
  <header class="player-bar">
    <div class="transport">
      <button type="button" class="icon-btn" :class="{ on: player.shuffle }" title="Aléatoire" aria-label="Aléatoire" :aria-pressed="player.shuffle" @click="player.setShuffle(!player.shuffle)">
        <Icon name="shuffle" :size="17" />
      </button>
      <button type="button" class="icon-btn big" title="Précédent" aria-label="Précédent" :disabled="!track" @click="player.previous()">
        <Icon name="prev" :size="20" />
      </button>
      <button type="button" class="icon-btn play" :title="player.isPaused ? 'Lire' : 'Pause'" :aria-label="player.isPaused ? 'Lire' : 'Pause'" :disabled="!track" @click="player.togglePlayPause()">
        <Icon :name="player.isPaused ? 'play' : 'pause'" :size="26" />
      </button>
      <button type="button" class="icon-btn big" title="Suivant" aria-label="Suivant" :disabled="!track" @click="player.next()">
        <Icon name="next" :size="20" />
      </button>
      <button type="button" class="icon-btn repeat" :class="{ on: player.repeat !== 'off' }" :title="`Répéter : ${player.repeat === 'off' ? 'non' : player.repeat === 'all' ? 'tout' : 'ce morceau'}`" :aria-label="`Répéter : ${player.repeat === 'off' ? 'non' : player.repeat === 'all' ? 'tout' : 'ce morceau'}`" @click="player.cycleRepeat()">
        <Icon name="repeat" :size="17" />
        <span v-if="player.repeat === 'one'" class="one">1</span>
      </button>
    </div>

    <div class="lcd" :class="{ empty: !track }">
      <template v-if="track">
        <button type="button" class="lcd-art" title="Afficher « À l'écoute »" aria-label="Afficher « À l'écoute »" @click="ui.openNowPlaying()">
          <Artwork :track="track" :radius="4" eager />
          <span class="expand"><Icon name="expand" :size="16" /></span>
        </button>
        <div class="lcd-body">
          <div class="lcd-text">
            <span class="lcd-title">{{ track.title }}</span>
            <span class="lcd-sub">
              <button type="button" class="lcd-link" @click="ui.go({ name: 'artists', artist: track.artist })">{{ track.artist }}</button>
              <template v-if="track.album !== 'Album inconnu'">
                <span class="dash"> — </span>
                <button type="button" class="lcd-link" @click="ui.go({ name: 'album', key: albumKey(track) })">{{ track.album }}</button>
              </template>
            </span>
          </div>
          <div class="times">
            <span>{{ formatDuration(position) }}</span>
            <span>-{{ formatDuration(Math.max(0, duration - position)) }}</span>
          </div>
          <div
            ref="bar"
            class="progress"
            role="slider"
            aria-label="Position dans le morceau"
            :aria-valuemin="0"
            :aria-valuemax="Math.round(duration)"
            :aria-valuenow="Math.round(position)"
            tabindex="0"
            @pointerdown="startSeek"
            @pointermove="moveSeek"
            @pointerup="endSeek"
            @pointercancel="dragging = null"
            @keydown.right.prevent="player.seek(Math.min(duration, position + 5))"
            @keydown.left.prevent="player.seek(Math.max(0, position - 5))"
          >
            <div ref="fill" class="fill" />
          </div>
        </div>
      </template>
      <div v-else class="lcd-idle"><Icon name="note" :size="22" /></div>
    </div>

    <div class="right">
      <div class="volume">
        <button type="button" class="icon-btn" :aria-label="player.volume > 0 ? 'Couper le son' : 'Rétablir le son'" @click="toggleMute">
          <Icon :name="player.volume > 0 ? 'volume' : 'mute'" :size="17" />
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="player.volume"
          :style="{ '--v': `${player.volume * 100}%` }"
          aria-label="Volume"
          @input="player.setVolume(Number(($event.target as HTMLInputElement).value))"
        />
      </div>
      <button type="button" class="icon-btn" :class="{ on: ui.panel === 'lyrics' }" title="Paroles" aria-label="Paroles" :aria-pressed="ui.panel === 'lyrics'" @click="ui.togglePanel('lyrics')">
        <Icon name="lyrics" :size="18" />
      </button>
      <button type="button" class="icon-btn" :class="{ on: ui.panel === 'queue' }" title="À suivre" aria-label="À suivre" :aria-pressed="ui.panel === 'queue'" @click="ui.togglePanel('queue')">
        <Icon name="queue" :size="18" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.player-bar {
  display: grid;
  grid-template-columns: 1fr minmax(380px, 560px) 1fr;
  align-items: center;
  gap: 18px;
  height: 64px;
  padding: 0 18px;
  background: rgba(6, 18, 48, 0.88);
  backdrop-filter: blur(30px) saturate(1.8);
  border-bottom: 1px solid var(--separator);
  position: relative;
  z-index: 5;
}
.transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.icon-btn.big {
  width: 36px;
  height: 36px;
  color: var(--text);
}
.icon-btn.play {
  width: 42px;
  height: 42px;
  color: var(--text);
}
.icon-btn.play:active,
.icon-btn.big:active {
  transform: scale(0.9);
}
.repeat {
  position: relative;
}
.one {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 8px;
  font-weight: 800;
}
.lcd {
  display: flex;
  align-items: stretch;
  height: 48px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.lcd-idle {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.lcd-art {
  position: relative;
  flex: none;
  width: 48px;
  padding: 0;
  border: 0;
  background: none;
}
.lcd-art :deep(.art) {
  border-radius: 0 !important;
  height: 100%;
}
.expand {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.5);
  opacity: 0;
  transition: opacity 0.15s;
}
.lcd-art:hover .expand {
  opacity: 1;
}
.lcd-body {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 14px 4px;
  text-align: center;
}
.lcd-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.lcd-title,
.lcd-sub {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lcd-title {
  font-size: 13px;
  font-weight: 600;
}
.lcd-sub {
  font-size: 12px;
  color: var(--text-2);
}
.lcd-link {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
}
.lcd-link:hover {
  color: var(--text);
  text-decoration: underline;
}
.times {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 5px;
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
}
.lcd:hover .times {
  opacity: 1;
}
.progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.1);
  cursor: pointer;
  outline: none;
}
.progress::before {
  content: "";
  position: absolute;
  inset: -6px 0 0;
}
.lcd:hover .progress {
  height: 5px;
}
.fill {
  height: 100%;
  background: var(--text-2);
  transform-origin: left;
}
.lcd:hover .fill {
  background: var(--accent);
}
.right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
.volume {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-right: 10px;
}
.volume input {
  appearance: none;
  width: 96px;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(to right, var(--text-2) var(--v), rgba(255, 255, 255, 0.15) var(--v));
}
.volume input::-webkit-slider-thumb {
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}
</style>
