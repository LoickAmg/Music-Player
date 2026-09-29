<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { coverUrl } from "@/lib/covers";
import { hueFor } from "@/lib/format";
import type { Track } from "@/lib/types";
import Icon from "./Icon.vue";

// Pochette chargée seulement quand elle entre à l'écran ; à défaut, un dégradé stable
// calculé à partir du nom (comme les albums sans pochette d'Apple Music).
const props = withDefaults(
  defineProps<{ track: Track | null; label?: string; radius?: number; eager?: boolean }>(),
  { label: "", radius: 6, eager: false },
);

const root = ref<HTMLElement | null>(null);
const src = ref<string | null>(null);
const loaded = ref(false);
let observer: IntersectionObserver | null = null;
let token = 0;

async function load() {
  const current = ++token;
  src.value = null;
  loaded.value = false;
  const url = await coverUrl(props.track);
  if (current === token) src.value = url;
}

function observe() {
  if (props.eager || !("IntersectionObserver" in window)) {
    void load();
    return;
  }
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer?.disconnect();
        void load();
      }
    },
    { rootMargin: "300px" },
  );
  if (root.value) observer.observe(root.value);
}

onMounted(observe);
onBeforeUnmount(() => observer?.disconnect());
watch(
  () => props.track?.id,
  () => observe(),
);

const fallback = computed(() => {
  // Teintes restreintes aux bleus et cyans de la palette.
  const hue = 195 + (hueFor(props.label || props.track?.album || props.track?.title || "?") % 50);
  return `linear-gradient(145deg, hsl(${hue} 70% 38%), hsl(${hue + 20} 80% 14%))`;
});
</script>

<template>
  <div ref="root" class="art" :style="{ borderRadius: `${radius}px`, background: fallback }">
    <Icon v-if="!src" name="note" :size="28" class="glyph" />
    <img v-if="src" :src="src" alt="" draggable="false" :class="{ loaded }" @load="loaded = true" @error="src = null" />
  </div>
</template>

<style scoped>
.art {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), inset 0 0 0 0.5px rgba(255, 255, 255, 0.08);
}
.glyph {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 34%;
  height: 34%;
  color: rgba(255, 255, 255, 0.45);
}
img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.35s var(--ease);
}
img.loaded {
  opacity: 1;
}
</style>
