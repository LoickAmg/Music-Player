<script setup lang="ts" generic="T">
import { computed, ref } from "vue";
import { useViewport } from "@/lib/virtual";

const props = withDefaults(
  defineProps<{ items: T[]; minWidth?: number; gap?: number; extra?: number }>(),
  { minWidth: 168, gap: 22, extra: 50 },
);

const host = ref<HTMLElement | null>(null);
const { top, height, width } = useViewport(host);

const columns = computed(() => Math.max(1, Math.floor((width.value + props.gap) / (props.minWidth + props.gap))));
const itemWidth = computed(() => (width.value - props.gap * (columns.value - 1)) / columns.value);
const rowHeight = computed(() => itemWidth.value + props.extra + props.gap);
const rows = computed(() => Math.ceil(props.items.length / columns.value));
const total = computed(() => Math.max(0, rows.value * rowHeight.value - props.gap));

const visible = computed(() => {
  const first = Math.max(0, Math.floor(top.value / rowHeight.value) - 2);
  const last = Math.min(rows.value, Math.ceil((top.value + height.value) / rowHeight.value) + 2);
  const out: { item: T; index: number; x: number; y: number }[] = [];
  for (let r = first; r < last; r++) {
    for (let c = 0; c < columns.value; c++) {
      const index = r * columns.value + c;
      if (index >= props.items.length) break;
      out.push({ item: props.items[index], index, x: c * (itemWidth.value + props.gap), y: r * rowHeight.value });
    }
  }
  return out;
});
</script>

<template>
  <div ref="host" class="vgrid" :style="{ height: `${total}px` }">
    <div
      v-for="cell in visible"
      :key="cell.index"
      class="cell"
      :style="{ width: `${itemWidth}px`, transform: `translate(${cell.x}px, ${cell.y}px)` }"
    >
      <slot :item="cell.item" :index="cell.index" />
    </div>
  </div>
</template>

<style scoped>
.vgrid {
  position: relative;
}
.cell {
  position: absolute;
  top: 0;
  left: 0;
}
</style>
