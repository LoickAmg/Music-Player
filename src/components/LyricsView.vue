<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useNow } from "@/lib/clock";
import { activeLineIndex, useLyricsStore } from "@/stores/lyrics";
import { usePlayerStore } from "@/stores/player";

const props = withDefaults(defineProps<{ large?: boolean }>(), { large: false });

const lyricsStore = useLyricsStore();
const player = usePlayerStore();
const now = useNow();

const container = ref<HTMLElement | null>(null);
// Éléments des lignes (hors réactivité : on ne fait que les lire et leur donner --p).
const lineEls: HTMLElement[] = [];
/** Le texte suit la chanson ; faux pendant que l'utilisateur fait défiler au doigt. */
const following = ref(true);
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
let scrollFrame = 0;

const synced = computed(() => lyricsStore.lyrics?.synced ?? null);
// Légère avance : la ligne s'allume au moment où elle commence à être chantée.
const positionMs = computed(() => player.positionAt(now.value) * 1000 + 150);
const active = computed(() => (synced.value ? activeLineIndex(synced.value, positionMs.value) : -1));

function isBreak(text: string) {
  return !text.trim() || /^[♪♫\s.…]+$/.test(text);
}

// Remplissage « karaoké » de la ligne chantée, image par image, sans rendu Vue : seule la
// variable CSS --p de la ligne active change.
watch(positionMs, (ms) => {
  const lines = synced.value;
  const i = active.value;
  const el = lineEls[i];
  if (!lines || i < 0 || !el) return;
  const start = lines[i].time_ms;
  const next = lines[i + 1]?.time_ms ?? start + 6000;
  // La voix finit en général un peu avant la ligne suivante.
  const span = Math.max(500, Math.min(next - start, 15000) * 0.88);
  const p = Math.min(1, Math.max(0, (ms - start) / span));
  el.style.setProperty("--p", p.toFixed(3));
});

/** Défilement doux maison : régulier même sur les téléphones modestes, et interrompu net
 *  dès que le doigt touche l'écran. */
function glideTo(target: number) {
  const box = container.value;
  if (!box) return;
  cancelAnimationFrame(scrollFrame);
  const from = box.scrollTop;
  const delta = Math.max(0, target) - from;
  if (Math.abs(delta) < 2) return;
  const t0 = performance.now();
  const duration = Math.min(700, 380 + Math.abs(delta) * 0.25);
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / duration);
    box.scrollTop = from + delta * (1 - Math.pow(1 - k, 3));
    if (k < 1) scrollFrame = requestAnimationFrame(step);
  };
  scrollFrame = requestAnimationFrame(step);
}

function scrollToActive(smooth = true) {
  const box = container.value;
  if (!box || !following.value) return;
  const el = lineEls[active.value];
  const target = el ? el.offsetTop + el.offsetHeight / 2 - box.clientHeight * 0.38 : 0;
  if (smooth) glideTo(target);
  else box.scrollTop = Math.max(0, target);
}

watch(active, () => nextTick(() => scrollToActive()));
watch(
  () => lyricsStore.lyrics,
  () => {
    lineEls.length = 0;
    following.value = true;
    clearTimeout(resumeTimer);
    nextTick(() => scrollToActive(false));
  },
);

function holdFollow() {
  following.value = false;
  cancelAnimationFrame(scrollFrame);
  clearTimeout(resumeTimer);
}

function resumeLater(delay = 2600) {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(resume, delay);
}

function resume() {
  clearTimeout(resumeTimer);
  following.value = true;
  scrollToActive();
}

function onWheel() {
  holdFollow();
  resumeLater();
}

function seekTo(ms: number) {
  void player.seek(ms / 1000);
  resume();
}

onBeforeUnmount(() => {
  cancelAnimationFrame(scrollFrame);
  clearTimeout(resumeTimer);
});
</script>

<template>
  <div class="lyrics" :class="{ large: props.large }">
    <div v-if="!player.currentTrack" class="state">Lancez un morceau pour afficher ses paroles.</div>

    <div v-else-if="lyricsStore.loading" class="state">
      <span class="dots"><i /><i /><i /></span>
      <p class="hint">Recherche des paroles…</p>
    </div>

    <div v-else-if="!lyricsStore.lyrics" class="state">
      <p>Paroles introuvables pour ce morceau.</p>
      <p v-if="!lyricsStore.allowOnline" class="hint">
        <button type="button" class="link" @click="lyricsStore.setAllowOnline(true)">Activer la recherche automatique</button>
      </p>
    </div>

    <div v-else-if="lyricsStore.lyrics.instrumental" class="state instrumental">♪ Morceau instrumental</div>

    <template v-else>
      <div class="fade">
        <div
          ref="container"
          class="scroller"
          :class="{ browsing: !following }"
          @touchstart.passive="holdFollow"
          @touchend.passive="resumeLater()"
          @touchcancel.passive="resumeLater()"
          @wheel.passive="onWheel"
        >
          <template v-if="synced">
            <p
              v-for="(line, i) in synced"
              :key="i"
              :ref="(el) => { if (el) lineEls[i] = el as HTMLElement }"
              class="line"
              :class="{ active: i === active, past: i < active }"
              :style="{ '--d': Math.min(4, Math.abs(i - active)) }"
              @click="seekTo(line.time_ms)"
            >
              <span v-if="isBreak(line.text)" class="dots"><i /><i /><i /></span>
              <span v-else class="txt">{{ line.text }}</span>
            </p>
          </template>
          <p v-else class="plain">{{ lyricsStore.lyrics.plain }}</p>
          <p class="source">Paroles : {{ lyricsStore.lyrics.source }}</p>
        </div>
      </div>
      <Transition name="pop">
        <button v-if="synced && !following" type="button" class="resume" @click="resume">Reprendre</button>
      </Transition>
    </template>
  </div>
</template>

<style scoped>
.lyrics {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* Fondu haut et bas posé sur un parent qui ne défile pas : le défilement reste géré par
   le compositeur (fluide au doigt). */
.fade {
  flex: 1;
  min-height: 0;
  display: flex;
  mask-image: linear-gradient(to bottom, transparent 0, #000 56px, #000 calc(100% - 72px), transparent);
}
.scroller {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: pan-y;
  -webkit-overflow-scrolling: touch;
  padding: 26vh 22px 45vh;
  scrollbar-width: none;
}
.scroller::-webkit-scrollbar {
  display: none;
}
.line {
  margin: 0 0 0.72em;
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 800;
  line-height: 1.22;
  letter-spacing: -0.01em;
  color: #fff;
  cursor: pointer;
  opacity: calc(0.46 - var(--d, 4) * 0.05);
  transform: scale(0.955);
  transform-origin: left center;
  transition:
    opacity 0.45s ease,
    transform 0.6s cubic-bezier(0.2, 0.9, 0.25, 1);
  -webkit-tap-highlight-color: transparent;
}
.line.past {
  opacity: 0.3;
}
.line.active {
  opacity: 1;
  transform: scale(1);
}
/* Ligne chantée : le blanc gagne la ligne au rythme de la voix ; la lueur prend la teinte
   de la pochette, plus vive quand la pochette est lumineuse (--amb-energy). */
.line.active .txt {
  --fill: calc(var(--p, 0) * 108%);
  background-image: linear-gradient(
    90deg,
    #fff calc(var(--fill) - 8%),
    rgba(255, 255, 255, 0.4) var(--fill)
  );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(
    0 0 calc(5px + var(--amb-energy) * 10px)
      color-mix(in srgb, var(--amb-glow) calc(35% + var(--amb-energy) * 40%), transparent)
  );
}
/* Pendant qu'on fait défiler au doigt, tout le texte reste lisible. */
.browsing .line {
  opacity: 0.78;
  transform: scale(0.98);
}
.browsing .line.active {
  opacity: 1;
}
@media (hover: hover) {
  .line:hover {
    opacity: 0.85;
  }
}
.large .scroller {
  padding: 22vh 8% 50vh;
}
.large .line {
  font-size: clamp(28px, 3.2vw, 44px);
}
.plain {
  white-space: pre-line;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.82);
}
.large .plain {
  font-size: 24px;
}
.source {
  margin-top: 32px;
  font-size: 11px;
  color: var(--text-3);
}
.resume {
  position: absolute;
  left: 50%;
  bottom: 18px;
  translate: -50% 0;
  z-index: 2;
  padding: 8px 18px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  color: #0a1030;
  font-size: 13px;
  font-weight: 700;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.pop-enter-active,
.pop-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.25s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
.state {
  flex: 1;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: var(--text-2);
}
.state p {
  margin: 0;
}
.hint {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}
.instrumental {
  font-size: 20px;
  font-weight: 700;
}
.link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
}
.dots {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  height: 1em;
}
.dots i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: breathe 1.4s ease-in-out infinite;
}
.dots i:nth-child(2) {
  animation-delay: 0.2s;
}
.dots i:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes breathe {
  0%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
/* Téléphone : pas de masque (coûteux pour les processeurs graphiques modestes), lueur plus
   courte ; texte un peu plus grand. */
@media (max-width: 760px) {
  .fade {
    mask-image: none;
  }
  .line {
    font-size: 26px;
  }
  .line.active .txt {
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--amb-glow) calc(30% + var(--amb-energy) * 40%), transparent));
  }
}
</style>
