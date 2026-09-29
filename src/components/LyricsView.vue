<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useNow } from "@/lib/clock";
import { activeLineIndex, useLyricsStore } from "@/stores/lyrics";
import { usePlayerStore } from "@/stores/player";

const props = withDefaults(defineProps<{ large?: boolean }>(), { large: false });

const lyricsStore = useLyricsStore();
const player = usePlayerStore();
const now = useNow();

const container = ref<HTMLElement | null>(null);
const lineEls = ref<HTMLElement[]>([]);
let manualScrollUntil = 0;

const synced = computed(() => lyricsStore.lyrics?.synced ?? null);
// Légère avance : la ligne s'allume au moment où elle commence à être chantée.
const active = computed(() =>
  synced.value ? activeLineIndex(synced.value, player.positionAt(now.value) * 1000 + 250) : -1,
);

function isBreak(text: string) {
  return !text.trim() || /^[♪♫\s.…]+$/.test(text);
}

function scrollToActive(smooth = true) {
  const el = lineEls.value[active.value];
  const box = container.value;
  if (!el || !box || performance.now() < manualScrollUntil) return;
  const target = el.offsetTop - box.clientHeight * 0.32;
  box.scrollTo({ top: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
}

watch(active, () => nextTick(() => scrollToActive()));
watch(
  () => lyricsStore.lyrics,
  () => {
    lineEls.value = [];
    manualScrollUntil = 0;
    nextTick(() => {
      container.value?.scrollTo({ top: 0 });
      scrollToActive(false);
    });
  },
);

function onUserScroll() {
  manualScrollUntil = performance.now() + 3500;
}

function seekTo(ms: number) {
  manualScrollUntil = 0;
  void player.seek(ms / 1000);
}
</script>

<template>
  <div class="lyrics" :class="{ large: props.large }">
    <div v-if="!player.currentTrack" class="state">Lancez un morceau pour afficher ses paroles.</div>

    <div v-else-if="lyricsStore.loading" class="state">
      <span class="dots"><i /><i /><i /></span>
    </div>

    <div v-else-if="!lyricsStore.lyrics && lyricsStore.allowOnline === null" class="ask">
      <p class="ask-title">Chercher les paroles en ligne&nbsp;?</p>
      <p class="ask-text">
        Aucune parole n'est enregistrée dans ce fichier. L'application peut les chercher sur LRCLIB,
        une base libre de paroles synchronisées&nbsp;: seuls le titre, l'artiste, l'album et la durée du morceau sont envoyés.
      </p>
      <div class="ask-actions">
        <button type="button" class="pill pill-accent" @click="lyricsStore.setAllowOnline(true)">Autoriser</button>
        <button type="button" class="pill pill-ghost" @click="lyricsStore.setAllowOnline(false)">Non merci</button>
      </div>
    </div>

    <div v-else-if="!lyricsStore.lyrics" class="state">
      <p>Pas de paroles pour ce morceau.</p>
      <p class="hint">
        Astuce : posez un fichier <code>.lrc</code> du même nom à côté du morceau pour des paroles synchronisées.
        <template v-if="lyricsStore.allowOnline === false">
          <br /><button type="button" class="link" @click="lyricsStore.setAllowOnline(true)">Autoriser la recherche en ligne</button>
        </template>
      </p>
    </div>

    <div v-else-if="lyricsStore.lyrics.instrumental" class="state instrumental">♪ Morceau instrumental</div>

    <div v-else ref="container" class="scroller" @wheel.passive="onUserScroll" @touchmove.passive="onUserScroll">
      <template v-if="synced">
        <p
          v-for="(line, i) in synced"
          :key="i"
          :ref="(el) => { if (el) lineEls[i] = el as HTMLElement }"
          class="line"
          :class="{ active: i === active, past: i < active, near: Math.abs(i - active) <= 1 }"
          @click="seekTo(line.time_ms)"
        >
          <span v-if="isBreak(line.text)" class="dots"><i /><i /><i /></span>
          <template v-else>{{ line.text }}</template>
        </p>
      </template>
      <p v-else class="plain">{{ lyricsStore.lyrics.plain }}</p>
      <p class="source">Paroles : {{ lyricsStore.lyrics.source }}</p>
    </div>
  </div>
</template>

<style scoped>
.lyrics {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.scroller {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 22px 45vh;
  scrollbar-width: none;
  mask-image: linear-gradient(to bottom, transparent 0, #000 60px, #000 calc(100% - 80px), transparent);
}
.scroller::-webkit-scrollbar {
  display: none;
}
.line {
  margin: 0 0 16px;
  font-family: var(--font-display);
  font-style: italic;
  font-size: 27px;
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: 0.01em;
  color: rgba(150, 190, 255, 0.3);
  cursor: pointer;
  transform-origin: left center;
  transition: color 0.4s var(--ease), transform 0.5s var(--ease), filter 0.5s var(--ease);
  filter: blur(0.6px);
}
.line.near {
  filter: none;
}
.line.past {
  color: rgba(150, 190, 255, 0.45);
}
.line.active {
  color: #fff;
  transform: translateX(6px) scale(1.04);
  text-shadow: 0 0 18px rgba(63, 224, 255, 0.75), 3px 3px 0 var(--blue);
  filter: none;
}
.line:hover {
  color: var(--cyan);
  filter: none;
}
.large .scroller {
  padding: 18vh 8% 50vh;
}
.large .line {
  font-size: clamp(32px, 3.6vw, 52px);
  margin-bottom: 26px;
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
.state {
  flex: 1;
  display: grid;
  place-content: center;
  gap: 6px;
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
  margin-top: 6px;
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
}
.ask {
  margin: auto 0;
  padding: 24px;
}
.ask-title {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 700;
}
.ask-text {
  margin: 0 0 16px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.55;
}
.ask-actions {
  display: flex;
  gap: 8px;
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
</style>
