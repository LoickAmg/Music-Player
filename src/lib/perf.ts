// Niveau d'effets visuels. « Complet » : fond flouté, remplissage karaoké des paroles,
// lueurs. « Léger » : fond fixe aux couleurs de la pochette, ligne chantée surlignée en
// entier, horloge d'affichage à 10 images par seconde. Le mode léger épargne le processeur
// graphique des téléphones modestes (qui chauffaient et saccadaient) sans rien retirer à
// la musique.
//
// « Automatique » choisit le mode léger quand l'appareil le laisse prévoir (puce graphique
// d'entrée de gamme, peu de mémoire ou de cœurs, animations réduites demandées par le
// système), ou quand l'affichage se met à saccader pendant la lecture.

import { computed, ref } from "vue";

export type PerfSetting = "auto" | "full" | "lite";

const SETTING_KEY = "mp:perf";
const DETECTED_KEY = "mp:perf-detected-lite";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // stockage indisponible : vaut pour la session
  }
}

/** Puces graphiques d'entrée et de milieu de gamme (Mali-G51 du Huawei Y8p, etc.). */
const WEAK_GPU = /Mali-(G31|G51|G52|G57|G68|T\d+)|Adreno \(TM\) ([3-5]\d\d|6[01]\d)|PowerVR|Vivante/i;

function gpuName(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (!gl) return "";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch {
    return "";
  }
}

function predictLite(): { lite: boolean; reason: string } {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return { lite: true, reason: "animations réduites demandées par le système" };
  }
  const gpu = gpuName();
  if (WEAK_GPU.test(gpu)) return { lite: true, reason: `puce graphique ${gpu.replace(/\s*\(.*$/, "")}` };
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (memory !== undefined && memory <= 3) return { lite: true, reason: `${memory} Go de mémoire` };
  if ((navigator.hardwareConcurrency || 8) <= 4) return { lite: true, reason: "processeur à 4 cœurs ou moins" };
  if (read(DETECTED_KEY) === "1") return { lite: true, reason: "saccades constatées sur cet appareil" };
  return { lite: false, reason: "" };
}

export const perfSetting = ref<PerfSetting>((read(SETTING_KEY) as PerfSetting | null) ?? "auto");
const prediction = ref(predictLite());

/** Mode léger actif. */
export const lite = computed(() =>
  perfSetting.value === "auto" ? prediction.value.lite : perfSetting.value === "lite",
);
/** Pourquoi le mode automatique a choisi le mode léger (affiché dans les Réglages). */
export const autoReason = computed(() => prediction.value.reason);

export function setPerfSetting(value: PerfSetting) {
  perfSetting.value = value;
  write(SETTING_KEY, value);
  apply();
}

function apply() {
  document.documentElement.dataset.perf = lite.value ? "lite" : "full";
}
apply();

// Détection des saccades : pendant la lecture en mode complet automatique, si plus d'une
// image sur huit dépasse 40 ms sur une fenêtre de 4 s, l'appareil passe en mode léger (et
// s'en souvient).
let windowStart = 0;
let frames = 0;
let slow = 0;
let last = 0;

export function sampleFrame(t: number) {
  if (perfSetting.value !== "auto" || prediction.value.lite) return;
  if (last && t - last < 1000) {
    frames++;
    if (t - last > 40) slow++;
  }
  last = t;
  if (!windowStart) windowStart = t;
  if (t - windowStart < 4000) return;
  if (frames >= 30 && slow / frames > 0.125) {
    prediction.value = { lite: true, reason: "saccades constatées sur cet appareil" };
    write(DETECTED_KEY, "1");
    apply();
  }
  windowStart = t;
  frames = 0;
  slow = 0;
}

/** Oublie une détection de saccades (bouton des Réglages). */
export function resetDetection() {
  write(DETECTED_KEY, "0");
  prediction.value = predictLite();
  apply();
}

/** À appeler quand la lecture s'arrête : une pause ne compte pas comme une saccade. */
export function resetSampling() {
  last = 0;
  windowStart = 0;
  frames = 0;
  slow = 0;
}
