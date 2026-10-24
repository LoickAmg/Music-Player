<script setup lang="ts">
import RecapBanner from "@/components/RecapBanner.vue";
import { computed } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";
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
    <button v-if="library.voices.length" type="button" class="voices-link" @click="ui.go({ name: 'voices' })">
      <Icon name="mic" :size="18" />
      <span>
        <strong>Vocaux et enregistrements</strong>
        <small>{{ library.voices.length }} fichier{{ library.voices.length > 1 ? "s" : "" }} rangé{{ library.voices.length > 1 ? "s" : "" }} à part de la musique</small>
      </span>
      <span class="chev" aria-hidden="true">›</span>
    </button>

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
.voices-link {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin: 0 0 24px;
  padding: 12px 14px;
  border: 0;
  border-radius: 12px;
  background: rgba(var(--fg-rgb), 0.06);
  color: var(--text);
  text-align: left;
}
.voices-link:hover {
  background: rgba(var(--fg-rgb), 0.1);
}
.voices-link > :first-child {
  color: var(--accent);
}
.voices-link span:not(.chev) {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.voices-link strong {
  font-size: 14px;
}
.voices-link small {
  font-size: 12px;
  color: var(--text-2);
}
.chev {
  font-size: 20px;
  color: var(--text-2);
}
</style>
