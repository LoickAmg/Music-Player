<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { DEFAULT_CROP, loadImage, placement, type Crop } from "@/lib/imageCrop";

// Fenêtre de recadrage : glisser l'image au doigt ou à la souris, zoomer, valider. Le cadre
// montre la forme finale (rond pour une photo de profil, carré arrondi pour une icône).
const props = withDefaults(
  defineProps<{
    src: string | null;
    title: string;
    shape?: "circle" | "rounded" | "square";
    confirmLabel?: string;
  }>(),
  { shape: "rounded", confirmLabel: "Valider" },
);
const emit = defineEmits<{ (e: "confirm", crop: Crop): void; (e: "cancel"): void }>();

const SIZE = 260;
const crop = ref<Crop>({ ...DEFAULT_CROP });
const natural = ref<{ w: number; h: number } | null>(null);

watch(
  () => props.src,
  async (src) => {
    crop.value = { ...DEFAULT_CROP };
    natural.value = null;
    if (!src) return;
    try {
      const img = await loadImage(src);
      natural.value = { w: img.naturalWidth, h: img.naturalHeight };
    } catch {
      emit("cancel");
    }
  },
  { immediate: true },
);

const imgStyle = computed(() => {
  if (!natural.value) return { display: "none" };
  const p = placement(natural.value.w, natural.value.h, SIZE, crop.value);
  return { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` };
});

let drag: { x: number; y: number; start: Crop } | null = null;
function down(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, start: { ...crop.value } };
}
function move(e: PointerEvent) {
  if (!drag || !natural.value) return;
  const p = placement(natural.value.w, natural.value.h, SIZE, drag.start);
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  // left = (SIZE - largeur) × x / 100 : déplacer de dx revient à changer x de dx / (SIZE - largeur).
  const spanX = SIZE - p.width;
  const spanY = SIZE - p.height;
  crop.value = {
    ...crop.value,
    x: spanX < -1 ? clamp(drag.start.x + ((e.clientX - drag.x) * 100) / spanX) : 50,
    y: spanY < -1 ? clamp(drag.start.y + ((e.clientY - drag.y) * 100) / spanY) : 50,
  };
}
function up() {
  drag = null;
}
function wheel(e: WheelEvent) {
  crop.value = { ...crop.value, zoom: Math.max(1, Math.min(4, crop.value.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))) };
}

function onKey(e: KeyboardEvent) {
  if (props.src && e.key === "Escape") {
    e.stopImmediatePropagation();
    emit("cancel");
  }
}
onMounted(() => window.addEventListener("keydown", onKey, { capture: true }));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, { capture: true }));
</script>

<template>
  <div v-if="src" class="scrim" @mousedown.self="emit('cancel')">
    <div class="box" role="dialog" aria-modal="true" :aria-label="title">
      <h2>{{ title }}</h2>
      <div
        class="frame"
        :class="shape"
        :style="{ width: `${SIZE}px`, height: `${SIZE}px` }"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
        @wheel.prevent="wheel"
      >
        <img :src="src" alt="" draggable="false" :style="imgStyle" />
      </div>
      <p class="hint">Glissez l'image pour la placer.</p>
      <label class="slider">
        <span>Zoom</span>
        <input type="range" min="100" max="400" :value="Math.round(crop.zoom * 100)" @input="crop = { ...crop, zoom: +($event.target as HTMLInputElement).value / 100 }" />
      </label>
      <div class="actions">
        <button type="button" class="pill pill-ghost" @click="emit('cancel')">Annuler</button>
        <button type="button" class="pill pill-accent" :disabled="!natural" @click="emit('confirm', { ...crop })">{{ confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
}
.box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: min(360px, 100%);
  padding: 22px;
  border-radius: 16px;
  background: rgb(var(--surface-rgb));
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.12);
}
h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 18px;
}
.frame {
  position: relative;
  overflow: hidden;
  background: #000;
  cursor: grab;
  touch-action: none;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
}
.frame:active {
  cursor: grabbing;
}
.frame.circle {
  border-radius: 50%;
}
.frame.rounded {
  border-radius: 22%;
}
.frame img {
  position: absolute;
  max-width: none;
  user-select: none;
  pointer-events: none;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.slider {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  font-size: 12px;
  color: var(--text-2);
}
.slider input {
  flex: 1;
  accent-color: var(--accent);
}
.actions {
  display: flex;
  gap: 8px;
  width: 100%;
}
.actions .pill {
  flex: 1;
  justify-content: center;
}
</style>
