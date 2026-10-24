<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { BANDS, useSpectrum } from "@/lib/spectrum";

// Visualiseur du son joué : barres en bas de l'écran (graves au centre, en miroir), ou
// couronne autour du disque. Couleur : variable CSS --viz-color de l'élément.
const props = withDefaults(defineProps<{ shape?: "bars" | "ring"; inner?: number }>(), { shape: "bars", inner: 0.36 });

const levels = useSpectrum();
const canvas = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let width = 0;
let height = 0;
let color = "#fff";
let frame = 0;
let idle = 0;
let observer: ResizeObserver | null = null;

function resize() {
  const el = canvas.value;
  if (!el) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = el.clientWidth;
  height = el.clientHeight;
  el.width = Math.round(width * dpr);
  el.height = Math.round(height * dpr);
  ctx = el.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  color = getComputedStyle(el).getPropertyValue("--viz-color").trim() || "#fff";
}

/** Bande affichée à la position `i` sur `count` : graves au centre, aigus vers les bords. */
function mirrored(i: number, count: number): number {
  const half = count / 2;
  const d = i < half ? half - 1 - i : i - half;
  return levels[Math.min(BANDS - 1, Math.floor((d / half) * BANDS))];
}

function drawBars(c: CanvasRenderingContext2D) {
  const count = 48;
  const gap = width / count;
  const w = Math.max(2, gap * 0.55);
  for (let i = 0; i < count; i++) {
    const v = mirrored(i, count);
    const h = Math.max(2, v * v * height * 0.95);
    const x = i * gap + (gap - w) / 2;
    c.globalAlpha = 0.25 + v * 0.65;
    c.beginPath();
    c.roundRect(x, height - h, w, h, w / 2);
    c.fill();
  }
}

function drawRing(c: CanvasRenderingContext2D) {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * props.inner;
  const room = Math.min(width, height) / 2 - radius;
  const count = 96;
  c.lineCap = "round";
  c.lineWidth = Math.max(2, (Math.PI * 2 * radius) / count * 0.45);
  for (let i = 0; i < count; i++) {
    const v = mirrored(i, count);
    const len = 3 + v * v * room * 0.9;
    const a = (i / count) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    c.globalAlpha = 0.2 + v * 0.7;
    c.beginPath();
    c.moveTo(cx + cos * radius, cy + sin * radius);
    c.lineTo(cx + cos * (radius + len), cy + sin * (radius + len));
    c.stroke();
  }
}

function draw() {
  frame = requestAnimationFrame(draw);
  const c = ctx;
  if (!c || !width) return;
  let total = 0;
  for (let i = 0; i < BANDS; i++) total += levels[i];
  // Silence (pause) : une dernière image vide, puis plus rien à dessiner.
  if (total < 0.01) {
    if (idle++ > 1) return;
  } else idle = 0;
  c.clearRect(0, 0, width, height);
  c.fillStyle = color;
  c.strokeStyle = color;
  c.shadowColor = color;
  c.shadowBlur = 12;
  if (props.shape === "ring") drawRing(c);
  else drawBars(c);
}

onMounted(() => {
  resize();
  observer = new ResizeObserver(resize);
  if (canvas.value) observer.observe(canvas.value);
  frame = requestAnimationFrame(draw);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  observer?.disconnect();
});
</script>

<template>
  <canvas ref="canvas" class="visualizer" :class="shape" aria-hidden="true" />
</template>

<style scoped>
.visualizer {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
