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

type Key = "title" | "artist" | "album" | "duration" | "added";
const sortKey = ref<Key>("title");
const ascending = ref(true);

const comparators: Record<Key, (a: Track, b: Track) => number> = {
  title: (a, b) => collator.compare(a.title, b.title),
  artist: (a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title),
  album: (a, b) => collator.compare(a.album, b.album) || (a.track_no ?? 0) - (b.track_no ?? 0),
  duration: (a, b) => a.duration_secs - b.duration_secs,
  added: (a, b) => a.added_secs - b.added_secs || collator.compare(a.title, b.title),
};

// Tris proposés dans le menu (téléphone compris, où les en-têtes de colonnes sont masqués).
const SORTS: { id: string; label: string; key: Key; ascending: boolean }[] = [
  { id: "title", label: "Titre (A-Z)", key: "title", ascending: true },
  { id: "title-desc", label: "Titre (Z-A)", key: "title", ascending: false },
  { id: "recent", label: "Plus récents", key: "added", ascending: false },
  { id: "oldest", label: "Plus anciens", key: "added", ascending: true },
  { id: "artist", label: "Artiste (A-Z)", key: "artist", ascending: true },
  { id: "album", label: "Album (A-Z)", key: "album", ascending: true },
  { id: "duration", label: "Durée", key: "duration", ascending: true },
];
const sortId = computed({
  get: () => SORTS.find((s) => s.key === sortKey.value && s.ascending === ascending.value)?.id ?? "",
  set: (id: string) => {
    const s = SORTS.find((x) => x.id === id);
    if (!s) return;
    sortKey.value = s.key;
    ascending.value = s.ascending;
  },
});

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
        <p class="page-sub">{{ formatCollection(library.tracks.length, library.totalDuration) }}</p>
      </div>
      <div class="top-actions">
        <label class="sort">
          <span class="muted">Trier</span>
          <select v-model="sortId" class="fieldbox" aria-label="Trier les morceaux">
            <option v-if="!sortId" value="" disabled>Personnalisé</option>
            <option v-for="s in SORTS" :key="s.id" :value="s.id">{{ s.label }}</option>
          </select>
        </label>
        <button type="button" class="pill pill-ghost" @click="player.playShuffled(tracks.map((t) => t.id))">
          <Icon name="shuffle" :size="15" /> Tout en aléatoire
        </button>
      </div>
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
.top-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
.sort {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 13px;
}
.sort select {
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: var(--bg-active);
  color: var(--text);
  font-size: 13px;
}
.top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
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
@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .top {
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .top-actions {
    justify-content: flex-start;
  }
  .header {
    display: none;
  }
}
</style>
