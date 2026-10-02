<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useNow } from "@/lib/clock";
import { lite } from "@/lib/perf";
import { activeLineIndex, useLyricsStore } from "@/stores/lyrics";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

const props = withDefaults(defineProps<{ large?: boolean }>(), { large: false });

const lyricsStore = useLyricsStore();
const player = usePlayerStore();
const ui = useUiStore();
const now = useNow();

const container = ref<HTMLElement | null>(null);
// Éléments des lignes (hors réactivité : on ne fait que les lire et leur donner --p).
const lineEls: HTMLElement[] = [];
/** Le texte suit la chanson ; faux pendant que l'utilisateur fait défiler au doigt. */
const following = ref(true);
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
let snapTimer: ReturnType<typeof setTimeout> | undefined;

const synced = computed(() => lyricsStore.lyrics?.synced ?? null);
// Légère avance : la ligne s'allume au moment où elle commence à être chantée. Plus le
// décalage réglé à la main pour ce morceau (paroles en avance ou en retard sur la voix).
const positionMs = computed(() => player.positionAt(now.value) * 1000 + 150 + lyricsStore.offsetMs);
const active = computed(() => (synced.value ? activeLineIndex(synced.value, positionMs.value) : -1));

function isBreak(text: string) {
  return !text.trim() || /^[♪♫\s.…]+$/.test(text);
}

// Remplissage « karaoké » de la ligne chantée, image par image, sans rendu Vue : seule la
// variable CSS --p de la ligne active change. Pas en mode léger (ligne surlignée en entier).
watch(positionMs, (ms) => {
  if (lite.value) return;
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

/** Ligne chantée amenée vers le tiers haut de la zone. Défilement doux confié au navigateur :
 *  animé par le compositeur, il reste régulier même quand le téléphone est chargé (un
 *  défilement calculé image par image allait tantôt trop vite, tantôt trop lentement), et
 *  s'interrompt de lui-même dès que le doigt touche l'écran. */
function scrollToActive(smooth = true) {
  const box = container.value;
  if (!box || !following.value) return;
  const el = lineEls[active.value];
  const target = Math.max(0, el ? el.offsetTop + el.offsetHeight / 2 - box.clientHeight * 0.3 : 0);
  if (Math.abs(target - box.scrollTop) < 2) return;
  box.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
  // Téléphone surchargé (enregistrement d'écran sur une puce modeste…) : le défilement doux
  // peut être abandonné en route. Ligne placée directement s'il n'est pas arrivé.
  clearTimeout(snapTimer);
  if (smooth) {
    snapTimer = setTimeout(() => {
      const max = box.scrollHeight - box.clientHeight;
      if (following.value && Math.abs(box.scrollTop - Math.min(target, max)) > 4) box.scrollTop = target;
    }, 900);
  }
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
  clearTimeout(resumeTimer);
  clearTimeout(snapTimer);
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

// Menu « Paroles » : autre version, décalage, retrait.
const toolsOpen = ref(false);
const offsetLabel = computed(() => {
  const s = lyricsStore.offsetMs / 1000;
  if (!s) return "Aucun décalage";
  return `${s > 0 ? "+" : "−"}${Math.abs(s).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
});
function nudge(ms: number) {
  lyricsStore.setOffset(lyricsStore.offsetMs + ms);
  resume();
}
function openSearch() {
  toolsOpen.value = false;
  ui.lyricsSearch = true;
}
async function dismiss() {
  toolsOpen.value = false;
  await lyricsStore.dismiss();
  ui.notify("Paroles retirées pour ce morceau");
}
watch(() => lyricsStore.trackId, () => (toolsOpen.value = false));

onBeforeUnmount(() => {
  clearTimeout(resumeTimer);
  clearTimeout(snapTimer);
});
</script>

<template>
  <div class="lyrics" :class="{ large: props.large }">
    <div v-if="!player.currentTrack" class="state">Lancez un morceau pour afficher ses paroles.</div>

    <div v-else-if="lyricsStore.loading" class="state">
      <span class="dots"><i /><i /><i /></span>
      <p class="hint">Recherche des paroles…</p>
    </div>

    <div v-else-if="!lyricsStore.lyrics && lyricsStore.error" class="state">
      <p>Le service de paroles ne répond pas pour l'instant.</p>
      <p class="hint">{{ lyricsStore.retries < 3 ? "Nouvel essai automatique dans un instant…" : "Vérifiez la connexion, puis réessayez." }}</p>
      <div class="state-actions">
        <button type="button" class="link" @click="lyricsStore.retry()">Réessayer maintenant</button>
      </div>
    </div>

    <div v-else-if="!lyricsStore.lyrics" class="state">
      <p>Paroles introuvables pour ce morceau.</p>
      <p v-if="!lyricsStore.allowOnline" class="hint">
        <button type="button" class="link" @click="lyricsStore.setAllowOnline(true)">Activer la recherche automatique</button>
      </p>
      <template v-else>
        <p class="hint">Elles ne sont peut-être pas encore publiées, ou le titre du fichier les cache.</p>
        <div class="state-actions">
          <button type="button" class="pill pill-accent small" @click="ui.lyricsSearch = true"><Icon name="search" :size="14" /> Chercher moi-même</button>
          <button type="button" class="link" @click="lyricsStore.retry()">Relancer la recherche automatique</button>
        </div>
      </template>
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

      <div class="tools">
        <button
          type="button"
          class="tools-btn"
          :class="{ on: toolsOpen || lyricsStore.offsetMs }"
          aria-label="Options des paroles"
          title="Paroles incorrectes ou décalées ?"
          :aria-expanded="toolsOpen"
          @click="toolsOpen = !toolsOpen"
        >
          <Icon name="more" :size="18" />
        </button>
        <div v-if="toolsOpen" class="tools-scrim" @click="toolsOpen = false" />
        <Transition name="pop">
          <div v-if="toolsOpen" class="tools-menu" role="menu">
            <p class="tools-head">Paroles : {{ lyricsStore.lyrics.source }}</p>
            <template v-if="synced">
              <p class="tools-label">Synchronisation</p>
              <div class="offset">
                <button type="button" title="Les paroles arrivent trop tôt" @click="nudge(-500)">Plus tard</button>
                <button type="button" class="value" title="Remettre à zéro" :disabled="!lyricsStore.offsetMs" @click="lyricsStore.setOffset(0)">{{ offsetLabel }}</button>
                <button type="button" title="Les paroles arrivent trop tard" @click="nudge(500)">Plus tôt</button>
              </div>
            </template>
            <button type="button" role="menuitem" class="tools-item" @click="openSearch"><Icon name="search" :size="15" /> Chercher d'autres paroles</button>
            <button type="button" role="menuitem" class="tools-item danger" @click="dismiss"><Icon name="close" :size="15" /> Ce ne sont pas les bonnes</button>
          </div>
        </Transition>
      </div>
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
.state-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.pill.small {
  height: 34px;
  font-size: 13px;
}
/* Options des paroles : discrètes, en haut à droite de la zone. */
.tools {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 3;
}
.tools-btn {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.75);
  opacity: 0.55;
  transition: opacity 0.2s, background 0.2s;
}
.lyrics:hover .tools-btn,
.tools-btn.on,
.tools-btn:focus-visible {
  opacity: 1;
}
.tools-btn.on {
  background: rgba(255, 255, 255, 0.18);
}
.tools-scrim {
  position: fixed;
  inset: 0;
  z-index: -1;
}
.tools-menu {
  position: absolute;
  top: 40px;
  right: 0;
  width: 260px;
  padding: 6px;
  border-radius: 12px;
  background: rgba(10, 26, 64, 0.97);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(255, 255, 255, 0.12);
}
.tools-head,
.tools-label {
  margin: 6px 10px;
  font-size: 11px;
  color: var(--text-3);
}
.tools-label {
  margin-bottom: 4px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.offset {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 4px;
  margin: 0 4px 6px;
}
.offset button {
  height: 34px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 12px;
  font-weight: 600;
}
.offset .value {
  min-width: 92px;
  background: none;
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
}
.tools-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  text-align: left;
  font-size: 13px;
}
.tools-item:hover {
  background: var(--accent);
  color: #fff;
}
.tools-item.danger {
  color: #ff8a98;
}
.tools-item.danger:hover {
  color: #fff;
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
.line:not(.active) .dots i {
  animation: none;
  opacity: 0.6;
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
/* Téléphone : les paroles commencent juste sous l'en-tête (pochette, titre) et s'effacent
   avant la barre de progression ; lueur plus courte ; texte un peu plus grand. */
@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .fade {
    mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 40px), transparent);
  }
  .large .scroller {
    padding: 14px 4px 55vh;
  }
  .line {
    /* Proportionnel à la largeur : lisible sur l'écran extérieur d'un Z Flip comme sur un
       grand téléphone. */
    font-size: clamp(20px, 6.4vw, 26px);
  }
  .line.active .txt {
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--amb-glow) calc(30% + var(--amb-energy) * 40%), transparent));
  }
  /* En bas à droite, dans le fondu au-dessus de la barre de progression : le bouton ne
     couvre jamais la ligne chantée, qui est en haut de la zone. */
  .tools {
    top: auto;
    bottom: 2px;
    right: 0;
  }
  .tools-btn {
    opacity: 0.8;
  }
  .tools-menu {
    top: auto;
    bottom: 42px;
  }
}
/* Mode léger (téléphones modestes) : ni masque, ni lueur, ni zoom des lignes ; la ligne
   chantée est blanche en entier, les autres atténuées. Seule l'opacité change. */
:root[data-perf="lite"] .fade {
  mask-image: none;
}
:root[data-perf="lite"] .line,
:root[data-perf="lite"] .browsing .line {
  transform: none;
  transition: opacity 0.3s ease;
}
:root[data-perf="lite"] .line.active .txt {
  background: none;
  color: #fff;
  filter: none;
}
</style>
