<script setup lang="ts">
import { computed, ref } from "vue";
import { collator, formatCollection } from "@/lib/format";
import type { Track } from "@/lib/types";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import Icon from "@/components/Icon.vue";
import TrackRow from "@/components/TrackRow.vue";
import VirtualList from "@/components/VirtualList.vue";

const library = useLibraryStore();
const player = usePlayerStore();

type Key = "title" | "artist" | "album" | "duration";
const sortKey = ref<Key>("title");
const ascending = ref(true);

const comparators: Record<Key, (a: Track, b: Track) => number> = {
  title: (a, b) => collator.compare(a.title, b.title),
  artist: (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title),
  album: (a, b) => collator.compare(a.album, b.album) || (a.track_no ?? 0) - (b.track_no ?? 0),
  duration: (a, b) => a.duration_secs - b.duration_secs,
};

const tracks = computed(() => {
  const sorted = [...library.tracks].sort(comparators[sortKey.value]);
  return ascending.value ? sorted : sorted.reverse();
});

function sortBy(key: Key) {
  if (sortKey.value === key) ascending.value = !ascending.value;
  else {
    sortKey.value = key;
    ascending.value = true;
  }
}

function play(index: number) {
  const ids = tracks.value.map((t) => t.id);
  void player.playQueue(ids, ids[index]);
}
</script>

<template>
  <div class="page">
    <div class="top">
      <div>
        <h1 class="page-title">Morceaux</h1>
        <p class="muted count">{{ formatCollection(library.tracks.length, library.totalDuration) }}</p>
      </div>
      <button type="button" class="pill pill-ghost" @click="player.playShuffled(tracks.map((t) => t.id))">
        <Icon name="shuffle" :size="15" /> Tout en aléatoire
      </button>
    </div>
    <div class="header" role="row">
      <span />
      <button v-for="col in (['title', 'artist', 'album', 'duration'] as const)" :key="col" type="button" :class="[col, { on: sortKey === col }]" @click="sortBy(col)">
        {{ { title: "Titre", artist: "Artiste", album: "Album", duration: "Durée" }[col] }}
        <span v-if="sortKey === col" class="arrow">{{ ascending ? "▲" : "▼" }}</span>
      </button>
      <span />
    </div>
    <VirtualList :items="tracks" :row-height="52">
      <template #default="{ item, index }">
        <TrackRow :track="item" :index="index" striped @play="play(index)" />
      </template>
    </VirtualList>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.count {
  margin: -16px 0 18px;
  font-size: 12.5px;
}
.header {
  position: sticky;
  top: -1px;
  z-index: 2;
  display: grid;
  grid-template-columns: 44px minmax(0, 2.2fr) minmax(0, 1.4fr) minmax(0, 1.4fr) 56px 32px;
  gap: 12px;
  padding: 8px 10px;
  background: var(--bg-content);
  border-bottom: 1px solid var(--separator);
}
.header button {
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.header button.on {
  color: var(--text);
}
.header .duration {
  text-align: right;
}
.arrow {
  font-size: 8px;
  margin-left: 3px;
}
</style>
