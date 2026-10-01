// Horloge partagée à la cadence de l'écran : la barre de progression et les paroles
// synchronisées avancent de façon fluide entre deux sondages du moteur audio.
// `useFrame` appelle une fonction à chaque image sans passer par la réactivité de Vue :
// à réserver aux mises à jour directes du DOM (barres de progression, remplissage des
// paroles), qui ne doivent pas redessiner tout un composant 60 à 120 fois par seconde.

import { onBeforeUnmount, onMounted, ref } from "vue";

const now = ref(performance.now());
const callbacks = new Set<(t: number) => void>();
let subscribers = 0;
let frame = 0;

function tick() {
  const t = performance.now();
  now.value = t;
  callbacks.forEach((cb) => cb(t));
  frame = requestAnimationFrame(tick);
}

function subscribe() {
  if (subscribers++ === 0) frame = requestAnimationFrame(tick);
}

function unsubscribe() {
  if (--subscribers === 0) cancelAnimationFrame(frame);
}

export function useNow() {
  onMounted(subscribe);
  onBeforeUnmount(unsubscribe);
  return now;
}

export function useFrame(callback: (t: number) => void) {
  onMounted(() => {
    callbacks.add(callback);
    subscribe();
  });
  onBeforeUnmount(() => {
    callbacks.delete(callback);
    unsubscribe();
  });
}
