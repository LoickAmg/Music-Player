<script setup lang="ts">
import RecapBanner from "@/components/RecapBanner.vue";
import { computed } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import TrackRow from "@/components/TrackRow.vue";

const library = useLibraryStore();
const player = usePlayerStore();
const ui = useUiStore();

// Les vrais ajouts récents, piste par piste : un album bucketé par sa piste la plus
// récente montrait tout un album ancien dès qu'un seul morceau y était ajouté ou retouché.
const recentTracks = computed(() => [...library.tracks].sort((a, b) => b.added_secs - a.added_secs).slice(0, 60));

function play(index: number) {
  const ids = recentTracks.value.map((t) => t.id);
  void player.playQueue(ids, ids[index]);
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Ajouts récents</h1>
    <RecapBanner />

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
.row {
  height: 52px;
}
</style>
