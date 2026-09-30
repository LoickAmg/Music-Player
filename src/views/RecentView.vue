<script setup lang="ts">
import { computed } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import AlbumCard from "@/components/AlbumCard.vue";
import TrackRow from "@/components/TrackRow.vue";

const library = useLibraryStore();
const player = usePlayerStore();
const ui = useUiStore();

const recentAlbums = computed(() =>
  [...library.albums].filter((a) => a.tracks.length > 1).sort((a, b) => b.addedSecs - a.addedSecs).slice(0, 18),
);
const recentTracks = computed(() => [...library.tracks].sort((a, b) => b.added_secs - a.added_secs).slice(0, 40));

function play(index: number) {
  const ids = recentTracks.value.map((t) => t.id);
  void player.playQueue(ids, ids[index]);
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Ajouts récents</h1>

    <section v-if="recentAlbums.length">
      <div class="head">
        <h2>Albums</h2>
        <button type="button" class="more" @click="ui.go({ name: 'albums' })">Tout afficher</button>
      </div>
      <div class="grid">
        <AlbumCard v-for="album in recentAlbums" :key="album.key" :album="album" />
      </div>
    </section>

    <section>
      <div class="head">
        <h2>Morceaux</h2>
        <button type="button" class="more" @click="ui.go({ name: 'songs' })">Tout afficher</button>
      </div>
      <div class="list">
        <div v-for="(track, i) in recentTracks" :key="track.id" class="row">
          <TrackRow :track="track" :index="i" striped @play="play(i)" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
section {
  margin-bottom: 34px;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 700;
}
.more {
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 22px;
}
.row {
  height: 52px;
}
@media (max-width: 760px) {
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 14px;
  }
}
</style>
