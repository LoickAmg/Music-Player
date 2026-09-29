<script setup lang="ts" generic="T">
import { computed, ref } from "vue";
import { useViewport } from "@/lib/virtual";

const props = withDefaults(defineProps<{ items: T[]; rowHeight?: number }>(), { rowHeight: 44 });

const host = ref<HTMLElement | null>(null);
const { top, height } = useViewport(host);

const visible = computed(() => {
  const first = Math.max(0, Math.floor(top.value / props.rowHeight) - 10);
  const last = Math.min(props.items.length, Math.ceil((top.value + height.value) / props.rowHeight) + 10);
  const out: { item: T; index: number }[] = [];
  for (let i = first; i < last; i++) out.push({ item: props.items[i], index: i });
  return out;
});
</script>

<template>
  <div ref="host" class="vlist" :style="{ height: `${items.length * rowHeight}px` }">
    <div
      v-for="row in visible"
      :key="row.index"
      class="row"
      :style="{ height: `${rowHeight}px`, transform: `translateY(${row.index * rowHeight}px)` }"
    >
      <slot :item="row.item" :index="row.index" />
    </div>
  </div>
</template>

<style scoped>
.vlist {
  position: relative;
}
.row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}
</style>
