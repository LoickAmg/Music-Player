<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { coverUrl } from "@/lib/covers";
import { hueFor } from "@/lib/format";
import type { Track } from "@/lib/types";

// Pochette en vinyle : le disque tourne à 33 tours pendant la lecture (démarrage et arrêt
// progressifs, comme une platine), l'étiquette est la pochette, le bras se pose sur le
// disque. On peut le faire tourner au doigt (sans effet sur la lecture).
const props = defineProps<{ track: Track; playing: boolean }>();

const cover = ref<string | null>(null);
watch(
  () => props.track.id,
  async () => (cover.value = await coverUrl(props.track)),
  { immediate: true },
);

const disc = ref<HTMLElement | null>(null);
const RPM_33 = 200; // degrés par seconde
let angle = 0;
let speed = 0;
let last = 0;
let frame = 0;
let drag: { pointer: number; prev: number; at: number; velocity: number } | null = null;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function loop(t: number) {
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
  last = t;
  if (!drag) {
    const target = props.playing && !reduced ? RPM_33 : 0;
    speed += (target - speed) * Math.min(1, dt * (target > speed ? 2.2 : 1.4));
    if (Math.abs(speed) < 0.5 && target === 0) speed = 0;
    angle = (angle + speed * dt) % 360;
  }
  if (disc.value) disc.value.style.transform = `rotate(${angle}deg)`;
  // Disque arrêté et lâché : plus besoin d'images, jusqu'à la reprise.
  if (speed === 0 && !drag && !props.playing) {
    frame = 0;
    last = 0;
    return;
  }
  frame = requestAnimationFrame(loop);
}
function wake() {
  if (!frame) frame = requestAnimationFrame(loop);
}
watch(() => props.playing, wake);
onMounted(wake);
onBeforeUnmount(() => cancelAnimationFrame(frame));

function pointerAngle(e: PointerEvent): number {
  const r = disc.value!.getBoundingClientRect();
  return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
}
function down(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  drag = { pointer: e.pointerId, prev: pointerAngle(e), at: performance.now(), velocity: 0 };
  wake();
}
function move(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.pointer) return;
  const a = pointerAngle(e);
  let delta = a - drag.prev;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  const now = performance.now();
  const dt = Math.max(1, now - drag.at) / 1000;
  drag.velocity = drag.velocity * 0.6 + (delta / dt) * 0.4;
  angle += delta;
  drag.prev = a;
  drag.at = now;
}
function up() {
  if (!drag) return;
  speed = Math.max(-900, Math.min(900, drag.velocity));
  drag = null;
  wake();
}
</script>

<template>
  <div class="vinyl" :class="{ playing }" :style="{ '--h': hueFor(track.album || track.title) }">
    <div
      ref="disc"
      class="disc"
      role="img"
      :aria-label="`Disque : ${track.title}`"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
    >
      <div class="grooves" />
      <div class="label">
        <img v-if="cover" :src="cover" alt="" draggable="false" />
        <span v-else class="label-text">{{ track.title }}</span>
      </div>
      <span class="hole" />
    </div>
    <!-- Reflet de la lumière : fixe pendant que le disque tourne dessous. -->
    <div class="sheen" aria-hidden="true" />
    <svg class="arm" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="86" cy="12" r="7" class="arm-base" />
      <circle cx="86" cy="12" r="3" class="arm-pivot" />
      <path d="M86 12 L80 58 L66 76" class="arm-bar" />
      <rect x="58" y="72" width="12" height="8" rx="1.5" transform="rotate(35 64 76)" class="arm-head" />
    </svg>
  </div>
</template>

<style scoped>
.vinyl {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  touch-action: none;
  user-select: none;
}
.disc {
  position: absolute;
  inset: 4%;
  border-radius: 50%;
  background: #0b0b0d;
  box-shadow:
    0 24px 50px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(255, 255, 255, 0.05),
    0 0 calc(30px + var(--amb-energy, 0) * 50px) color-mix(in srgb, var(--amb-glow, #3aa8ff) 30%, transparent);
  cursor: grab;
  will-change: transform;
}
.disc:active {
  cursor: grabbing;
}
.grooves {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(circle, transparent 31%, rgba(255, 255, 255, 0.07) 31.4%, transparent 32%),
    radial-gradient(circle, transparent 47%, rgba(255, 255, 255, 0.05) 47.3%, transparent 47.8%),
    radial-gradient(circle, transparent 66%, rgba(255, 255, 255, 0.05) 66.3%, transparent 66.8%),
    repeating-radial-gradient(circle, #121214 0 1.2px, #19191c 1.2px 2.4px);
}
.label {
  position: absolute;
  inset: 32%;
  border-radius: 50%;
  overflow: hidden;
  background: radial-gradient(circle at 35% 30%, hsl(var(--h) 70% 55%), hsl(calc(var(--h) + 40) 60% 30%));
  box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.35);
}
.label img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}
.label-text {
  display: grid;
  place-items: center;
  height: 100%;
  padding: 18%;
  color: #fff;
  font-family: var(--font-display);
  font-size: clamp(9px, 2.6vw, 14px);
  font-weight: 700;
  text-align: center;
}
.hole {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 3.2%;
  height: 3.2%;
  border-radius: 50%;
  background: #d9dbe0;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.6);
  transform: translate(-50%, -50%);
}
.sheen {
  position: absolute;
  inset: 4%;
  border-radius: 50%;
  pointer-events: none;
  background: conic-gradient(
    from 20deg,
    transparent 0deg,
    rgba(255, 255, 255, 0.13) 18deg,
    transparent 46deg,
    transparent 180deg,
    rgba(255, 255, 255, 0.09) 200deg,
    transparent 228deg
  );
  mask: radial-gradient(circle, transparent 31%, #000 32%);
  mix-blend-mode: screen;
}
.arm {
  position: absolute;
  top: -4%;
  right: -6%;
  width: 46%;
  height: 46%;
  overflow: visible;
  pointer-events: none;
  transform-origin: 86% 12%;
  transform: rotate(-26deg);
  transition: transform 0.9s cubic-bezier(0.3, 0.8, 0.3, 1);
  filter: drop-shadow(0 6px 8px rgba(0, 0, 0, 0.5));
}
.playing .arm {
  transform: rotate(0deg);
}
.arm-base {
  fill: #2a2d35;
  stroke: rgba(255, 255, 255, 0.15);
}
.arm-pivot {
  fill: #c9ccd3;
}
.arm-bar {
  fill: none;
  stroke: #d7dae0;
  stroke-width: 2.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.arm-head {
  fill: #2a2d35;
  stroke: #d7dae0;
  stroke-width: 1;
}
:root[data-perf="lite"] .sheen {
  display: none;
}
</style>
