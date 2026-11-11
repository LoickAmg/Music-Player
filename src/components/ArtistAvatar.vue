<script setup lang="ts">
import { computed } from "vue";
import { hueFor } from "@/lib/format";
import type { Artist, Track } from "@/lib/types";
import Artwork from "./Artwork.vue";

// Portrait rond d'un artiste : faute de photo, ses pochettes (une seule, ou une mosaïque de
// quatre albums), sinon ses initiales sur un dégradé stable.
const props = withDefaults(defineProps<{ artist: Artist; eager?: boolean }>(), { eager: false });

const covers = computed<Track[]>(() => {
  const out: Track[] = [];
  for (const a of props.artist.albums) {
    if (a.coverTrack && a.coverTrack.has_cover) out.push(a.coverTrack);
    if (out.length === 4) break;
  }
  if (!out.length) {
    const t = props.artist.tracks.find((x) => x.has_cover);
    if (t) out.push(t);
  }
  return out.length >= 4 ? out : out.slice(0, 1);
});
const initials = computed(() =>
  props.artist.name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "♪",
);
const hue = computed(() => hueFor(props.artist.name));
</script>

<template>
  <div class="artist-avatar" :class="{ mosaic: covers.length === 4 }" :style="{ '--h': hue }" role="img" :aria-label="`Portrait de ${artist.name}`">
    <template v-if="covers.length">
      <Artwork v-for="t in covers" :key="t.id" :track="t" :radius="0" :eager="eager" />
    </template>
    <span v-else class="initials">{{ initials }}</span>
  </div>
</template>

<style scoped>
.artist-avatar {
  position: relative;
  width: 100%;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(145deg, hsl(var(--h) 45% 38%), hsl(calc(var(--h) + 40) 50% 18%));
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.32), inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  /* Carré par le remplissage (tient sur les vues web anciennes). */
  isolation: isolate;
}
.artist-avatar::before {
  content: "";
  display: block;
  padding-top: 100%;
}
/* Sans « inset » : absent des vues web d'avant Chrome 87 (Huawei Y9p). */
.artist-avatar > :deep(.art) {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  box-shadow: none;
}
.mosaic > :deep(.art) {
  top: auto;
  right: auto;
  bottom: auto;
  left: auto;
  width: 50%;
}
.mosaic > :deep(.art:nth-child(1)) {
  top: 0;
  left: 0;
}
.mosaic > :deep(.art:nth-child(2)) {
  top: 0;
  right: 0;
}
.mosaic > :deep(.art:nth-child(3)) {
  bottom: 0;
  left: 0;
}
.mosaic > :deep(.art:nth-child(4)) {
  bottom: 0;
  right: 0;
}
.initials {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-size: clamp(14px, 28cqw, 64px);
  font-weight: 700;
  letter-spacing: 0.02em;
  color: rgba(255, 255, 255, 0.86);
}
.artist-avatar {
  container-type: inline-size;
}
</style>
