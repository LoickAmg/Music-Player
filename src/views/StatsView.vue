<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Artwork from "@/components/Artwork.vue";
import Icon from "@/components/Icon.vue";
import RecapStory from "@/components/RecapStory.vue";
import { buildRecap, evolution, formatListening, minutesLabel, monthName, nextPeriod, previousPeriod, type Period, type Ranked } from "@/lib/recap";
import { useLibraryStore } from "@/stores/library";
import { useListeningStore } from "@/stores/listening";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";

const listening = useListeningStore();
const library = useLibraryStore();
const player = usePlayerStore();
const ui = useUiStore();

const today = new Date();
const kind = ref<"month" | "year">("month");
const period = ref<Period>({ kind: "month", year: today.getFullYear(), month: today.getMonth() });
const story = ref(false);

onMounted(() => void listening.load());

function setKind(k: "month" | "year") {
  kind.value = k;
  const p = period.value;
  period.value = k === "year" ? { kind: "year", year: p.year } : { kind: "month", year: p.year, month: p.year === today.getFullYear() ? today.getMonth() : 11 };
}

const recap = computed(() => buildRecap(listening.music, period.value));
const isCurrent = computed(() => {
  const p = period.value;
  return p.kind === "year" ? p.year >= today.getFullYear() : p.year > today.getFullYear() || (p.year === today.getFullYear() && p.month >= today.getMonth());
});
const canGoBack = computed(() => {
  const since = listening.since;
  if (!since) return false;
  const p = period.value;
  return p.kind === "year" ? p.year > since.getFullYear() : p.year > since.getFullYear() || (p.year === since.getFullYear() && p.month > since.getMonth());
});
const change = computed(() => evolution(recap.value));
const previousLabel = computed(() => {
  const p = previousPeriod(period.value);
  return p.kind === "year" ? String(p.year) : monthName(p.month);
});
const maxTimeline = computed(() => Math.max(1, ...recap.value.timeline));
const maxHour = computed(() => Math.max(1, ...recap.value.byHour));
const timelineLabels = computed(() => (period.value.kind === "year" ? Array.from({ length: 12 }, (_, i) => monthName(i).slice(0, 3)) : recap.value.timeline.map((_, i) => String(i + 1))));
const empty = computed(() => listening.loaded && recap.value.totalSecs < 60);

const track = (r: Ranked) => library.byId(r.trackId) ?? null;
function playTop() {
  const ids = recap.value.topTracks.slice(0, 25).map((t) => t.key).filter((id) => library.byId(id));
  if (ids.length) void player.playQueue(ids, ids[0]);
}
</script>

<template>
  <div class="page stats">
    <header class="top">
      <div>
        <p class="eyebrow">Mon écoute</p>
        <h1 class="page-title">{{ period.kind === "year" ? `Mon année ${period.year}` : `${monthName(period.month).replace(/^./, (c) => c.toUpperCase())} ${period.year}` }}</h1>
      </div>
      <div class="controls">
        <div class="seg" role="group" aria-label="Période">
          <button type="button" :class="{ on: kind === 'month' }" @click="setKind('month')">Mois</button>
          <button type="button" :class="{ on: kind === 'year' }" @click="setKind('year')">Année</button>
        </div>
        <button type="button" class="icon-btn" aria-label="Période précédente" :disabled="!canGoBack" @click="period = previousPeriod(period)"><Icon name="prev" :size="15" /></button>
        <button type="button" class="icon-btn" aria-label="Période suivante" :disabled="isCurrent" @click="period = nextPeriod(period)"><Icon name="next" :size="15" /></button>
      </div>
    </header>

    <div v-if="!listening.loaded" class="empty"><span class="spinner" /> Lecture du journal d'écoute…</div>

    <div v-else-if="empty" class="empty card">
      <Icon name="stats" :size="34" />
      <p class="big">Pas encore assez d'écoute ici.</p>
      <p class="muted">
        Music Player compte désormais le temps que tu passes à écouter chaque morceau (pauses exclues). Écoute, reviens : ton mois et ton année en musique se
        construisent au fil des jours.
        <template v-if="listening.since"> Premières écoutes enregistrées le {{ listening.since.toLocaleDateString("fr-FR") }}.</template>
      </p>
    </div>

    <template v-else>
      <section class="hero card">
        <div class="hero-main">
          <p class="hero-value">{{ formatListening(recap.totalSecs) }}</p>
          <p class="hero-label">de musique · {{ minutesLabel(recap.totalSecs) }} minutes</p>
          <p v-if="change !== null" class="change" :class="change >= 0 ? 'up' : 'down'">
            {{ change >= 0 ? "▲" : "▼" }} {{ Math.abs(change) }} % par rapport à {{ previousLabel }}
          </p>
        </div>
        <div class="figures">
          <div><strong>{{ recap.plays.toLocaleString("fr-FR") }}</strong><span>écoutes</span></div>
          <div><strong>{{ recap.trackCount.toLocaleString("fr-FR") }}</strong><span>morceaux</span></div>
          <div><strong>{{ recap.artistCount.toLocaleString("fr-FR") }}</strong><span>artistes</span></div>
          <div><strong>{{ recap.activeDays }}</strong><span>jours en musique</span></div>
        </div>
        <button type="button" class="pill pill-accent story-btn" @click="story = true">
          <Icon name="sparkle" :size="16" /> {{ period.kind === "year" ? `Revivre mon année ${period.year}` : "Revivre ce mois en story" }}
        </button>
      </section>

      <section class="card">
        <h2>{{ period.kind === "year" ? "Mois par mois" : "Jour par jour" }}</h2>
        <div class="timeline" :class="period.kind">
          <div v-for="(secs, i) in recap.timeline" :key="i" class="bar-col" :title="`${timelineLabels[i]} : ${formatListening(secs)}`">
            <span class="bar" :style="{ height: `${Math.max(secs ? 4 : 0, (secs / maxTimeline) * 100)}%` }" />
            <span v-if="period.kind === 'year' || i % 5 === 0 || i === recap.timeline.length - 1" class="tick">{{ timelineLabels[i] }}</span>
          </div>
        </div>
      </section>

      <div class="cols">
        <section class="card">
          <div class="head">
            <h2>Morceaux du moment</h2>
            <button type="button" class="link" @click="playTop"><Icon name="play" :size="12" /> Écouter</button>
          </div>
          <ol class="rank">
            <li v-for="(t, i) in recap.topTracks.slice(0, 5)" :key="t.key" @dblclick="library.byId(t.key) && player.playTrackNow(t.key)">
              <span class="n">{{ i + 1 }}</span>
              <Artwork :track="track(t)" :radius="5" class="art" />
              <span class="txt"><b>{{ t.label }}</b><small>{{ t.sub }}</small></span>
              <span class="val">{{ t.plays }} ×</span>
            </li>
          </ol>
        </section>
        <section class="card">
          <h2>Artistes</h2>
          <ol class="rank">
            <li v-for="(a, i) in recap.topArtists.slice(0, 5)" :key="a.key" @click="ui.go({ name: 'artists', artist: a.label })">
              <span class="n">{{ i + 1 }}</span>
              <Artwork :track="track(a)" :radius="50" class="art round" />
              <span class="txt"><b>{{ a.label }}</b><small>{{ a.plays }} écoutes</small></span>
              <span class="val">{{ formatListening(a.secs) }}</span>
            </li>
          </ol>
        </section>
        <section class="card">
          <h2>Albums</h2>
          <ol class="rank">
            <li v-for="(a, i) in recap.topAlbums.slice(0, 5)" :key="a.key">
              <span class="n">{{ i + 1 }}</span>
              <Artwork :track="track(a)" :radius="5" class="art" />
              <span class="txt"><b>{{ a.label }}</b><small>{{ a.sub }}</small></span>
              <span class="val">{{ formatListening(a.secs) }}</span>
            </li>
          </ol>
        </section>
        <section class="card persona">
          <h2>Ton profil d'écoute</h2>
          <p class="persona-title"><Icon name="sparkle" :size="18" /> {{ recap.personality.title }}</p>
          <p class="muted">{{ recap.personality.text }}</p>
          <div class="clock" aria-label="Écoute selon l'heure">
            <span v-for="(secs, h) in recap.byHour" :key="h" class="hour" :style="{ height: `${Math.max(3, (secs / maxHour) * 100)}%` }" :title="`${h} h : ${formatListening(secs)}`" />
          </div>
          <div class="clock-axis"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>23 h</span></div>
          <ul class="facts">
            <li v-if="recap.bestDay">Ton plus grand jour : <b>{{ recap.bestDay.date.toLocaleDateString("fr-FR", { day: "numeric", month: "long" }) }}</b>, {{ formatListening(recap.bestDay.secs) }}</li>
            <li v-if="recap.longestStreak && recap.longestStreak.days > 1">Plus longue série : <b>{{ recap.longestStreak.days }} jours</b> d'affilée</li>
            <li v-if="recap.discoveries.length"><b>{{ recap.discoveries.length }}</b> artiste{{ recap.discoveries.length > 1 ? "s" : "" }} découvert{{ recap.discoveries.length > 1 ? "s" : "" }}</li>
            <li v-if="recap.topGenres.length">Genre favori : <b>{{ recap.topGenres[0].label }}</b></li>
          </ul>
        </section>
      </div>
    </template>

    <RecapStory v-if="story" :recap="recap" @close="story = false" />
  </div>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}
.eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
}
.page-title {
  margin: 4px 0 0;
}
.controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.seg {
  display: inline-flex;
  padding: 3px;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.07);
}
.seg button {
  border: 0;
  border-radius: 999px;
  padding: 6px 14px;
  background: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.seg button.on {
  background: var(--accent);
  color: #fff;
}
.card {
  padding: 18px 20px;
  border-radius: 16px;
  background: rgba(var(--fg-rgb), 0.045);
  box-shadow: inset 0 0 0 1px rgba(var(--fg-rgb), 0.07);
}
.card h2 {
  margin: 0 0 12px;
  font-size: 15px;
}
.hero {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 18px;
  align-items: center;
  overflow: hidden;
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--accent) 38%, transparent), transparent 60%),
    rgba(var(--fg-rgb), 0.05);
}
.hero-value {
  margin: 0;
  font-size: clamp(40px, 6vw, 68px);
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1;
}
.hero-label {
  margin: 6px 0 0;
  color: var(--text-2);
}
.change {
  display: inline-block;
  margin: 10px 0 0;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}
.change.up {
  background: rgba(70, 200, 120, 0.16);
  color: #4fd18b;
}
.change.down {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.figures {
  display: grid;
  grid-template-columns: repeat(2, minmax(90px, 1fr));
  gap: 10px 22px;
}
.figures div {
  display: flex;
  flex-direction: column;
}
.figures strong {
  font-size: 22px;
}
.figures span {
  font-size: 12px;
  color: var(--text-2);
}
.story-btn {
  grid-column: 1 / -1;
  justify-self: start;
}
.timeline {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 140px;
  padding-bottom: 18px;
}
.bar-col {
  position: relative;
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.bar {
  width: 100%;
  border-radius: 4px 4px 2px 2px;
  background: linear-gradient(to top, var(--accent), color-mix(in srgb, var(--accent) 55%, #fff));
  animation: grow 0.7s var(--ease) both;
  transform-origin: bottom;
}
@keyframes grow {
  from {
    transform: scaleY(0);
  }
}
.tick {
  position: absolute;
  bottom: -18px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
}
.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 18px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
}
.rank {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rank li {
  display: grid;
  grid-template-columns: 18px 42px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 4px;
  border-radius: 8px;
  cursor: default;
}
.rank li:hover {
  background: rgba(var(--fg-rgb), 0.06);
}
.n {
  font-weight: 800;
  color: var(--text-3);
  text-align: right;
}
.art {
  width: 42px;
  height: 42px;
}
.txt {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.txt b,
.txt small {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.txt small {
  color: var(--text-2);
}
.val {
  font-size: 12px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.persona-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 800;
  color: var(--accent);
}
.muted {
  color: var(--text-2);
  line-height: 1.5;
}
.clock {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 60px;
  margin-top: 14px;
}
.hour {
  flex: 1;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 70%, transparent);
}
.clock-axis {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-3);
  margin-top: 4px;
}
.facts {
  margin: 14px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 24px;
  text-align: center;
  color: var(--text-2);
}
.empty .big {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-1, inherit);
}
.empty .muted {
  max-width: 520px;
}
@media (max-width: 760px) {
  .hero {
    grid-template-columns: 1fr;
  }
}
</style>
