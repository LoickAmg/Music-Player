<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Artwork from "@/components/Artwork.vue";
import Icon from "@/components/Icon.vue";
import { coverUrl } from "@/lib/covers";
import { css, paletteFromImage, type Palette } from "@/lib/palette";
import { formatListening, minutesLabel, monthName, type Ranked, type Recap } from "@/lib/recap";
import { canvasToPng, drawRecapCard } from "@/lib/recapCard";
import { api } from "@/lib/api";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";

/**
 * Rétrospective en « story » plein écran : une suite de cartes animées qui défilent seules
 * (toucher à droite : suivante, à gauche : précédente, appui long : pause), et une carte
 * finale à enregistrer ou à capturer pour la partager.
 */
const props = defineProps<{ recap: Recap }>();
const emit = defineEmits<{ close: [] }>();

const library = useLibraryStore();
const player = usePlayerStore();
const ui = useUiStore();
const ON_ANDROID = /Android/i.test(navigator.userAgent);
const SLIDE_MS = 7000;

const r = computed(() => props.recap);
/** Première lettre en majuscule (« octobre » → « Octobre »). */
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** « 1er octobre », « 15 octobre ». */
function dayLabel(date: Date, withWeekday = false): string {
  const day = date.getDate() === 1 ? "1er" : String(date.getDate());
  const weekday = withWeekday ? `${date.toLocaleDateString("fr-FR", { weekday: "long" })} ` : "";
  return `${weekday}${day} ${monthName(date.getMonth())}`;
}
const year = computed(() => r.value.period.kind === "year");
const monthIndex = computed(() => (r.value.period.kind === "month" ? r.value.period.month : 0));
const top = (list: Ranked[]) => list[0] ?? null;
const track = (x: Ranked | null) => (x ? (library.byId(x.trackId) ?? null) : null);

const slides = computed(() => {
  const list = ["intro", "minutes", year.value ? "months" : "days"];
  if (r.value.topGenres.length >= 2) list.push("genre");
  if (r.value.topArtists.length) list.push("artist", "artists");
  if (r.value.topTracks.length) list.push("track", "tracks");
  if (r.value.obsession) list.push("obsession");
  list.push("clock");
  if (r.value.longestStreak && r.value.longestStreak.days >= 3) list.push("streak");
  if (r.value.discoveries.length >= 2) list.push("discoveries");
  list.push("summary");
  return list;
});

const index = ref(0);
const elapsed = ref(0);
const paused = ref(false);
const current = computed(() => slides.value[index.value]);

// Couleurs : celles de la pochette du morceau n°1 (repli : dégradé violet-rose).
const palette = ref<Palette | null>(null);
const topCover = ref<string | null>(null);
onMounted(async () => {
  topCover.value = await coverUrl(track(top(r.value.topTracks)) ?? track(top(r.value.topArtists)));
  if (topCover.value) palette.value = await paletteFromImage(topCover.value);
});
const colors = computed(() => {
  const p = palette.value;
  return {
    "--c1": p ? css(p.glow) : "rgb(124, 92, 255)",
    "--c2": p ? css(p.secondary) : "rgb(255, 79, 163)",
    "--c3": p ? css(p.base) : "rgb(18, 12, 34)",
  };
});
/** Chaque carte a son ambiance : les teintes de la pochette, tournées différemment. */
const HUES = [0, 40, 200, 300, 120, 260, 20, 180, 330, 80, 230, 150, 0];

// Compteur animé (minutes) au moment où la carte apparaît.
const counter = ref(0);
let counterFrame = 0;
function countTo(target: number) {
  cancelAnimationFrame(counterFrame);
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / 1800);
    counter.value = Math.round(target * (1 - Math.pow(1 - t, 3)));
    if (t < 1) counterFrame = requestAnimationFrame(step);
  };
  counterFrame = requestAnimationFrame(step);
}
watch(
  current,
  (id) => {
    elapsed.value = 0;
    if (id === "minutes") countTo(Math.round(r.value.totalSecs / 60));
  },
  { immediate: true },
);

// Défilement automatique (pas sur la carte finale).
let frame = 0;
let last = performance.now();
function loop(now: number) {
  const dt = now - last;
  last = now;
  if (!paused.value && current.value !== "summary" && !document.hidden) {
    elapsed.value += dt;
    if (elapsed.value >= SLIDE_MS) next();
  }
  frame = requestAnimationFrame(loop);
}
function next() {
  if (index.value < slides.value.length - 1) index.value += 1;
}
function prev() {
  if (index.value > 0) index.value -= 1;
  else elapsed.value = 0;
}

// Appui long : pause ; appui bref : carte suivante ou précédente selon le côté.
let downAt = 0;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
function onDown() {
  downAt = performance.now();
  holdTimer = setTimeout(() => (paused.value = true), 220);
}
function onUp(e: PointerEvent) {
  clearTimeout(holdTimer);
  const wasHold = performance.now() - downAt > 220;
  paused.value = false;
  if (wasHold || (e.target as HTMLElement).closest("button, a")) return;
  if (e.clientX < window.innerWidth * 0.3) prev();
  else next();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  else if (e.key === "ArrowRight") next();
  else if (e.key === "ArrowLeft") prev();
  else if (e.key === " ") {
    e.preventDefault();
    paused.value = !paused.value;
  }
}
onMounted(() => {
  frame = requestAnimationFrame(loop);
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  cancelAnimationFrame(counterFrame);
  clearTimeout(holdTimer);
  window.removeEventListener("keydown", onKey);
});

// Bande-son : les morceaux du classement, sur demande.
const soundtrack = ref(false);
function playSoundtrack() {
  const ids = r.value.topTracks.slice(0, 20).map((t) => t.key).filter((id) => library.byId(id));
  if (!ids.length) return;
  soundtrack.value = true;
  void player.playQueue(ids, ids[0]);
}

const bestMonth = computed(() => {
  const t = r.value.timeline;
  const i = t.indexOf(Math.max(...t));
  return { index: i, secs: t[i] ?? 0 };
});
/** Mois en cours : le graphique s'arrête à aujourd'hui (pas de jours vides à venir). */
const timeline = computed(() => {
  const p = r.value.period;
  const now = new Date();
  return p.kind === "month" && p.year === now.getFullYear() && p.month === now.getMonth() ? r.value.timeline.slice(0, now.getDate()) : r.value.timeline;
});
const maxTimeline = computed(() => Math.max(1, ...timeline.value));
const maxHour = computed(() => Math.max(1, ...r.value.byHour));
const peakHour = computed(() => r.value.byHour.indexOf(Math.max(...r.value.byHour)));
const fullDays = computed(() => r.value.totalSecs / 86400);
const subject = computed(() => (year.value ? `cette année` : `en ${monthName((r.value.period as { month: number }).month)}`));

const saving = ref(false);
async function saveCard() {
  saving.value = true;
  try {
    const canvas = await drawRecapCard(r.value, palette.value, topCover.value);
    const path = await api.saveImage(await canvasToPng(canvas), `Ma musique ${r.value.label}`);
    ui.notify(`Image enregistrée : ${path}`);
  } catch (e) {
    ui.notify(`Enregistrement impossible : ${String(e)}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="story" :style="{ ...colors, '--hue': `${HUES[index % HUES.length]}deg` }" role="dialog" aria-modal="true" :aria-label="`Rétrospective ${r.label}`" @pointerdown="onDown" @pointerup="onUp">
      <div class="bg" aria-hidden="true"><i /><i /><i /></div>

      <div class="bars" aria-hidden="true">
        <span v-for="(s, i) in slides" :key="s"><b :style="{ width: i < index ? '100%' : i === index ? `${Math.min(100, (elapsed / SLIDE_MS) * 100)}%` : '0%' }" /></span>
      </div>
      <div class="chrome">
        <span class="brand">{{ year ? `Ton année ${r.period.year}` : `Ton mois de ${monthName(monthIndex)}` }}</span>
        <button type="button" class="close" aria-label="Fermer" @click="emit('close')"><Icon name="close" :size="18" /></button>
      </div>

      <Transition name="slide" mode="out-in">
        <section :key="current" class="slide" :class="`s-${current}`">
          <template v-if="current === 'intro'">
            <p class="kicker rise">{{ year ? "Ton année en musique" : "Ton mois en musique" }}</p>
            <h1 class="giant pop" :class="{ word: !year }">{{ year ? r.period.year : cap(monthName(monthIndex)) }}</h1>
            <p class="lead rise d2">On a écouté avec toi. Voici ce que ta musique raconte {{ subject }}.</p>
            <button v-if="!soundtrack" type="button" class="cta rise d3" @click="playSoundtrack"><Icon name="play" :size="14" /> Avec ta bande-son</button>
            <p v-else class="hint rise">♪ Ta bande-son est lancée</p>
          </template>

          <template v-else-if="current === 'minutes'">
            <p class="kicker rise">Tu as écouté</p>
            <p class="giant pop num">{{ counter.toLocaleString("fr-FR") }}</p>
            <p class="lead rise d2">minutes de musique {{ subject }}.</p>
            <p v-if="fullDays >= 1" class="note rise d3">Soit {{ fullDays.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) }} jours entiers, sans pause.</p>
            <p v-else class="note rise d3">{{ formatListening(r.totalSecs) }} au total, sur {{ r.activeDays }} jour{{ r.activeDays > 1 ? "s" : "" }}.</p>
          </template>

          <template v-else-if="current === 'months'">
            <p class="kicker rise">Ton mois le plus musical</p>
            <h2 class="big pop">{{ cap(monthName(bestMonth.index)) }}</h2>
            <p class="lead rise d2">{{ formatListening(bestMonth.secs) }} d'écoute.</p>
            <div class="chart rise d3">
              <span v-for="(secs, i) in r.timeline" :key="i" :class="{ hot: i === bestMonth.index }" :style="{ height: `${Math.max(4, (secs / maxTimeline) * 100)}%`, animationDelay: `${0.6 + i * 0.05}s` }" />
            </div>
          </template>

          <template v-else-if="current === 'days'">
            <p class="kicker rise">Ton jour le plus musical</p>
            <h2 class="big pop">{{ r.bestDay ? cap(dayLabel(r.bestDay.date, true)) : "" }}</h2>
            <p class="lead rise d2">{{ formatListening(r.bestDay?.secs ?? 0) }} de musique ce jour-là.</p>
            <div class="chart rise d3">
              <span v-for="(secs, i) in timeline" :key="i" :class="{ hot: r.bestDay && i === r.bestDay.date.getDate() - 1 }" :style="{ height: `${Math.max(3, (secs / maxTimeline) * 100)}%`, animationDelay: `${0.5 + i * 0.02}s` }" />
            </div>
          </template>

          <template v-else-if="current === 'genre'">
            <p class="kicker rise">Ton genre</p>
            <h2 class="big pop">{{ r.topGenres[0].label }}</h2>
            <ol class="list rise d2">
              <li v-for="(g, i) in r.topGenres.slice(1, 5)" :key="g.key" :style="{ animationDelay: `${0.5 + i * 0.12}s` }"><b>{{ i + 2 }}</b> {{ g.label }}</li>
            </ol>
          </template>

          <template v-else-if="current === 'artist'">
            <p class="kicker rise">Ton artiste n°1</p>
            <div class="cover round pop"><Artwork :track="track(top(r.topArtists))" :radius="999" eager /></div>
            <h2 class="big rise d2">{{ r.topArtists[0].label }}</h2>
            <p class="lead rise d3">{{ formatListening(r.topArtists[0].secs) }} ensemble, {{ r.topArtists[0].plays }} écoutes.</p>
          </template>

          <template v-else-if="current === 'artists'">
            <p class="kicker rise">Tes artistes</p>
            <ol class="list ranked">
              <li v-for="(a, i) in r.topArtists.slice(0, 5)" :key="a.key" class="in" :style="{ animationDelay: `${0.2 + i * 0.18}s` }">
                <b>{{ i + 1 }}</b><span class="mini round"><Artwork :track="track(a)" :radius="999" eager /></span><span class="name">{{ a.label }}</span>
              </li>
            </ol>
          </template>

          <template v-else-if="current === 'track'">
            <p class="kicker rise">Ton morceau n°1</p>
            <div class="cover pop spin-in"><Artwork :track="track(top(r.topTracks))" :radius="14" eager /></div>
            <h2 class="big rise d2">{{ r.topTracks[0].label }}</h2>
            <p class="lead rise d3">{{ r.topTracks[0].sub }} · écouté {{ r.topTracks[0].plays }} fois.</p>
          </template>

          <template v-else-if="current === 'tracks'">
            <p class="kicker rise">Tes morceaux</p>
            <ol class="list ranked">
              <li v-for="(t, i) in r.topTracks.slice(0, 5)" :key="t.key" class="in" :style="{ animationDelay: `${0.2 + i * 0.18}s` }">
                <b>{{ i + 1 }}</b><span class="mini"><Artwork :track="track(t)" :radius="6" eager /></span>
                <span class="name">{{ t.label }}<small>{{ t.sub }}</small></span>
              </li>
            </ol>
          </template>

          <template v-else-if="current === 'obsession' && r.obsession">
            <p class="kicker rise">Le {{ dayLabel(r.obsession.date) }}</p>
            <p class="giant pop num">{{ r.obsession.plays }}×</p>
            <p class="lead rise d2">C'est le nombre de fois où tu as écouté « {{ r.obsession.track.label }} » ce jour-là.</p>
            <p class="note rise d3">On ne juge pas. On comprend.</p>
          </template>

          <template v-else-if="current === 'clock'">
            <p class="kicker rise">Ton profil d'écoute</p>
            <h2 class="big pop">{{ r.personality.title }}</h2>
            <p class="lead rise d2">{{ r.personality.text }}</p>
            <div class="clock rise d3">
              <span v-for="(secs, h) in r.byHour" :key="h" :class="{ hot: h === peakHour }" :style="{ height: `${Math.max(4, (secs / maxHour) * 100)}%`, animationDelay: `${0.6 + h * 0.03}s` }" />
            </div>
            <p class="note rise d3">Ton heure de pointe : {{ peakHour }} h.</p>
          </template>

          <template v-else-if="current === 'streak' && r.longestStreak">
            <p class="kicker rise">Jamais sans musique</p>
            <p class="giant pop num">{{ r.longestStreak.days }}</p>
            <p class="lead rise d2">jours d'affilée en musique, du {{ dayLabel(r.longestStreak.from) }} au {{ dayLabel(r.longestStreak.to) }}.</p>
          </template>

          <template v-else-if="current === 'discoveries'">
            <p class="kicker rise">Nouvelles rencontres</p>
            <p class="giant pop num">{{ r.discoveries.length }}</p>
            <p class="lead rise d2">artistes découverts {{ subject }}, dont :</p>
            <ul class="chips rise d3">
              <li v-for="name in r.discoveries.slice(0, 8)" :key="name">{{ name }}</li>
            </ul>
          </template>

          <template v-else-if="current === 'summary'">
            <div class="card pop">
              <div class="card-head">
                <div class="card-cover"><Artwork :track="track(top(r.topTracks))" :radius="12" eager /></div>
                <div>
                  <p class="kicker">{{ year ? "Mon année en musique" : "Mon mois en musique" }}</p>
                  <p class="card-title">{{ year ? r.period.year : cap(r.label) }}</p>
                </div>
              </div>
              <div class="card-cols">
                <div>
                  <p class="card-label">Top artistes</p>
                  <ol><li v-for="a in r.topArtists.slice(0, 5)" :key="a.key">{{ a.label }}</li></ol>
                </div>
                <div>
                  <p class="card-label">Top morceaux</p>
                  <ol><li v-for="t in r.topTracks.slice(0, 5)" :key="t.key">{{ t.label }}</li></ol>
                </div>
              </div>
              <div class="card-cols">
                <div><p class="card-label">Minutes d'écoute</p><p class="card-big">{{ minutesLabel(r.totalSecs) }}</p></div>
                <div><p class="card-label">Profil</p><p class="card-big small">{{ r.personality.title }}</p></div>
              </div>
            </div>
            <div class="actions rise d2">
              <button v-if="!ON_ANDROID" type="button" class="cta" :disabled="saving" @click="saveCard"><Icon name="plus" :size="14" /> {{ saving ? "Enregistrement…" : "Enregistrer l'image" }}</button>
              <p v-else class="hint">Fais une capture d'écran pour la partager.</p>
              <button type="button" class="ghost" @click="index = 0">Revoir</button>
              <button type="button" class="ghost" @click="emit('close')">Terminer</button>
            </div>
          </template>
        </section>
      </Transition>

      <p v-if="paused" class="paused">Pause</p>
    </div>
  </Teleport>
</template>

<style scoped>
.story {
  position: fixed;
  inset: 0;
  z-index: 200;
  overflow: hidden;
  color: #fff;
  background: var(--c3);
  user-select: none;
  touch-action: manipulation;
  font-family: var(--font-ui, inherit);
}
/* Fond vivant : trois halos aux couleurs de la pochette, qui dérivent lentement et changent
   de teinte à chaque carte. */
.bg {
  position: absolute;
  inset: -20%;
  filter: hue-rotate(var(--hue)) saturate(1.2);
  transition: filter 0.9s ease;
}
.bg i {
  position: absolute;
  width: 70vmax;
  height: 70vmax;
  border-radius: 50%;
  filter: blur(60px);
  opacity: 0.75;
  animation: drift 18s ease-in-out infinite alternate;
}
.bg i:nth-child(1) {
  background: radial-gradient(circle, var(--c1), transparent 65%);
  top: -10%;
  left: -10%;
}
.bg i:nth-child(2) {
  background: radial-gradient(circle, var(--c2), transparent 65%);
  bottom: -15%;
  right: -10%;
  animation-duration: 22s;
}
.bg i:nth-child(3) {
  background: radial-gradient(circle, var(--c1), transparent 70%);
  top: 40%;
  left: 30%;
  width: 40vmax;
  height: 40vmax;
  opacity: 0.45;
  animation-duration: 15s;
}
@keyframes drift {
  to {
    transform: translate(8%, -6%) scale(1.12);
  }
}
.bars {
  position: absolute;
  top: calc(12px + env(safe-area-inset-top));
  left: 16px;
  right: 16px;
  display: flex;
  gap: 4px;
  z-index: 3;
}
.bars span {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.28);
  overflow: hidden;
}
.bars b {
  display: block;
  height: 100%;
  background: #fff;
}
.chrome {
  position: absolute;
  top: calc(24px + env(safe-area-inset-top));
  left: 16px;
  right: 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  z-index: 3;
}
.brand {
  font-size: 13px;
  font-weight: 700;
  opacity: 0.85;
}
.close {
  border: 0;
  border-radius: 50%;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.25);
  color: #fff;
}
.slide {
  position: relative;
  z-index: 2;
  height: 100%;
  max-width: 640px;
  margin: 0 auto;
  padding: 90px 28px 60px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
}
.kicker {
  margin: 0;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.85;
}
.giant {
  margin: 0;
  font-size: clamp(72px, 18vw, 170px);
  font-weight: 900;
  letter-spacing: -0.05em;
  line-height: 0.95;
}
.num {
  font-variant-numeric: tabular-nums;
}
/* Nom du mois : jamais coupé en deux, taille calée sur la largeur (« septembre » compris). */
.giant.word {
  white-space: nowrap;
  font-size: clamp(44px, calc((min(100vw, 640px) - 56px) / 5.6), 120px);
}
.big {
  margin: 0;
  font-size: clamp(38px, 8vw, 72px);
  font-weight: 900;
  letter-spacing: -0.03em;
  line-height: 1;
}
.lead {
  margin: 0;
  font-size: clamp(18px, 3vw, 24px);
  font-weight: 600;
  line-height: 1.35;
}
.note,
.hint {
  margin: 0;
  font-size: 15px;
  opacity: 0.75;
}
.cta {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 999px;
  padding: 12px 20px;
  background: #fff;
  color: #111;
  font-weight: 800;
}
.ghost {
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 999px;
  padding: 11px 18px;
  background: none;
  color: #fff;
  font-weight: 700;
}
.cover {
  width: min(62vw, 300px);
  aspect-ratio: 1;
  box-shadow: 0 30px 60px rgba(0, 0, 0, 0.45);
  border-radius: 14px;
}
.cover.round {
  border-radius: 50%;
  overflow: hidden;
}
.cover :deep(*) {
  width: 100%;
  height: 100%;
}
.list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: clamp(20px, 3.4vw, 28px);
  font-weight: 800;
}
.ranked li {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.ranked b {
  width: 28px;
  opacity: 0.7;
}
.mini {
  width: 56px;
  height: 56px;
  flex: none;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
  border-radius: 6px;
  overflow: hidden;
}
.mini.round {
  border-radius: 50%;
}
.mini :deep(*) {
  width: 100%;
  height: 100%;
}
.name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.name small {
  font-size: 15px;
  font-weight: 600;
  opacity: 0.7;
}
.chart,
.clock {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 160px;
  margin-top: 10px;
}
.chart span,
.clock span {
  flex: 1;
  border-radius: 6px 6px 2px 2px;
  background: rgba(255, 255, 255, 0.4);
  transform-origin: bottom;
  animation: grow 0.8s cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
}
.chart span.hot,
.clock span.hot {
  background: #fff;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.chips li {
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  font-weight: 700;
}
.card {
  padding: 22px;
  border-radius: 24px;
  background: rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(20px);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.card-head {
  display: flex;
  gap: 16px;
  align-items: center;
}
.card-cover {
  width: 96px;
  height: 96px;
  flex: none;
  border-radius: 12px;
  overflow: hidden;
}
.card-cover :deep(*) {
  width: 100%;
  height: 100%;
}
.card-title {
  margin: 4px 0 0;
  font-size: 34px;
  font-weight: 900;
}
.card-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.card-label {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.75;
}
.card ol {
  margin: 0;
  padding-left: 20px;
  font-weight: 700;
  line-height: 1.6;
}
.card ol li {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.card-big {
  margin: 0;
  font-size: 34px;
  font-weight: 900;
}
.card-big.small {
  font-size: 24px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.paused {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  margin: 0;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.35);
  font-size: 13px;
  font-weight: 700;
  z-index: 3;
}
/* Entrées : les éléments arrivent l'un après l'autre. */
.rise {
  animation: rise 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.d2 {
  animation-delay: 0.35s;
}
.d3 {
  animation-delay: 0.7s;
}
.pop {
  animation: pop 0.8s cubic-bezier(0.2, 1.3, 0.3, 1) both;
}
.spin-in {
  animation: spin-in 0.9s cubic-bezier(0.2, 1.1, 0.3, 1) both;
}
.in {
  animation: slide-in 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(24px);
  }
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.6);
  }
}
@keyframes spin-in {
  from {
    opacity: 0;
    transform: rotate(-12deg) scale(0.7);
  }
}
@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateX(40px);
  }
}
@keyframes grow {
  from {
    transform: scaleY(0);
  }
}
.slide-enter-active,
.slide-leave-active {
  transition:
    opacity 0.35s ease,
    transform 0.35s ease;
}
.slide-enter-from {
  opacity: 0;
  transform: translateX(30px);
}
.slide-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}
@media (prefers-reduced-motion: reduce) {
  .bg i,
  .rise,
  .pop,
  .spin-in,
  .in,
  .chart span,
  .clock span {
    animation: none;
  }
}
</style>
