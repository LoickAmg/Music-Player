<script setup lang="ts">
import { computed } from "vue";
import { formatCollection } from "@/lib/format";
import { useFavoritesStore } from "@/stores/favorites";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import Icon from "@/components/Icon.vue";
import TrackRow from "@/components/TrackRow.vue";
import VirtualList from "@/components/VirtualList.vue";

const library = useLibraryStore();
const favorites = useFavoritesStore();
const player = usePlayerStore();

// Les plus récemment aimés en premier : l'ordre n'est pas gardé côté Rust (un simple
// ensemble), donc on retombe sur l'ordre de la bibliothèque, le plus stable disponible.
const tracks = computed(() => library.tracks.filter((t) => favorites.isFavorite(t.id)));
const totalDuration = computed(() => tracks.value.reduce((s, t) => s + t.duration_secs, 0));

function play(index: number) {
  const ids = tracks.value.map((t) => t.id);
  void player.playQueue(ids, ids[index]);
}
</script>

<template>
  <div class="page">
    <div class="top">
      <div>
        <h1 class="page-title">Titres aimés</h1>
        <p class="muted count">{{ formatCollection(tracks.length, totalDuration) }}</p>
      </div>
      <button v-if="tracks.length" type="button" class="pill pill-ghost" @click="player.playShuffled(tracks.map((t) => t.id))">
        <Icon name="shuffle" :size="15" /> Tout en aléatoire
      </button>
    </div>
    <p v-if="!tracks.length" class="empty">
      Aucun morceau aimé pour l'instant : touchez le cœur dans le menu d'un morceau (clic droit, ou « ⋯ »).
    </p>
    <VirtualList v-else :items="tracks" :row-height="52">
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
.empty {
  margin-top: 8px;
  color: var(--text-2);
}
</style>
