<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { SCROLLER } from "@/lib/virtual";
import { useUiStore } from "@/stores/ui";

// Barre de défilement rapide pour les longues listes, au doigt : on tire la poignée et le repère
// (lettre, date…) indique où l'on arrive.
const props = defineProps<{ count: number; label: (index: number) => string }>();
const ui = useUiStore();
const scroller = inject(SCROLLER, ref(null));

const THUMB = 52;
const track = ref<HTMLElement | null>(null);
const thumb = ref<HTMLElement | null>(null);
const dragging = ref(false);
const bubble = ref("");
const shown = computed(() => ui.isTouch && props.count >= 50);

function fraction(): number {
  const sc = scroller.value;
  if (!sc) return 0;
  const room = sc.scrollHeight - sc.clientHeight;
  return room > 0 ? sc.scrollTop / room : 0;
}
function paint(f: number) {
  const height = track.value?.clientHeight ?? 0;
  if (thumb.value) thumb.value.style.transform = `translateY(${f * Math.max(0, height - THUMB)}px)`;
}
function follow() {
  if (!dragging.value) paint(fraction());
}
function moveTo(e: PointerEvent) {
  const sc = scroller.value;
  const box = track.value?.getBoundingClientRect();
  if (!sc || !box) return;
  const f = Math.min(1, Math.max(0, (e.clientY - box.top - THUMB / 2) / Math.max(1, box.height - THUMB)));
  sc.scrollTop = f * (sc.scrollHeight - sc.clientHeight);
  paint(f);
  bubble.value = props.label(Math.min(props.count - 1, Math.floor(f * props.count)));
}
function down(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragging.value = true;
  moveTo(e);
}
function move(e: PointerEvent) {
  if (dragging.value) moveTo(e);
}
function up() {
  dragging.value = false;
}

onMounted(() => {
  scroller.value?.addEventListener("scroll", follow, { passive: true });
  follow();
});
onBeforeUnmount(() => scroller.value?.removeEventListener("scroll", follow));
watch(shown, () => requestAnimationFrame(follow));
</script>

<template>
  <div v-if="shown" ref="track" class="fast" :class="{ dragging }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
    <div ref="thumb" class="thumb" role="scrollbar" aria-orientation="vertical" aria-label="Défilement rapide" :aria-valuenow="0">
      <span v-if="dragging && bubble" class="bubble">{{ bubble }}</span>
    </div>
  </div>
</template>

<style scoped>
.fast {
  position: fixed;
  top: calc(var(--safe-top) + 74px);
  right: var(--safe-right);
  bottom: calc(var(--safe-bottom) + 136px);
  z-index: 15;
  width: 30px;
  touch-action: none;
}
.thumb {
  position: absolute;
  top: 0;
  right: 4px;
  width: 6px;
  height: 52px;
  border-radius: 3px;
  background: rgba(var(--fg-rgb), 0.32);
  transition: width 0.12s var(--ease);
}
.dragging .thumb {
  width: 10px;
  background: var(--accent);
}
.bubble {
  position: absolute;
  top: 50%;
  right: 22px;
  translate: 0 -50%;
  min-width: 52px;
  padding: 8px 14px;
  border-radius: 14px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 22px;
  font-weight: 800;
  text-align: center;
  white-space: nowrap;
}
</style>
