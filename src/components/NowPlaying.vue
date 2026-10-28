<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { coverUrl } from "@/lib/covers";
import { useNow } from "@/lib/clock";
import { keepScreenOn } from "@/lib/androidMedia";
import { useFavoritesStore } from "@/stores/favorites";
import { useLyricsStore } from "@/stores/lyrics";
import { formatDuration, hueFor } from "@/lib/format";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Artwork from "./Artwork.vue";
import Icon from "./Icon.vue";
import LyricsView from "./LyricsView.vue";
import CdCase from "./CdCase.vue";
import SeekBar from "./SeekBar.vue";
import VinylArt from "./VinylArt.vue";
import Visualizer from "./Visualizer.vue";
import { type ArtStyle, useVisualsStore } from "@/stores/visuals";

const player = usePlayerStore();
const ui = useUiStore();
const favorites = useFavoritesStore();
// Écran étroit (téléphone, écran extérieur d'un pliable) : une colonne, pochette ou paroles.
// À partir de 600 px (pliable ouvert, tablette) : pochette et paroles côte à côte.
const narrowQuery = window.matchMedia("(max-width: 599px)");
const narrow = ref(narrowQuery.matches);
const onNarrow = (e: MediaQueryListEvent) => (narrow.value = e.matches);
narrowQuery.addEventListener("change", onNarrow);
onBeforeUnmount(() => narrowQuery.removeEventListener("change", onNarrow));
const now = useNow();

const track = computed(() => player.currentTrack);
const bg = ref<string | null>(null);
watch(
  () => track.value?.id,
  async () => {
    bg.value = await coverUrl(track.value);
  },
  { immediate: true },
);
// Téléphone : on affiche soit la pochette, soit les paroles en plein écran.
const showLyrics = ref(false);
// Écran gardé allumé tant que les paroles défilent (paroles affichées, lecture en cours).
const lyrics = useLyricsStore();
watch(
  () => (!narrow.value || showLyrics.value) && !player.isPaused && !!lyrics.lyrics?.synced,
  (on) => keepScreenOn(on),
  { immediate: true },
);
onBeforeUnmount(() => keepScreenOn(false));
const hue = computed(() => hueFor(track.value?.album || track.value?.title || ""));

const duration = computed(() => track.value?.duration_secs ?? 0);
// À la seconde près pour le texte ; position visée pendant qu'on fait glisser la barre.
const dragging = ref<number | null>(null);
const position = computed(() => Math.floor(dragging.value ?? player.positionAt(now.value)));

// Pochette : classique, vinyle ou boîtier de CD (par défaut : vinyle sur téléphone, CD sur
// grand écran), et visualiseur du son.
const visuals = useVisualsStore();
const artStyle = computed(() => visuals.resolved(narrow.value));
const STYLE_LABEL: Record<Exclude<ArtStyle, "auto">, string> = { cover: "Pochette", vinyl: "Vinyle", cd: "Boîtier de CD" };
function cycleArt() {
  const order: Exclude<ArtStyle, "auto">[] = ["cover", "vinyl", "cd"];
  const next = order[(order.indexOf(artStyle.value) + 1) % order.length];
  visuals.setArtStyle(next);
  ui.notify(`Affichage : ${STYLE_LABEL[next]}`);
}
function toggleVisualizer() {
  visuals.setVisualizer(!visuals.visualizer);
  ui.notify(visuals.visualizer ? "Visualiseur affiché" : "Visualiseur masqué");
}

const REPEAT_LABEL = { off: "Répéter : non", all: "Répéter : toute la liste", one: "Répéter : ce morceau" } as const;
async function cycleRepeat() {
  await player.cycleRepeat();
  ui.notify(REPEAT_LABEL[player.repeat]);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") ui.closeNowPlaying();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <section class="now-playing" role="dialog" aria-label="À l'écoute" :class="{ paused: player.isPaused }" :style="{ '--h': hue }">
    <div class="backdrop" aria-hidden="true">
      <img v-if="bg" :key="`1${bg}`" :src="bg" alt="" class="blob b1" />
      <img v-if="bg" :key="`2${bg}`" :src="bg" alt="" class="blob b2" />
      <div v-else class="fallback" />
      <!-- Nappes de lumière aux couleurs de la pochette, qui respirent pendant la lecture -->
      <span class="aura a1" />
      <span class="aura a2" />
      <span class="aura a3" />
      <div class="veil" />
      <div class="grain" />
      <Visualizer v-if="visuals.visualizer && track && !player.isPaused" class="floor-viz" shape="bars" />
    </div>

    <button type="button" class="icon-btn collapse" aria-label="Réduire" @click="ui.closeNowPlaying()">
      <Icon name="collapse" :size="18" />
    </button>
    <div class="view-tools">
      <button type="button" class="icon-btn" :title="`Affichage : ${STYLE_LABEL[artStyle]} (changer)`" aria-label="Changer l'affichage de la pochette" @click="cycleArt">
        <Icon :name="artStyle === 'cover' ? 'image' : 'album'" :size="18" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :class="{ on: visuals.visualizer }"
        :title="visuals.visualizer ? 'Masquer le visualiseur' : 'Afficher le visualiseur'"
        :aria-pressed="visuals.visualizer"
        aria-label="Visualiseur"
        @click="toggleVisualizer"
      >
        <Icon name="eq" :size="18" />
      </button>
    </div>

    <div v-if="track" class="layout" :class="{ 'm-lyrics': narrow && showLyrics }">
      <div class="left">
        <div class="art-stage" :class="[artStyle, { paused: player.isPaused }]">
          <Visualizer v-if="visuals.visualizer && artStyle === 'vinyl' && !player.isPaused" class="ring-viz" shape="ring" :inner="0.33" />
          <VinylArt v-if="artStyle === 'vinyl'" :track="track" :playing="!player.isPaused" />
          <CdCase v-else-if="artStyle === 'cd'" :track="track" :playing="!player.isPaused" />
          <Artwork v-else :track="track" :radius="12" eager class="hero-art" :class="{ paused: player.isPaused }" />
        </div>
        <div class="meta">
          <div class="meta-text">
            <h2>{{ track.title }}</h2>
            <p>{{ track.artist }}<template v-if="track.album !== 'Album inconnu'"> — {{ track.album }}</template></p>
          </div>
          <button
            type="button"
            class="icon-btn like-now"
            :class="{ on: favorites.isFavorite(track.id) }"
            :aria-label="favorites.isFavorite(track.id) ? 'Retirer des titres aimés' : 'Ajouter aux titres aimés'"
            :aria-pressed="favorites.isFavorite(track.id)"
            @click="favorites.toggle(track.id)"
          >
            <Icon name="heart" :size="19" :style="favorites.isFavorite(track.id) ? '--icon-fill: currentColor' : undefined" />
          </button>
        </div>
        <SeekBar variant="hero" @dragging="dragging = $event" />
        <div class="times">
          <span>{{ formatDuration(position) }}</span>
          <span>-{{ formatDuration(Math.max(0, duration - position)) }}</span>
        </div>
        <div class="controls">
          <button type="button" class="icon-btn" :class="{ on: player.shuffle }" aria-label="Aléatoire" @click="player.setShuffle(!player.shuffle)">
            <Icon name="shuffle" :size="20" />
          </button>
          <button type="button" class="icon-btn c-big" aria-label="Précédent" @click="player.previous()"><Icon name="prev" :size="28" /></button>
          <button type="button" class="icon-btn c-play" :aria-label="player.isPaused ? 'Lire' : 'Pause'" @click="player.togglePlayPause()">
            <Icon :name="player.isPaused ? 'play' : 'pause'" :size="38" />
          </button>
          <button type="button" class="icon-btn c-big" aria-label="Suivant" @click="player.next()"><Icon name="next" :size="28" /></button>
          <button type="button" class="icon-btn rep" :class="{ on: player.repeat !== 'off' }" :aria-label="REPEAT_LABEL[player.repeat]" @click="cycleRepeat">
            <Icon name="repeat" :size="20" />
            <span v-if="player.repeat === 'one'" class="rep-one">1</span>
          </button>
        </div>
        <div v-if="narrow" class="m-extra">
          <button type="button" class="icon-btn" :class="{ on: showLyrics }" aria-label="Paroles" @click="showLyrics = !showLyrics">
            <Icon name="lyrics" :size="22" />
          </button>
        </div>
      </div>
      <!-- Paroles sur téléphone : petite pochette, titre et artiste en haut (comme Apple
           Music) ; un appui revient à la grande pochette. -->
      <button v-if="narrow && showLyrics" type="button" class="m-head" aria-label="Afficher la pochette" @click="showLyrics = false">
        <Artwork :track="track" :radius="8" eager class="m-head-art" />
        <span class="m-head-text">
          <span class="t">{{ track.title }}</span>
          <span class="a">{{ track.artist }}</span>
        </span>
      </button>
      <div class="right">
        <LyricsView large />
      </div>
    </div>
    <div v-else class="empty">Aucun morceau en cours.</div>
  </section>
</template>

<style scoped>
.now-playing {
  /* Fond tiré de la pochette, toujours sombre : texte et paroles en blanc quel que soit le
     thème. */
  --lyrics-rgb: 255, 255, 255;
  --fg-rgb: 255, 255, 255;
  --text: #f5f7fb;
  --text-2: rgba(240, 244, 250, 0.72);
  --text-3: rgba(235, 240, 250, 0.48);
  --separator: rgba(255, 255, 255, 0.14);
  --bg-hover: rgba(255, 255, 255, 0.08);
  --bg-active: rgba(255, 255, 255, 0.14);
  /* En mode clair, l'accent du thème est foncé pour le fond clair : ici, sa version lisible
     sur fond sombre. */
  --accent: var(--accent-on-dark, #3aa8ff);
  --accent-soft: color-mix(in srgb, var(--accent-on-dark, #3aa8ff) 18%, transparent);
  color: var(--text);
  position: fixed;
  inset: 0;
  z-index: 40;
  overflow: hidden;
  background: var(--amb-base);
  animation: rise 0.45s var(--ease);
}
@keyframes rise {
  from {
    transform: translateY(40px);
    opacity: 0;
  }
}
.backdrop {
  position: absolute;
  inset: 0;
}
.blob {
  position: absolute;
  width: 90vmax;
  height: 90vmax;
  object-fit: cover;
  filter: blur(90px) saturate(1.6) brightness(0.75);
  opacity: 0.7;
}
.b1 {
  top: -35vmax;
  left: -25vmax;
  animation: drift 38s linear infinite;
}
.b2 {
  bottom: -40vmax;
  right: -30vmax;
  transform: rotate(180deg);
  animation: drift 52s linear infinite reverse;
}
@keyframes head-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.92);
  }
}
@keyframes blob-in {
  from {
    opacity: 0;
  }
}
@keyframes drift {
  to {
    transform: rotate(360deg);
  }
}
.fallback {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 25% 30%, hsl(var(--h) 60% 35%), transparent 60%),
    radial-gradient(circle at 80% 75%, hsl(calc(var(--h) + 60) 55% 25%), transparent 55%), #050d24;
}
.aura {
  position: absolute;
  border-radius: 50%;
  mix-blend-mode: screen;
  filter: blur(70px);
  opacity: calc(0.28 + var(--amb-energy) * 0.35);
  animation: breathe 9s ease-in-out infinite alternate, wander 26s ease-in-out infinite alternate;
}
.a1 {
  width: 55vmax;
  height: 55vmax;
  top: -18vmax;
  right: -12vmax;
  background: radial-gradient(circle, var(--amb-primary), transparent 65%);
}
.a2 {
  width: 45vmax;
  height: 45vmax;
  bottom: -20vmax;
  left: -10vmax;
  background: radial-gradient(circle, var(--amb-secondary), transparent 65%);
  animation-delay: -4s, -9s;
}
.a3 {
  width: 30vmax;
  height: 30vmax;
  top: 30%;
  left: 28%;
  background: radial-gradient(circle, var(--amb-glow), transparent 60%);
  opacity: calc(0.1 + var(--amb-energy) * 0.18);
  animation-duration: 6s, 34s;
}
.paused .aura,
.paused .blob {
  animation-play-state: paused;
}
.paused .aura {
  opacity: 0.18;
  transition: opacity 1.2s;
}
@keyframes breathe {
  from {
    scale: 0.9;
  }
  to {
    scale: 1.12;
  }
}
@keyframes wander {
  from {
    translate: -3vmax 2vmax;
  }
  to {
    translate: 4vmax -3vmax;
  }
}
.veil {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse at center, transparent 40%, color-mix(in srgb, var(--amb-base) 70%, transparent) 100%),
    color-mix(in srgb, var(--amb-base) 35%, transparent);
}
.grain {
  position: absolute;
  inset: 0;
  opacity: 0.06;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  mix-blend-mode: overlay;
}
.collapse {
  position: absolute;
  top: calc(var(--safe-top) + 14px);
  left: calc(var(--safe-left) + 14px);
  z-index: 2;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.08);
}
.like-now {
  flex: none;
  color: rgba(255, 255, 255, 0.8);
}
.like-now.on {
  color: var(--like);
}
.layout {
  position: relative;
  z-index: 1;
  height: 100%;
  display: grid;
  grid-template-columns: minmax(240px, 0.9fr) minmax(0, 1.1fr);
  gap: 4vw;
  padding: var(--safe-top) calc(6vw + var(--safe-right)) var(--safe-bottom) calc(6vw + var(--safe-left));
}
/* Grand écran seulement : sur téléphone, la colonne garde toute la largeur (sinon titre
   coupé, barre de progression et boutons tassés). */
@media (min-width: 600px) {
  .layout:has(.art-stage.cd) .left {
    width: min(50vh, 36vw);
  }
}
.left {
  align-self: center;
  justify-self: center;
  width: min(44vh, 34vw);
  display: flex;
  flex-direction: column;
}
.hero-art {
  width: 100%;
  box-shadow: 0 30px 60px rgba(0, 0, 0, 0.45),
    0 0 calc(40px + var(--amb-energy) * 60px) color-mix(in srgb, var(--amb-glow) 38%, transparent);
  transition: transform 0.6s var(--ease), box-shadow 1.2s ease;
}
.hero-art.paused {
  transform: scale(0.88);
}
.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 26px 0 14px;
}
.meta-text {
  min-width: 0;
}
.meta h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta p {
  margin: 2px 0 0;
  color: rgba(255, 255, 255, 0.65);
  font-size: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.art-stage {
  position: relative;
  width: 100%;
}
.ring-viz {
  position: absolute;
  inset: -16%;
  width: 132%;
  height: 132%;
  --viz-color: color-mix(in srgb, var(--amb-glow) 70%, #fff);
}
.floor-viz {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 24vh;
  opacity: 0.45;
  --viz-color: color-mix(in srgb, var(--amb-glow) 75%, #fff);
  mask: linear-gradient(transparent, #000 60%);
}
.view-tools {
  position: absolute;
  top: calc(var(--safe-top) + 14px);
  left: calc(var(--safe-left) + 58px);
  z-index: 2;
  display: flex;
  gap: 4px;
}
.view-tools .icon-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.08);
}
.view-tools .icon-btn.on {
  color: #fff;
  background: color-mix(in srgb, var(--amb-glow, #fff) 35%, rgba(255, 255, 255, 0.12));
}
.times {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
  font-variant-numeric: tabular-nums;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
}
.controls .icon-btn {
  color: rgba(255, 255, 255, 0.75);
}
.controls .icon-btn.on {
  color: #fff;
  background: rgba(255, 255, 255, 0.15);
}
.rep {
  position: relative;
}
.rep-one {
  position: absolute;
  top: 3px;
  right: 3px;
  min-width: 14px;
  height: 14px;
  border-radius: 7px;
  background: #fff;
  color: #0a1030;
  font-size: 10px;
  font-weight: 800;
  line-height: 14px;
  text-align: center;
}
.c-big,
.c-play {
  color: #fff !important;
  width: 56px !important;
  height: 56px !important;
  border-radius: 50% !important;
}
.right {
  min-height: 0;
  height: 100%;
}
.empty {
  position: relative;
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--text-2);
}
.m-extra {
  display: flex;
  justify-content: center;
  margin-top: 10px;
}
@media (max-width: 599px) {
  .layout {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0;
    padding: calc(var(--safe-top) + 56px) 24px calc(var(--safe-bottom) + 24px);
  }
  .left {
    width: 100%;
    max-width: 420px;
    margin: 0 auto;
  }
  .hero-art {
    width: min(100%, 46vh);
    margin: 0 auto;
  }
  .right {
    display: none;
  }
  /* Paroles : trois rangées fixes. En-tête (pochette, titre) en haut, paroles juste
     dessous sur toute la place libre, progression et commandes en bas ; les paroles ne
     passent jamais sous la barre de progression. */
  .layout.m-lyrics {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    justify-content: stretch;
    padding-top: calc(var(--safe-top) + 52px);
  }
  .m-lyrics .right {
    display: block;
    grid-row: 2;
    height: auto;
    min-height: 0;
    overflow: hidden;
  }
  .m-lyrics .hero-art,
  .m-lyrics .meta {
    display: none;
  }
  .m-lyrics .left {
    grid-row: 3;
    align-self: end;
    padding-top: 6px;
  }
  .m-head {
    grid-row: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    margin: 0 0 10px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    animation: head-in 0.35s cubic-bezier(0.2, 0.9, 0.25, 1);
  }
  .m-head-art {
    width: 56px;
    flex-shrink: 0;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
  }
  .m-head-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .m-head-text .t,
  .m-head-text .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .m-head-text .t {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
  }
  .m-head-text .a {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.65);
  }
  .m-lyrics .seek {
    margin-top: 4px;
  }
  .art-stage.vinyl,
  .art-stage.cd {
    width: min(100%, 44vh);
    margin: 0 auto;
  }
  .m-lyrics .art-stage {
    display: none;
  }
  .floor-viz {
    height: 16vh;
  }
  .collapse,
  .view-tools {
    top: calc(var(--safe-top) + 12px);
  }
  /* Fond allégé pour les téléphones modestes : un flou calculé une fois (plus d'image
     floutée qui tourne), des nappes de lumière sans flou ni fusion, sur leur propre
     calque. Sinon tout l'écran (et donc les paroles) rame. */
  .backdrop {
    contain: strict;
    will-change: transform;
  }
  .blob {
    animation: blob-in 0.6s ease both;
    filter: blur(48px) saturate(1.5) brightness(0.72);
  }
  /* Nappes de lumière immobiles sur téléphone : une animation plein écran sans fin fait
     travailler (et chauffer) le processeur graphique pendant toute l'écoute. */
  .aura {
    filter: none;
    mix-blend-mode: normal;
    animation: none;
  }
  .grain {
    display: none;
  }
}
/* Mode léger : ni pochette floutée ni nappes ; fond fixe en dégradé aux couleurs de la
   pochette, ombres réduites. */
:root[data-perf="lite"] .blob,
:root[data-perf="lite"] .aura,
:root[data-perf="lite"] .grain {
  display: none;
}
:root[data-perf="lite"] .backdrop {
  background:
    radial-gradient(120% 70% at 20% 0%, color-mix(in srgb, var(--amb-primary) 70%, transparent), transparent 70%),
    radial-gradient(100% 60% at 90% 100%, color-mix(in srgb, var(--amb-secondary) 60%, transparent), transparent 70%),
    var(--amb-base);
}
:root[data-perf="lite"] .hero-art {
  box-shadow: 0 16px 32px rgba(0, 0, 0, 0.45);
}
/* Pliable à moitié ouvert, charnière horizontale (mode Flex du Z Flip, Z Fold posé…) :
   paroles dans la moitié haute, titre, progression et commandes sous la charnière. Ne
   s'applique que sur les appareils qui signalent cette posture (segments d'affichage). */
@media (vertical-viewport-segments: 2) {
  .layout,
  .layout.m-lyrics {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: env(viewport-segment-height 0 0) env(viewport-segment-height 0 1);
    row-gap: calc(env(viewport-segment-top 0 1) - env(viewport-segment-bottom 0 0));
    padding: 0 calc(24px + var(--safe-right)) 0 calc(24px + var(--safe-left));
  }
  .right,
  .m-lyrics .right {
    display: block;
    grid-row: 1;
    height: auto;
    min-height: 0;
    overflow: hidden;
    padding-top: calc(var(--safe-top) + 48px);
  }
  .left,
  .m-lyrics .left {
    grid-row: 2;
    align-self: center;
    justify-self: center;
    width: min(100%, 520px);
  }
  .hero-art,
  .m-head,
  .m-extra {
    display: none;
  }
  .m-lyrics .meta {
    display: flex;
  }
}
</style>
