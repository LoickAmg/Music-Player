<script setup lang="ts">
import { computed } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import AlbumCard from "@/components/AlbumCard.vue";
import TrackRow from "@/components/TrackRow.vue";

const props = defineProps<{ query: string }>();
const library = useLibraryStore();
const player = usePlayerStore();
const ui = useUiStore();

const results = computed(() => library.search(props.query));
const empty = computed(() => !results.value.tracks.length && !results.value.albums.length && !results.value.artists.length);

function play(index: number) {
  const ids = results.value.tracks.map((t) => t.id);
  void player.playQueue(ids, ids[index]);
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Résultats pour « {{ query }} »</h1>
    <p v-if="empty" class="muted">Aucun résultat dans votre bibliothèque.</p>

    <section v-if="results.artists.length">
      <h2>Artistes</h2>
      <div class="chips">
        <button v-for="name in results.artists" :key="name" type="button" class="chip" @click="ui.go({ name: 'artists', artist: name })">{{ name }}</button>
      </div>
    </section>

    <section v-if="results.albums.length">
      <h2>Albums</h2>
      <div class="grid">
        <AlbumCard v-for="album in results.albums" :key="album.key" :album="album" />
      </div>
    </section>

    <section v-if="results.tracks.length">
      <h2>Morceaux</h2>
      <div v-for="(track, i) in results.tracks" :key="track.id" class="row">
        <TrackRow :track="track" :index="i" striped @play="play(i)" />
      </div>
    </section>
  </div>
</template>

<style scoped>
section {
  margin-bottom: 30px;
}
h2 {
  margin: 0 0 12px;
  font-family: var(--font-display);
  font-size: 18px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 16px;
  background: var(--bg-active);
  font-size: 13px;
}
.chip:hover {
  background: var(--accent);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 20px;
}
.row {
  height: 52px;
}
</style>
