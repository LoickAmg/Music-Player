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
      <Artwork :track="album.coverTrack" :label="album.title" :radius="8" />
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
  border-radius: 8px;
  transition: transform 0.25s var(--ease);
}
.cover:hover {
  transform: translateY(-2px);
}
.cover:hover :deep(.art) {
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
}
.play {
  position: absolute;
  left: 10px;
  bottom: 10px;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(5, 16, 44, 0.72);
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
  background: var(--accent);
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
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
}
.artist {
  font-size: 12.5px;
  color: var(--text-2);
}
.artist:hover {
  text-decoration: underline;
}
</style>
