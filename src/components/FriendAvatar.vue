<script setup lang="ts">
import { computed } from "vue";
import { hueFor } from "@/lib/format";

// Photo d'un proche, ou ses initiales sur une couleur tirée de son nom.
const props = withDefaults(defineProps<{ name: string; src?: string | null; size?: number; live?: boolean }>(), {
  src: null,
  size: 40,
  live: false,
});
const initials = computed(
  () =>
    props.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?",
);
</script>

<template>
  <span class="avatar" :class="{ live }" :style="{ width: `${size}px`, height: `${size}px`, '--h': hueFor(name) }">
    <img v-if="src" :src="src" alt="" />
    <span v-else :style="{ fontSize: `${Math.round(size * 0.38)}px` }">{{ initials }}</span>
  </span>
</template>

<style scoped>
.avatar {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: hsl(var(--h) 55% 42%);
  color: #fff;
  font-weight: 700;
  overflow: hidden;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar.live {
  overflow: visible;
  box-shadow: 0 0 0 2px var(--accent);
}
.avatar.live img {
  border-radius: 50%;
}
</style>
