<script setup lang="ts">
import { computed, watch } from "vue";
import { themeFor, titleScale } from "@/lib/playlistThemes";
import type { PlaylistStyle } from "@/lib/types";
import { useAppearanceStore } from "@/stores/appearance";

// Jaquette d'une playlist : dégradé du thème choisi (motif au choix) ou image de
// l'utilisateur recadrée, et le nom de la playlist dans la police, la couleur, la taille et
// la position choisies. Toutes les tailles se calculent en unités de conteneur : la même
// jaquette sert de vignette comme de grande pochette.
const props = withDefaults(
  defineProps<{
    name: string;
    theme?: string | null;
    styling?: PlaylistStyle | null;
    /** Image pas encore enregistrée (aperçu dans la fenêtre de personnalisation). */
    imageUrl?: string | null;
    radius?: number;
    mini?: boolean;
  }>(),
  { theme: null, styling: null, imageUrl: null, radius: 10, mini: false },
);

const appearance = useAppearanceStore();
const t = computed(() => themeFor(props.theme));
const st = computed<PlaylistStyle>(() => props.styling ?? {});
const scale = computed(() => titleScale(props.name) * (st.value.size ?? 1));
const initial = computed(() => props.name.trim().charAt(0).toUpperCase() || "♪");
const image = computed(() => props.imageUrl ?? (st.value.image ? appearance.assetUrl(st.value.image) : null));
const pattern = computed(() => st.value.pattern ?? "rings");
const showName = computed(() => st.value.showName !== false);
const ink = computed(() => st.value.ink || (image.value ? "#fff" : t.value.ink));

watch(
  () => st.value.font,
  (font) => void appearance.loadFont(font),
  { immediate: true },
);

const nameStyle = computed(() => ({
  fontFamily: st.value.font ? appearance.fontStackFor(st.value.font) : undefined,
  textTransform: st.value.uppercase ? ("uppercase" as const) : undefined,
  textAlign: st.value.align === "center" ? ("center" as const) : st.value.align === "end" ? ("right" as const) : undefined,
}));
const photoStyle = computed(() => {
  const x = st.value.imageX ?? 50;
  const y = st.value.imageY ?? 50;
  return {
    objectPosition: `${x}% ${y}%`,
    transform: `scale(${st.value.imageZoom ?? 1})`,
    transformOrigin: `${x}% ${y}%`,
  };
});
</script>

<template>
  <div
    class="pl-cover"
    :class="[{ mini, photo: !!image }, `pat-${pattern}`, `place-${st.place ?? 'bottom'}`]"
    :style="{ background: image ? '#111' : t.background, color: ink, borderRadius: `${radius}px`, '--glow': t.glow, '--fs': `${scale}cqw`, '--dim': st.dim ?? 0.35 }"
    role="img"
    :aria-label="`Jaquette de la playlist ${name}`"
  >
    <template v-if="image">
      <img class="photo-img" :src="image" alt="" draggable="false" :style="photoStyle" />
      <span v-if="showName && !mini" class="shade" />
    </template>
    <template v-else>
      <span v-if="pattern === 'rings'" class="orb o1" />
      <span v-if="pattern === 'rings'" class="orb o2" />
      <span class="motif" />
    </template>
    <template v-if="mini">
      <span v-if="!image" class="initial" :style="nameStyle">{{ initial }}</span>
    </template>
    <template v-else-if="showName">
      <span class="kicker">Playlist</span>
      <span class="name" :style="nameStyle">{{ name }}</span>
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
.photo-img {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: -2;
  user-select: none;
  pointer-events: none;
}
/* Voile sous le nom : lisible quelle que soit l'image. */
.shade {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: -1;
  background: linear-gradient(to top, rgba(0, 0, 0, var(--dim)) 0%, rgba(0, 0, 0, calc(var(--dim) * 0.4)) 45%, transparent 75%);
}
.place-top .shade {
  background: linear-gradient(to bottom, rgba(0, 0, 0, var(--dim)) 0%, rgba(0, 0, 0, calc(var(--dim) * 0.4)) 45%, transparent 75%);
}
.place-middle .shade {
  background: rgba(0, 0, 0, calc(var(--dim) * 0.8));
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
.motif {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: -1;
  mix-blend-mode: soft-light;
}
.pat-rings .motif {
  background: repeating-radial-gradient(circle at 100% 0%, transparent 0 7cqw, rgba(255, 255, 255, 0.07) 7cqw 7.4cqw);
}
.pat-dots .motif {
  background: radial-gradient(circle, rgba(255, 255, 255, 0.35) 0.9cqw, transparent 1.1cqw) 0 0 / 7cqw 7cqw;
}
.pat-stripes .motif {
  background: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.16) 0 2.5cqw, transparent 2.5cqw 7cqw);
}
.pat-grid .motif {
  background:
    linear-gradient(rgba(255, 255, 255, 0.18) 0.3cqw, transparent 0.3cqw) 0 0 / 10cqw 10cqw,
    linear-gradient(90deg, rgba(255, 255, 255, 0.18) 0.3cqw, transparent 0.3cqw) 0 0 / 10cqw 10cqw;
}
.pat-waves .motif {
  background:
    radial-gradient(circle at 50% 100%, transparent 9cqw, rgba(255, 255, 255, 0.22) 9.3cqw 10.3cqw, transparent 10.6cqw) 0 0 / 20cqw 10cqw;
}
.pat-stars .motif {
  mix-blend-mode: normal;
  background:
    radial-gradient(circle at 12% 18%, rgba(255, 255, 255, 0.9) 0.35cqw, transparent 0.6cqw),
    radial-gradient(circle at 78% 12%, rgba(255, 255, 255, 0.7) 0.3cqw, transparent 0.55cqw),
    radial-gradient(circle at 62% 46%, rgba(255, 255, 255, 0.8) 0.4cqw, transparent 0.7cqw),
    radial-gradient(circle at 30% 62%, rgba(255, 255, 255, 0.6) 0.3cqw, transparent 0.5cqw),
    radial-gradient(circle at 88% 70%, rgba(255, 255, 255, 0.75) 0.35cqw, transparent 0.6cqw),
    radial-gradient(circle at 45% 88%, rgba(255, 255, 255, 0.5) 0.25cqw, transparent 0.45cqw),
    radial-gradient(circle at 20% 40%, rgba(255, 255, 255, 0.45) 0.2cqw, transparent 0.4cqw),
    radial-gradient(circle at 70% 28%, rgba(255, 255, 255, 0.4) 0.2cqw, transparent 0.4cqw);
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
  line-height: 1.08;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}
.photo .name,
.photo .kicker {
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
}
.place-top .kicker {
  top: auto;
  bottom: 8cqw;
}
.place-top .name {
  bottom: auto;
  top: 8cqw;
}
.place-middle .name {
  bottom: auto;
  top: 50%;
  translate: 0 -50%;
}
.initial {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  place-items: center;
  font-family: var(--font-display);
  font-size: 58cqw;
  font-weight: 800;
}
.mini .motif,
.mini .o2 {
  display: none;
}
</style>
