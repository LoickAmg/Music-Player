<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { coverUrl } from "@/lib/covers";
import { formatDuration, hueFor } from "@/lib/format";
import type { Track } from "@/lib/types";
import { DISC_DESIGNS, useVisualsStore } from "@/stores/visuals";

// Boîtier de CD en 3D : un clic ouvre (ou ferme) le couvercle sur sa charnière, un glisser
// fait tourner le boîtier (avec élan, puis retour en douceur), les reflets du plastique
// suivent l'angle. Le disque tourne pendant la lecture ; son motif se choisit avec les points.
const props = defineProps<{ track: Track; playing: boolean }>();
const visuals = useVisualsStore();

const cover = ref<string | null>(null);
watch(
  () => props.track.id,
  async () => (cover.value = await coverUrl(props.track)),
  { immediate: true },
);
const hue = computed(() => hueFor(props.track.album || props.track.title));
const spine = computed(() =>
  [props.track.artist, props.track.album !== "Album inconnu" ? props.track.album : props.track.title].join("  ·  "),
);

const scene = ref<HTMLElement | null>(null);
const box = ref<HTMLElement | null>(null);
const disc = ref<HTMLElement | null>(null);
const unit = ref(4);
let observer: ResizeObserver | null = null;

// Pose de repos, et pose courante (degrés).
const REST = { x: 8, y: -18 };
const pose = { x: REST.x, y: REST.y, vx: 0, vy: 0 };
let lid = 0; // 0 fermé → 1 ouvert
let spin = 0;
let spinSpeed = 0;
let last = 0;
let frame = 0;
let drag: { id: number; x: number; y: number; moved: number; at: number } | null = null;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function render(t: number) {
  const el = box.value;
  if (!el) return;
  const float = drag || reduced ? 0 : Math.sin(t / 1800) * 2.2;
  // Ouvert : le boîtier glisse à droite et se tourne de trois quarts, couvercle en retrait.
  el.style.transform = `translateX(${lid * 26}%) rotateX(${pose.x + float * 0.5}deg) rotateY(${pose.y + float - lid * 24}deg) scale(${1 - lid * 0.2})`;
  el.style.setProperty("--lid", `${-lid * 128}deg`);
  // Reflet : sa position suit la rotation du boîtier.
  el.style.setProperty("--gx", `${50 + (pose.y + float) * 1.6}%`);
  el.style.setProperty("--gy", `${50 - pose.x * 1.6}%`);
  if (disc.value) disc.value.style.transform = `translate(-50%, -50%) rotate(${spin}deg)`;
}

function loop(t: number) {
  frame = requestAnimationFrame(loop);
  const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
  last = t;
  if (!drag) {
    // Élan, puis ressort vers la pose de repos.
    pose.vx += (REST.x - pose.x) * 9 * dt;
    pose.vy += (REST.y - pose.y) * 9 * dt;
    pose.vx *= Math.pow(0.04, dt);
    pose.vy *= Math.pow(0.04, dt);
    pose.x += pose.vx * dt;
    pose.y += pose.vy * dt;
  }
  const targetLid = visuals.cdOpen ? 1 : 0;
  lid += (targetLid - lid) * Math.min(1, dt * 5);
  const targetSpin = props.playing && !reduced ? 260 : 0;
  spinSpeed += (targetSpin - spinSpeed) * Math.min(1, dt * 1.8);
  spin = (spin + spinSpeed * dt) % 360;
  render(t);
}

function down(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, at: performance.now() };
  pose.vx = pose.vy = 0;
}
function move(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  const now = performance.now();
  const dt = Math.max(1, now - drag.at) / 1000;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  pose.y = Math.max(-75, Math.min(75, pose.y + dx * 0.45));
  pose.x = Math.max(-40, Math.min(40, pose.x - dy * 0.35));
  pose.vy = (dx * 0.45) / dt;
  pose.vx = (-dy * 0.35) / dt;
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.at = now;
}
function up() {
  if (!drag) return;
  // Simple clic (sans glisser) : ouvre ou ferme le boîtier.
  if (drag.moved < 6) visuals.cdOpen = !visuals.cdOpen;
  drag = null;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    visuals.cdOpen = !visuals.cdOpen;
  }
}
function pickDesign(id: (typeof DISC_DESIGNS)[number]["id"]) {
  visuals.setDiscDesign(id);
  visuals.cdOpen = true;
}

onMounted(() => {
  observer = new ResizeObserver(() => {
    if (scene.value) unit.value = scene.value.clientWidth / 100;
  });
  if (scene.value) observer.observe(scene.value);
  frame = requestAnimationFrame(loop);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  observer?.disconnect();
});
</script>

<template>
  <div class="cd-wrap" :style="{ '--h': hue }">
    <div
      ref="scene"
      class="scene"
      :style="{ fontSize: `${unit}px` }"
      role="button"
      tabindex="0"
      :aria-label="visuals.cdOpen ? 'Fermer le boîtier du CD' : 'Ouvrir le boîtier du CD'"
      :aria-pressed="visuals.cdOpen"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
      @keydown="onKey"
    >
      <div ref="box" class="case">
        <!-- Plateau : fond noir fumé, disque, dos imprimé -->
        <div class="face tray-in">
          <span class="ridges" />
        </div>
        <div class="face tray-out">
          <img v-if="cover" :src="cover" alt="" class="back-img" draggable="false" />
          <div class="back-text">
            <strong>{{ track.title }}</strong>
            <span>{{ track.artist }}</span>
            <span v-if="track.album !== 'Album inconnu'">{{ track.album }}<template v-if="track.year"> · {{ track.year }}</template></span>
            <span>{{ formatDuration(track.duration_secs) }}</span>
          </div>
        </div>
        <div class="face side spine"><span>{{ spine }}</span></div>
        <div class="face side right" />
        <div class="face edge top" />
        <div class="face edge bottom" />

        <div class="disc-slot">
          <div ref="disc" class="disc" :class="visuals.discDesign">
            <img v-if="visuals.discDesign === 'pochette' && cover" :src="cover" alt="" draggable="false" />
            <span v-if="visuals.discDesign === 'noir'" class="print">
              <strong>{{ track.title }}</strong>
              <small>{{ track.artist }}</small>
            </span>
            <span class="hub" />
          </div>
          <span class="disc-sheen" />
        </div>

        <!-- Couvercle : livret (pochette) sous le plastique transparent -->
        <div class="lid">
          <div class="face lid-front">
            <div class="booklet">
              <img v-if="cover" :src="cover" alt="" draggable="false" />
              <div v-else class="booklet-fallback">
                <strong>{{ track.album !== "Album inconnu" ? track.album : track.title }}</strong>
                <span>{{ track.artist }}</span>
              </div>
            </div>
            <span class="hinge" />
            <span class="glare" />
          </div>
          <div class="face lid-back">
            <div class="liner">
              <img v-if="cover" :src="cover" alt="" draggable="false" />
              <p>
                <strong>{{ track.title }}</strong>
                {{ track.artist }}
              </p>
            </div>
          </div>
        </div>
      </div>
      <div class="floor-shadow" />
    </div>

    <div class="dots" role="radiogroup" aria-label="Motif du disque">
      <button
        v-for="d in DISC_DESIGNS"
        :key="d.id"
        type="button"
        role="radio"
        class="dot"
        :class="[d.id, { on: visuals.discDesign === d.id }]"
        :aria-checked="visuals.discDesign === d.id"
        :aria-label="d.label"
        :title="d.label"
        @click="pickDesign(d.id)"
      />
    </div>
  </div>
</template>

<style scoped>
.cd-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 30px;
  width: 100%;
}
.scene {
  position: relative;
  width: 100%;
  aspect-ratio: 142 / 125;
  perspective: 240em;
  cursor: grab;
  touch-action: none;
  user-select: none;
  outline: none;
}
.scene:active {
  cursor: grabbing;
}
.scene:focus-visible .case {
  outline: 2px solid var(--accent);
  outline-offset: 6px;
}
.case {
  --lid: 0deg;
  --gx: 50%;
  --gy: 50%;
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  will-change: transform;
}
.face {
  position: absolute;
  backface-visibility: hidden;
}
/* Plateau, 7 unités d'épaisseur : intérieur (vers l'avant) et dos imprimé (vers l'arrière). */
.tray-in {
  inset: 0;
  transform: translateZ(-3.5em);
  border-radius: 0.8em;
  background:
    radial-gradient(circle at 54% 50%, #1a1d24 0 30%, transparent 30.5%),
    linear-gradient(160deg, #15171c, #08090c);
  box-shadow: inset 0 0 0 0.35em rgba(255, 255, 255, 0.05);
}
.ridges {
  position: absolute;
  left: 54%;
  top: 50%;
  width: 18em;
  height: 18em;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: repeating-conic-gradient(rgba(255, 255, 255, 0.12) 0 4deg, transparent 4deg 15deg);
  mask: radial-gradient(circle, transparent 38%, #000 40%, #000 62%, transparent 64%);
}
.tray-out {
  inset: 0;
  transform: rotateY(180deg) translateZ(3.5em);
  border-radius: 0.8em;
  overflow: hidden;
  background: #0d0f14;
}
.back-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(1.4em) brightness(0.45) saturate(1.3);
  transform: scale(1.2);
}
.back-text {
  position: absolute;
  inset: 12% 14%;
  display: flex;
  flex-direction: column;
  gap: 1.4em;
  color: #fff;
  font-size: 3.6em;
  line-height: 1.2;
}
.back-text strong {
  font-family: var(--font-display);
  font-size: 1.5em;
}
.back-text span {
  opacity: 0.75;
}
.side {
  top: 0;
  height: 100%;
  width: 7em;
}
.spine {
  left: 0;
  transform-origin: left center;
  transform: translateZ(-3.5em) rotateY(-90deg);
  display: grid;
  place-items: center;
  background: linear-gradient(90deg, #1b1e25, #2a2e37 50%, #1b1e25);
  overflow: hidden;
}
.spine span {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  color: rgba(255, 255, 255, 0.85);
  font-size: 2.8em;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-height: 92%;
}
.right {
  right: 0;
  transform-origin: right center;
  transform: translateZ(-3.5em) rotateY(90deg);
  background: linear-gradient(90deg, rgba(200, 215, 235, 0.18), rgba(255, 255, 255, 0.32), rgba(200, 215, 235, 0.18));
}
.edge {
  left: 0;
  width: 100%;
  height: 7em;
  background: linear-gradient(rgba(200, 215, 235, 0.16), rgba(255, 255, 255, 0.3), rgba(200, 215, 235, 0.16));
}
.top {
  top: 0;
  transform-origin: center top;
  transform: translateZ(-3.5em) rotateX(90deg);
}
.bottom {
  bottom: 0;
  transform-origin: center bottom;
  transform: translateZ(-3.5em) rotateX(-90deg);
}

/* Disque, 84 unités de diamètre, dans le plateau. */
.disc-slot {
  position: absolute;
  left: 54%;
  top: 50%;
  width: 84em;
  height: 84em;
  transform: translate(-50%, -50%) translateZ(-2.6em);
  transform-style: preserve-3d;
}
.disc {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  overflow: hidden;
  /* Anneau central transparent et trou, comme un vrai disque. */
  mask: radial-gradient(circle, transparent 0 8.5%, #000 9% 15%, rgba(0, 0, 0, 0.35) 15.5% 21%, #000 21.5%);
  box-shadow: 0 0 2em rgba(0, 0, 0, 0.5);
  will-change: transform;
}
.disc img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.disc.pochette::after,
.disc.argent::after {
  content: "";
  position: absolute;
  inset: 0;
  background: conic-gradient(from 30deg, #ff7a9a33, #ffd86633, #7dffb033, #6ad8ff33, #b48cff33, #ff7a9a33);
  mix-blend-mode: overlay;
}
.disc.argent {
  background:
    repeating-radial-gradient(circle, rgba(255, 255, 255, 0.06) 0 0.25em, transparent 0.25em 0.5em),
    conic-gradient(from 0deg, #c9ced6, #f5f6f8, #aeb5c1, #e9ecf1, #bfc5cf, #f7f8fa, #b3bac6, #c9ced6);
}
.disc.noir {
  background: radial-gradient(circle, #1c1d21 0 40%, #101114 41%);
}
.disc.couleur {
  background:
    radial-gradient(circle at 30% 30%, color-mix(in srgb, var(--amb-glow, #fff) 70%, transparent), transparent 55%),
    conic-gradient(from 90deg, var(--amb-primary, hsl(var(--h) 70% 50%)), var(--amb-secondary, hsl(calc(var(--h) + 80) 70% 45%)), var(--amb-primary, hsl(var(--h) 70% 50%)));
}
.print {
  position: absolute;
  left: 50%;
  top: 26%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 60%;
  color: #f2f3f5;
  text-align: center;
}
.print strong {
  font-family: var(--font-display);
  font-size: 5em;
  line-height: 1.05;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.print small {
  margin-top: 0.6em;
  font-size: 3.2em;
  opacity: 0.7;
}
.hub {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 30%;
  height: 30%;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: radial-gradient(circle, transparent 28%, rgba(255, 255, 255, 0.25) 29% 30%, transparent 31%);
}
/* Reflet fixe sur le disque qui tourne dessous. */
.disc-sheen {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
  background: conic-gradient(from 200deg, transparent, rgba(255, 255, 255, 0.35) 20deg, transparent 50deg, transparent 180deg, rgba(255, 255, 255, 0.22) 205deg, transparent 235deg);
  mask: radial-gradient(circle, transparent 21%, #000 22%);
  mix-blend-mode: screen;
}

/* Couvercle : pivote sur la charnière (bord gauche) vers l'avant. */
.lid {
  position: absolute;
  inset: 0;
  transform-style: preserve-3d;
  transform-origin: left center;
  transform: translateZ(3.5em) rotateY(var(--lid));
}
.lid-front,
.lid-back {
  inset: 0;
  border-radius: 0.8em;
  overflow: hidden;
}
.lid-front {
  background: rgba(220, 232, 250, 0.06);
  box-shadow:
    inset 0 0 0 0.3em rgba(255, 255, 255, 0.22),
    inset 0 0 2em rgba(255, 255, 255, 0.08),
    0 3em 6em rgba(0, 0, 0, 0.45);
}
.booklet {
  position: absolute;
  top: 3%;
  bottom: 3%;
  left: 9%;
  right: 2.5%;
  overflow: hidden;
  border-radius: 0.3em;
  background: hsl(var(--h) 50% 30%);
}
.booklet img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.booklet-fallback {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  height: 100%;
  padding: 8%;
  color: #fff;
  background: radial-gradient(circle at 30% 25%, hsl(var(--h) 70% 55%), hsl(calc(var(--h) + 50) 60% 22%));
  font-size: 4em;
}
.booklet-fallback strong {
  font-family: var(--font-display);
  font-size: 1.5em;
}
/* Charnière striée du plastique, à gauche. */
.hinge {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 7%;
  background:
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.16) 0 0.25em, rgba(255, 255, 255, 0.04) 0.25em 0.9em),
    linear-gradient(90deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.05));
}
.glare {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at var(--gx) var(--gy), rgba(255, 255, 255, 0.28), transparent 45%),
    linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.16) 42%, transparent 52%);
  mix-blend-mode: screen;
}
.lid-back {
  transform: rotateY(180deg);
  background: #0f1116;
}
.liner {
  position: absolute;
  inset: 3% 9% 3% 2.5%;
  overflow: hidden;
  border-radius: 0.3em;
}
.liner img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(1em) brightness(0.4);
  transform: scale(1.2);
}
.liner p {
  position: absolute;
  inset: auto 8% 10%;
  display: flex;
  flex-direction: column;
  gap: 0.6em;
  margin: 0;
  color: rgba(255, 255, 255, 0.85);
  font-size: 3.4em;
}
.liner strong {
  font-family: var(--font-display);
  font-size: 1.4em;
  color: #fff;
}
.floor-shadow {
  position: absolute;
  left: 10%;
  right: 10%;
  bottom: -9%;
  height: 10%;
  border-radius: 50%;
  background: radial-gradient(ellipse, rgba(0, 0, 0, 0.45), transparent 70%);
  filter: blur(1em);
  pointer-events: none;
}

.dots {
  display: flex;
  gap: 10px;
}
.dot {
  width: 14px;
  height: 14px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.35);
  transition: transform 0.2s, box-shadow 0.2s;
}
.dot.on {
  transform: scale(1.25);
  box-shadow: 0 0 0 2px #fff, 0 0 10px rgba(255, 255, 255, 0.5);
}
.dot.pochette {
  background: conic-gradient(#ff7a9a, #ffd866, #6ad8ff, #b48cff, #ff7a9a);
}
.dot.argent {
  background: conic-gradient(#c9ced6, #f5f6f8, #aeb5c1, #c9ced6);
}
.dot.noir {
  background: #15161a;
}
.dot.couleur {
  background: linear-gradient(135deg, var(--amb-primary, #3aa8ff), var(--amb-secondary, #b48cff));
}
@media (prefers-reduced-motion: reduce) {
  .dot {
    transition: none;
  }
}
</style>
