// Horloge partagée de l'affichage : la barre de progression et les paroles synchronisées
// avancent de façon fluide entre deux sondages du moteur audio.
//
// Économie d'énergie : l'horloge ne tourne que pendant la lecture, appli visible. En pause
// (ou après un saut), elle ne produit qu'une image. En mode léger, elle bat à 10 images par
// seconde au lieu de suivre l'écran (60 à 120 par seconde).
//
// `useFrame` appelle une fonction à chaque image sans passer par la réactivité de Vue : à
// réserver aux mises à jour directes du DOM (barres de progression, remplissage des
// paroles), qui ne doivent pas redessiner tout un composant à chaque image.

import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { lite, resetSampling, sampleFrame } from "./perf";

const now = ref(performance.now());
const callbacks = new Set<(t: number) => void>();
let subscribers = 0;
let playing = false;
let frame = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function tick() {
  frame = 0;
  timer = undefined;
  const t = performance.now();
  now.value = t;
  callbacks.forEach((cb) => cb(t));
  if (running()) {
    if (!lite.value) sampleFrame(t);
    schedule();
  }
}

function running() {
  return playing && subscribers > 0 && !document.hidden;
}

function schedule() {
  if (frame || timer) return;
  if (lite.value) timer = setTimeout(tick, 100);
  else frame = requestAnimationFrame(tick);
}

function stop() {
  cancelAnimationFrame(frame);
  clearTimeout(timer);
  frame = 0;
  timer = undefined;
}

function restart() {
  stop();
  if (running()) schedule();
  else if (subscribers > 0) frame = requestAnimationFrame(tick); // une dernière image
}

/** Lecture en cours ou non : l'horloge s'arrête en pause. */
export function setClockRunning(on: boolean) {
  if (on === playing) return;
  playing = on;
  if (!on) resetSampling();
  restart();
}

/** Une image, même à l'arrêt (après un saut dans le morceau, un changement de piste). */
export function nudgeClock() {
  if (!frame && !timer) frame = requestAnimationFrame(tick);
}

document.addEventListener("visibilitychange", () => {
  resetSampling();
  restart();
});
watch(lite, restart);

function subscribe() {
  subscribers++;
  restart();
}

function unsubscribe() {
  subscribers--;
  if (subscribers <= 0) stop();
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
