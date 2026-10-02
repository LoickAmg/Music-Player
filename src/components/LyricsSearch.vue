<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import type { LyricsCandidate } from "@/lib/types";
import { useLyricsStore } from "@/stores/lyrics";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// Recherche manuelle des paroles du morceau en cours : texte libre prérempli, résultats de
// LRCLIB classés (durée proche, synchronisées d'abord), un appui pour choisir.
const ui = useUiStore();
const lyrics = useLyricsStore();
const player = usePlayerStore();

const track = computed(() => player.currentTrack);
const query = ref("");
const results = ref<LyricsCandidate[]>([]);
const searching = ref(false);
const searched = ref(false);
const error = ref<string | null>(null);
const choosing = ref<number | null>(null);
const input = ref<HTMLInputElement | null>(null);
let token = 0;

async function search() {
  const t = track.value;
  const q = query.value.trim();
  if (!t || !q) return;
  const mine = ++token;
  searching.value = true;
  error.value = null;
  try {
    const found = await api.searchLyrics(t.id, q);
    if (mine === token) results.value = found;
  } catch (e) {
    if (mine === token) {
      results.value = [];
      error.value = String(e);
    }
  } finally {
    if (mine === token) {
      searching.value = false;
      searched.value = true;
    }
  }
}

watch(
  () => ui.lyricsSearch,
  async (open) => {
    if (!open || !track.value) return;
    results.value = [];
    searched.value = false;
    error.value = null;
    try {
      query.value = await api.lyricsQuery(track.value.id);
    } catch {
      query.value = `${track.value.artist} ${track.value.title}`;
    }
    void search();
    await nextTick();
    if (!ui.isTouch) input.value?.select();
  },
);

// Morceau suivant pendant la recherche : la fenêtre se ferme (le choix ne vaudrait plus).
watch(
  () => track.value?.id,
  () => {
    if (ui.lyricsSearch) close();
  },
);

function close() {
  ui.lyricsSearch = false;
}

async function pick(c: LyricsCandidate) {
  if (choosing.value !== null) return;
  choosing.value = c.id;
  try {
    await lyrics.choose(c.id);
    ui.notify("Paroles enregistrées pour ce morceau");
    close();
  } catch (e) {
    error.value = String(e);
  } finally {
    choosing.value = null;
  }
}

/** Durée du résultat comparée à celle du morceau : un bon indice de la bonne version. */
function durationHint(c: LyricsCandidate): "same" | "close" | "far" | null {
  const d = track.value?.duration_secs ?? 0;
  if (!c.duration || !d) return null;
  const gap = Math.abs(c.duration - d);
  return gap <= 3 ? "same" : gap <= 10 ? "close" : "far";
}

function onKey(e: KeyboardEvent) {
  if (ui.lyricsSearch && e.key === "Escape") {
    // Avant « À l'écoute », qui se fermerait aussi sur Échap.
    e.stopImmediatePropagation();
    close();
  }
}
onMounted(() => window.addEventListener("keydown", onKey, { capture: true }));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, { capture: true }));
</script>

<template>
  <div v-if="ui.lyricsSearch && track" class="scrim" @mousedown.self="close">
    <section class="box" role="dialog" aria-modal="true" aria-label="Chercher les paroles">
      <header class="top">
        <div class="heading">
          <p class="kicker">Chercher les paroles</p>
          <h2>{{ track.title }}</h2>
        </div>
        <button type="button" class="icon-btn" aria-label="Fermer" @click="close"><Icon name="close" :size="18" /></button>
      </header>

      <form class="search" @submit.prevent="search">
        <Icon name="search" :size="16" />
        <input ref="input" v-model="query" type="search" enterkeyhint="search" placeholder="Artiste et titre" aria-label="Artiste et titre" />
        <button type="submit" class="go" :disabled="!query.trim() || searching">Chercher</button>
      </form>
      <p class="tip">Corrigez l'artiste ou le titre si besoin, puis choisissez la bonne version. La durée la plus proche du morceau est en général la bonne.</p>

      <div class="list">
        <div v-if="searching" class="state"><span class="dots"><i /><i /><i /></span></div>
        <div v-else-if="error" class="state">
          <p>{{ error }}</p>
          <button type="button" class="link" @click="search">Réessayer</button>
        </div>
        <div v-else-if="searched && !results.length" class="state">
          <p>Aucun résultat.</p>
          <p class="muted">Essayez seulement le titre, ou l'artiste puis le titre sans mention « clip », « lyrics »…</p>
        </div>
        <button
          v-for="c in results"
          v-else
          :key="c.id"
          type="button"
          class="item"
          :class="{ busy: choosing === c.id }"
          :disabled="choosing !== null"
          @click="pick(c)"
        >
          <div class="text">
            <span class="t">{{ c.title }}</span>
            <span class="s">{{ c.artist }}<template v-if="c.album"> · {{ c.album }}</template></span>
            <span v-if="c.preview" class="p">« {{ c.preview }} »</span>
          </div>
          <div class="side">
            <span class="badge" :class="c.instrumental ? 'inst' : c.synced ? 'sync' : 'text'">
              {{ c.instrumental ? "Instrumental" : c.synced ? "Synchronisées" : "Texte seul" }}
            </span>
            <span v-if="c.duration" class="dur" :class="durationHint(c)" :title="durationHint(c) === 'same' ? 'Même durée que votre morceau' : undefined">
              <template v-if="durationHint(c) === 'same'">✓ </template>{{ formatDuration(c.duration) }}
            </span>
          </div>
        </button>
      </div>

      <footer class="foot">
        <span class="muted">Votre morceau : {{ formatDuration(track.duration_secs) }}</span>
        <button v-if="lyrics.lyrics" type="button" class="pill pill-ghost" @click="lyrics.dismiss().then(close)">Aucune de ces paroles</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  animation: fade 0.18s ease;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
.box {
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100vw - 40px));
  height: min(680px, calc(100vh - 60px));
  border-radius: 16px;
  background: rgb(9, 24, 60);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(255, 255, 255, 0.12);
  overflow: hidden;
  animation: pop 0.24s var(--ease);
}
@keyframes pop {
  from {
    transform: translateY(10px) scale(0.98);
    opacity: 0;
  }
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 10px;
}
.heading {
  min-width: 0;
}
.kicker {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
h2 {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 20px;
  padding: 0 6px 0 12px;
  height: 44px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-2);
}
.search:focus-within {
  box-shadow: 0 0 0 2px var(--accent);
}
.search input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  outline: none;
  font-size: 15px;
  color: var(--text);
}
.search input::-webkit-search-cancel-button {
  display: none;
}
.go {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.go:disabled {
  opacity: 0.5;
}
.tip {
  margin: 8px 20px 6px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-3);
}
.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 10px 10px;
}
.state {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 40px 20px;
  text-align: center;
  color: var(--text-2);
}
.state p {
  margin: 0;
}
.item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px;
  border: 0;
  border-radius: 10px;
  background: none;
  text-align: left;
  -webkit-tap-highlight-color: transparent;
}
.item:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}
.item.busy {
  background: var(--accent-soft);
}
.item:disabled:not(.busy) {
  opacity: 0.5;
}
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.t,
.s,
.p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t {
  font-size: 14px;
  font-weight: 600;
}
.s {
  font-size: 12px;
  color: var(--text-2);
}
.p {
  font-size: 12px;
  font-style: italic;
  color: var(--text-3);
}
.side {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.badge.sync {
  background: var(--accent-soft);
  color: var(--accent);
}
.badge.text,
.badge.inst {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-2);
}
.dur {
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.dur.same {
  color: #5fd38a;
  font-weight: 600;
}
.dur.far {
  opacity: 0.6;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--separator);
  font-size: 12px;
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
  }
  50% {
    opacity: 1;
  }
}

@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .scrim {
    place-items: stretch;
    backdrop-filter: none;
  }
  .box {
    width: 100%;
    height: 100%;
    border-radius: 0;
    padding-left: var(--safe-left);
    padding-right: var(--safe-right);
  }
  .top {
    padding: calc(var(--safe-top) + 12px) 14px 8px;
  }
  .search,
  .tip {
    margin-left: 14px;
    margin-right: 14px;
  }
  .list {
    padding: 4px 4px 10px;
  }
  .p {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .foot {
    padding: 10px 14px calc(var(--safe-bottom) + 10px);
  }
}
</style>
