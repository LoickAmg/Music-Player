<script setup lang="ts">
import { computed } from "vue";
import { themeFor, titleScale } from "@/lib/playlistThemes";

// Jaquette générée d'une playlist : fond du thème choisi, motifs lumineux discrets et le
// nom de la playlist en grand. Toutes les tailles se calculent en unités de conteneur,
// la même jaquette sert donc de vignette comme de grande pochette.
const props = withDefaults(defineProps<{ name: string; theme?: string | null; radius?: number; mini?: boolean }>(), {
  theme: null,
  radius: 10,
  mini: false,
});

const t = computed(() => themeFor(props.theme));
const scale = computed(() => titleScale(props.name));
const initial = computed(() => props.name.trim().charAt(0).toUpperCase() || "♪");
</script>

<template>
  <div
    class="pl-cover"
    :class="{ mini }"
    :style="{ background: t.background, color: t.ink, borderRadius: `${radius}px`, '--glow': t.glow, '--fs': `${scale}cqw` }"
    role="img"
    :aria-label="`Jaquette de la playlist ${name}`"
  >
    <span class="orb o1" />
    <span class="orb o2" />
    <span class="rings" />
    <template v-if="mini">
      <span class="initial">{{ initial }}</span>
    </template>
    <template v-else>
      <span class="kicker">Playlist</span>
      <span class="name">{{ name }}</span>
    </template>
  </div>
</template>

<style scoped>
.pl-cover {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  container-type: inline-size;
  isolation: isolate;
  text-align: left;
  box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.12);
}
.orb {
  position: absolute;
  border-radius: 50%;
  background: radial-gradient(circle, var(--glow), transparent 68%);
  opacity: 0.45;
  z-index: -1;
}
.o1 {
  width: 90cqw;
  height: 90cqw;
  top: -38cqw;
  right: -30cqw;
}
.o2 {
  width: 60cqw;
  height: 60cqw;
  bottom: -26cqw;
  left: -18cqw;
  opacity: 0.25;
}
.rings {
  position: absolute;
  inset: 0;
  z-index: -1;
  background: repeating-radial-gradient(circle at 100% 0%, transparent 0 7cqw, rgba(255, 255, 255, 0.07) 7cqw 7.4cqw);
  mix-blend-mode: soft-light;
}
.kicker {
  position: absolute;
  top: 8cqw;
  left: 8cqw;
  font-size: 5.2cqw;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.75;
}
.name {
  position: absolute;
  left: 8cqw;
  right: 8cqw;
  bottom: 7cqw;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-family: var(--font-display);
  font-size: var(--fs);
  font-weight: 800;
  line-height: 1.02;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}
.initial {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-size: 58cqw;
  font-weight: 800;
}
.mini .rings,
.mini .o2 {
  display: none;
}
</style>
