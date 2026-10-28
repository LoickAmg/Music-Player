<script setup lang="ts">
import { usePlayerStore } from "@/stores/player";
import Icon from "./Icon.vue";

// Reculer ou avancer de 10 secondes dans le morceau en cours.
const props = withDefaults(defineProps<{ seconds: number; size?: number }>(), { size: 22 });
const player = usePlayerStore();
</script>

<template>
  <button
    type="button"
    class="icon-btn skip"
    :title="props.seconds < 0 ? `Reculer de ${-props.seconds} s` : `Avancer de ${props.seconds} s`"
    :aria-label="props.seconds < 0 ? `Reculer de ${-props.seconds} secondes` : `Avancer de ${props.seconds} secondes`"
    :disabled="!player.currentTrack"
    @click="player.skip(props.seconds)"
  >
    <Icon :name="props.seconds < 0 ? 'skip-back' : 'skip-fwd'" :size="props.size" />
    <span class="n" :style="{ fontSize: `${Math.round(props.size * 0.36)}px` }">{{ Math.abs(props.seconds) }}</span>
  </button>
</template>

<style scoped>
.skip {
  position: relative;
}
.n {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -45%);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
</style>
