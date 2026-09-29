<script setup lang="ts">
import { computed, ref } from "vue";
import { collator } from "@/lib/format";
import { useLibraryStore } from "@/stores/library";
import AlbumCard from "@/components/AlbumCard.vue";
import VirtualGrid from "@/components/VirtualGrid.vue";

const library = useLibraryStore();
type Sort = "artist" | "title" | "recent" | "year";
const sort = ref<Sort>("artist");
const sorts: { id: Sort; label: string }[] = [
  { id: "artist", label: "Artiste" },
  { id: "title", label: "Titre" },
  { id: "recent", label: "Ajout récent" },
  { id: "year", label: "Année" },
];

const albums = computed(() => {
  const list = [...library.albums];
  switch (sort.value) {
    case "title":
      return list.sort((a, b) => collator.compare(a.title, b.title));
    case "recent":
      return list.sort((a, b) => b.addedSecs - a.addedSecs);
    case "year":
      return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || collator.compare(a.artist, b.artist));
    default:
      return list;
  }
});
</script>

<template>
  <div class="page">
    <div class="top">
      <h1 class="page-title">Albums</h1>
      <div class="sorts" role="group" aria-label="Trier par">
        <button v-for="s in sorts" :key="s.id" type="button" :class="{ on: sort === s.id }" @click="sort = s.id">{{ s.label }}</button>
      </div>
    </div>
    <p v-if="!albums.length" class="muted">Aucun album : les morceaux sans album figurent dans « Morceaux ».</p>
    <VirtualGrid :items="albums" :min-width="170" :gap="24" :extra="46">
      <template #default="{ item }">
        <AlbumCard :album="item" />
      </template>
    </VirtualGrid>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.sorts {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
}
.sorts button {
  height: 26px;
  padding: 0 11px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-2);
  font-size: 12.5px;
}
.sorts button.on {
  background: rgba(255, 255, 255, 0.14);
  color: var(--text);
}
</style>
