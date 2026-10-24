<script setup lang="ts">
import { computed, ref } from "vue";
import { useFrame } from "@/lib/clock";
import { formatDuration } from "@/lib/format";
import { usePlayerStore } from "@/stores/player";

// Barre de progression : avance à chaque image, curseur et heure visée au survol (souris)
// ou pendant le glisser (doigt), saut au relâchement ; flèches ±5 s, Début et Fin au clavier.
// « hero » : écran « À l'écoute » ; « lcd » : fine ligne au bas de l'afficheur de la barre.
withDefaults(defineProps<{ variant?: "hero" | "lcd" }>(), { variant: "hero" });
const emit = defineEmits<{ (e: "dragging", value: number | null): void }>();

const player = usePlayerStore();
const duration = computed(() => player.currentTrack?.duration_secs ?? 0);
const dragging = ref<number | null>(null);
/** Survol à la souris : position (0 à 1) et heure correspondante. */
const hover = ref<number | null>(null);

const track = ref<HTMLElement | null>(null);
const fill = ref<HTMLElement | null>(null);
const knob = ref<HTMLElement | null>(null);

function paint(pos: number) {
  const ratio = duration.value ? Math.min(1, Math.max(0, pos / duration.value)) : 0;
  if (fill.value) fill.value.style.transform = `scaleX(${ratio})`;
  if (knob.value) knob.value.style.left = `${ratio * 100}%`;
}
useFrame((t) => paint(dragging.value ?? player.positionAt(t)));

function ratioOf(e: PointerEvent): number {
  const rect = track.value!.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}
function down(e: PointerEvent) {
  if (!duration.value) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragging.value = ratioOf(e) * duration.value;
  emit("dragging", dragging.value);
  paint(dragging.value);
}
function move(e: PointerEvent) {
  if (e.pointerType === "mouse") hover.value = ratioOf(e);
  if (dragging.value === null) return;
  dragging.value = ratioOf(e) * duration.value;
  emit("dragging", dragging.value);
  paint(dragging.value);
}
async function up() {
  if (dragging.value === null) return;
  const target = dragging.value;
  await player.seek(target);
  dragging.value = null;
  emit("dragging", null);
}
function cancel() {
  dragging.value = null;
  emit("dragging", null);
}
function key(e: KeyboardEvent) {
  const pos = player.positionAt(performance.now());
  const jumps: Record<string, number> = { ArrowRight: pos + 5, ArrowLeft: pos - 5, Home: 0, End: duration.value - 1 };
  if (!(e.key in jumps) || !duration.value) return;
  e.preventDefault();
  void player.seek(Math.min(duration.value, Math.max(0, jumps[e.key])));
}

/** Bulle : heure visée pendant le glisser, sinon heure sous la souris. */
const bubble = computed(() => {
  if (dragging.value !== null && duration.value) return { at: dragging.value / duration.value, time: dragging.value };
  if (hover.value !== null && duration.value) return { at: hover.value, time: hover.value * duration.value };
  return null;
});
</script>

<template>
  <div
    class="seek"
    :class="[variant, { dragging: dragging !== null, hovering: hover !== null }]"
    role="slider"
    tabindex="0"
    aria-label="Position dans le morceau"
    :aria-valuemin="0"
    :aria-valuemax="Math.round(duration)"
    :aria-valuenow="Math.round(dragging ?? player.positionSecs)"
    :aria-valuetext="formatDuration(dragging ?? player.positionSecs)"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="cancel"
    @pointerleave="hover = null"
    @keydown="key"
  >
    <div ref="track" class="track">
      <div v-if="hover !== null && dragging === null" class="ghost" :style="{ transform: `scaleX(${hover})` }" />
      <div ref="fill" class="fill" />
    </div>
    <span ref="knob" class="knob" />
    <span v-if="bubble" class="bubble" :style="{ left: `${bubble.at * 100}%` }">{{ formatDuration(bubble.time) }}</span>
  </div>
</template>

<style scoped>
.seek {
  position: relative;
  cursor: pointer;
  touch-action: none;
  outline: none;
  -webkit-tap-highlight-color: transparent;
}
.track {
  position: relative;
  overflow: hidden;
  transition: height 0.15s ease;
}
.fill,
.ghost {
  position: absolute;
  inset: 0;
  transform-origin: left;
}
.knob {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  margin-left: -7px;
  border-radius: 50%;
  transform: translateY(-50%) scale(0);
  transition: transform 0.15s ease;
  pointer-events: none;
}
.seek:hover .knob,
.seek:focus-visible .knob,
.seek.dragging .knob {
  transform: translateY(-50%) scale(1);
}
.bubble {
  position: absolute;
  bottom: calc(100% + 8px);
  padding: 3px 7px;
  border-radius: 6px;
  transform: translateX(-50%);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}

/* « À l'écoute » : zone tactile de 34 px autour d'une barre de 6 px. */
.hero {
  padding: 14px 0;
  margin: -14px 0;
}
.hero .track {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.2);
}
.hero:hover .track,
.hero.dragging .track {
  height: 8px;
}
.hero .ghost {
  background: rgba(255, 255, 255, 0.18);
}
.hero .fill {
  background: linear-gradient(90deg, color-mix(in srgb, var(--amb-glow, #fff) 55%, #fff), #fff);
  box-shadow: 0 0 12px color-mix(in srgb, var(--amb-glow, #fff) 60%, transparent);
}
.hero .knob {
  background: #fff;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--amb-glow, #fff) 35%, transparent), 0 2px 6px rgba(0, 0, 0, 0.4);
}
.hero .bubble {
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  backdrop-filter: blur(8px);
}
.hero:focus-visible .track {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.6);
}

/* Barre du haut : fine ligne au bas de l'afficheur, plus épaisse au survol. */
.lcd {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 11px;
  display: flex;
  align-items: flex-end;
}
.lcd .track {
  width: 100%;
  height: 3px;
  background: rgba(var(--fg-rgb), 0.1);
}
.lcd:hover .track,
.lcd.dragging .track {
  height: 5px;
}
.lcd .ghost {
  background: rgba(var(--fg-rgb), 0.12);
}
.lcd .fill {
  background: var(--text-2);
}
.lcd:hover .fill,
.lcd.dragging .fill,
.lcd:focus-visible .fill {
  background: var(--accent);
}
.lcd .knob {
  top: auto;
  bottom: -3.5px;
  width: 12px;
  height: 12px;
  margin-left: -6px;
  transform: scale(0);
  background: var(--accent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
.lcd:hover .knob,
.lcd.dragging .knob,
.lcd:focus-visible .knob {
  transform: scale(1);
}
.lcd .bubble {
  bottom: 14px;
  background: var(--accent);
  color: #fff;
}
@media (prefers-reduced-motion: reduce) {
  .track,
  .knob {
    transition: none;
  }
}
</style>
