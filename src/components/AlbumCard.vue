<script setup lang="ts">
import type { Album } from "@/lib/types";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Artwork from "./Artwork.vue";
import Icon from "./Icon.vue";

const props = defineProps<{ album: Album }>();
const player = usePlayerStore();
const ui = useUiStore();

function play() {
  const ids = props.album.tracks.map((t) => t.id);
  void player.playQueue(ids, ids[0]);
}
</script>

<template>
  <div class="album-card">
    <button type="button" class="cover" :aria-label="`Ouvrir ${album.title}`" @click="ui.go({ name: 'album', key: album.key })">
      <Artwork :track="album.coverTrack" :label="album.title" :radius="3" />
      <span class="play" role="button" :aria-label="`Lire ${album.title}`" @click.stop="play">
        <Icon name="play" :size="16" />
      </span>
    </button>
    <button type="button" class="title" @click="ui.go({ name: 'album', key: album.key })">{{ album.title }}</button>
    <button type="button" class="artist" @click="ui.go({ name: 'artists', artist: album.artist })">{{ album.artist }}</button>
  </div>
</template>

<style scoped>
.album-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.cover {
  position: relative;
  padding: 0;
  border: 0;
  background: none;
  border-radius: 3px;
  transition: transform 0.25s var(--ease);
}
.cover:hover {
  transform: translate(-3px, -3px) rotate(-1.2deg);
}
.cover:hover :deep(.art) {
  box-shadow: 6px 6px 0 var(--cyan), 0 16px 30px rgba(0, 4, 20, 0.6);
}
.play {
  position: absolute;
  left: 10px;
  bottom: 10px;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  clip-path: polygon(20% 0, 100% 0, 80% 100%, 0 100%);
  width: 42px !important;
  background: rgba(4, 16, 46, 0.85);
  backdrop-filter: blur(10px);
  color: #fff;
  opacity: 0;
  transform: scale(0.9);
  transition: opacity 0.2s, transform 0.2s var(--ease), background 0.2s;
}
.cover:hover .play {
  opacity: 1;
  transform: none;
}
.play:hover {
  background: var(--cyan);
  color: var(--ink);
}
.title,
.artist {
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title {
  margin-top: 9px;
  font-family: var(--font-display);
  font-style: italic;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.artist {
  font-size: 12.5px;
  color: var(--text-2);
}
.artist:hover {
  text-decoration: underline;
}
</style>
