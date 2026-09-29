// Horloge partagée à la cadence de l'écran : la barre de progression et les paroles
// synchronisées avancent de façon fluide entre deux sondages du moteur audio.

import { onBeforeUnmount, onMounted, ref } from "vue";

const now = ref(performance.now());
let subscribers = 0;
let frame = 0;

function tick() {
  now.value = performance.now();
  frame = requestAnimationFrame(tick);
}

export function useNow() {
  onMounted(() => {
    if (subscribers++ === 0) frame = requestAnimationFrame(tick);
  });
  onBeforeUnmount(() => {
    if (--subscribers === 0) cancelAnimationFrame(frame);
  });
  return now;
}
