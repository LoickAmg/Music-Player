<script setup lang="ts">
import { computed } from "vue";
import { formatDuration } from "@/lib/format";
import type { Track } from "@/lib/types";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Artwork from "./Artwork.vue";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    track: Track;
    index: number;
    variant?: "album" | "songs" | "playlist";
    playlistId?: string;
    striped?: boolean;
  }>(),
  { variant: "songs", playlistId: undefined, striped: false },
);
const emit = defineEmits<{ (e: "play"): void }>();

const player = usePlayerStore();
const ui = useUiStore();

const isCurrent = computed(() => player.currentTrack?.id === props.track.id);

function openMenu(event: MouseEvent) {
  ui.menu = { x: event.clientX, y: event.clientY, trackId: props.track.id, playlistId: props.playlistId };
}
</script>

<template>
  <div
    class="track-row"
    :class="[variant, { current: isCurrent, striped: striped && index % 2 === 1 }]"
    role="row"
    tabindex="0"
    @dblclick="emit('play')"
    @click="ui.isMobile && emit('play')"
    @keydown.enter="emit('play')"
    @contextmenu.prevent="openMenu"
  >
    <div class="lead">
      <template v-if="variant === 'album'">
        <span v-if="isCurrent && !player.isPaused" class="bars" aria-label="En cours de lecture"><i /><i /><i /></span>
        <span v-else class="num">{{ track.track_no ?? index + 1 }}</span>
      </template>
      <div v-else class="thumb">
        <Artwork :track="track" :radius="4" />
        <span v-if="isCurrent && !player.isPaused" class="bars over"><i /><i /><i /></span>
      </div>
      <button class="play-hover" type="button" :aria-label="`Lire ${track.title}`" @click.stop="emit('play')">
        <Icon name="play" :size="14" />
      </button>
    </div>
    <div class="title">
      <span class="t">{{ track.title }}</span>
      <span v-if="variant === 'album' && track.artist !== track.album_artist" class="sub">{{ track.artist }}</span>
      <span v-else-if="variant !== 'album'" class="sub mobile-only">{{ track.artist }}</span>
    </div>
    <button v-if="variant !== 'album'" type="button" class="link artist" @click.stop="ui.go({ name: 'artists', artist: track.artist })">
      {{ track.artist }}
    </button>
    <button
      v-if="variant !== 'album'"
      type="button"
      class="link album"
      :disabled="track.album === 'Album inconnu'"
      @click.stop="ui.go({ name: 'album', key: `${track.album_artist.toLowerCase()}\u0000${track.album.toLowerCase()}` })"
    >
      {{ track.album === "Album inconnu" ? "—" : track.album }}
    </button>
    <span class="dur">{{ formatDuration(track.duration_secs) }}</span>
    <button class="more" type="button" aria-label="Plus d'options" @click.stop="openMenu">
      <Icon name="more" :size="18" />
    </button>
  </div>
</template>

<style scoped>
.track-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 2.2fr) minmax(0, 1.4fr) minmax(0, 1.4fr) 56px 32px;
  align-items: center;
  gap: 12px;
  height: 100%;
  padding: 0 10px;
  border-radius: 6px;
  color: var(--text);
  outline: none;
}
.track-row.album {
  grid-template-columns: 32px minmax(0, 1fr) 56px 32px;
}
.track-row.striped {
  background: rgba(255, 255, 255, 0.025);
}
.track-row:hover,
.track-row:focus-visible {
  background: var(--bg-hover);
}
.track-row.current .t,
.track-row.current .num {
  color: var(--accent);
}
.lead {
  position: relative;
  display: grid;
  place-items: center;
}
.num {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}
.thumb {
  position: relative;
  width: 36px;
}
.play-hover {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text);
  opacity: 0;
}
.variant-songs .play-hover,
.songs .play-hover,
.playlist .play-hover {
  background: rgba(0, 0, 0, 0.55);
}
.track-row:hover .play-hover {
  opacity: 1;
}
.track-row:hover .num,
.track-row:hover .bars:not(.over) {
  visibility: hidden;
}
.title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.t,
.sub,
.link {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.t {
  font-size: 13.5px;
}
.sub {
  font-size: 12px;
  color: var(--text-2);
}
.link {
  border: 0;
  padding: 0;
  background: none;
  text-align: left;
  color: var(--text-2);
  font-size: 13px;
}
.link:hover:not(:disabled) {
  color: var(--text);
  text-decoration: underline;
}
.link:disabled {
  cursor: default;
}
.dur {
  color: var(--text-2);
  font-size: 13px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.more {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--accent);
  opacity: 0;
}
.track-row:hover .more,
.more:focus-visible {
  opacity: 1;
}
.bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}
.bars.over {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 14px;
  padding: 0;
  filter: drop-shadow(0 0 2px #000);
}
/* Animation de « transform » (gérée par le processeur graphique) plutôt que de hauteur, qui
   recalculait la mise en page à chaque image pendant toute la lecture. */
.bars i {
  width: 3px;
  height: 12px;
  background: var(--accent);
  border-radius: 1px;
  transform-origin: bottom;
  animation: bar 0.9s ease-in-out infinite alternate;
}
:root[data-perf="lite"] .bars i {
  animation: none;
  transform: scaleY(0.6);
}
.bars i:nth-child(2) {
  animation-delay: -0.4s;
}
.bars i:nth-child(3) {
  animation-delay: -0.7s;
}
@keyframes bar {
  from {
    transform: scaleY(0.25);
  }
  to {
    transform: scaleY(1);
  }
}
.mobile-only {
  display: none;
}
@media (max-width: 760px) {
  .track-row,
  .track-row.album {
    grid-template-columns: 44px minmax(0, 1fr) 40px;
    gap: 10px;
    padding: 0 4px;
  }
  .track-row.album {
    grid-template-columns: 28px minmax(0, 1fr) 40px;
  }
  .link.artist,
  .link.album,
  .dur,
  .play-hover {
    display: none !important;
  }
  .mobile-only {
    display: block;
  }
  .more {
    opacity: 1 !important;
    width: 40px;
    height: 40px;
  }
}
</style>
