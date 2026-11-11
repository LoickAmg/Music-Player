<script setup lang="ts">
import { computed, ref } from "vue";
import { type SharedTrack, useShareStore } from "@/stores/share";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import Icon from "@/components/Icon.vue";

// Sons partagés : tout ce qui a été reçu ou envoyé (discussion, partage, copie entre mes
// appareils), avec qui, par où et quand. Gardé sur l'appareil (500 derniers).
const share = useShareStore();
const library = useLibraryStore();
const player = usePlayerStore();

type Filter = "tous" | SharedTrack["direction"];
const filter = ref<Filter>("tous");
const FILTERS: { id: Filter; label: string }[] = [
  { id: "tous", label: "Tous" },
  { id: "recu", label: "Reçus" },
  { id: "envoye", label: "Envoyés" },
];
const VIA: Record<NonNullable<SharedTrack["via"]>, string> = { discussion: "discussion", partage: "partage", appareils: "mes appareils" };

const items = computed(() => share.shared.filter((s) => filter.value === "tous" || s.direction === filter.value));
const counts = computed(() => ({
  tous: share.shared.length,
  recu: share.shared.filter((s) => s.direction === "recu").length,
  envoye: share.shared.filter((s) => s.direction === "envoye").length,
}));

const dayFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const timeFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
function dayLabel(at: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return "Aujourd'hui";
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return "Hier";
  const label = dayFormat.format(d);
  return label.charAt(0).toUpperCase() + label.slice(1);
}
const groups = computed(() => {
  const out: { day: string; items: SharedTrack[] }[] = [];
  for (const s of items.value) {
    const day = dayLabel(s.at);
    const last = out[out.length - 1];
    if (last?.day === day) last.items.push(s);
    else out.push({ day, items: [s] });
  }
  return out;
});

function describe(s: SharedTrack) {
  const t = library.byId(s.id);
  return { track: t, title: t?.title ?? s.title ?? "Morceau", artist: t?.artist ?? s.artist ?? "" };
}
function meta(s: SharedTrack): string {
  const who = s.who ? `${s.direction === "recu" ? "De" : "À"} ${s.who}` : s.direction === "recu" ? "Reçu" : "Envoyé";
  return [who, s.via ? VIA[s.via] : null, timeFormat.format(new Date(s.at))].filter(Boolean).join(" · ");
}
function play(s: SharedTrack) {
  const ids = [...new Set(items.value.map((x) => x.id).filter((id) => !!library.byId(id)))];
  void player.playQueue(ids, s.id);
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Sons partagés</h1>
    <div class="filters" role="tablist" aria-label="Filtrer les sons partagés">
      <button v-for="f in FILTERS" :key="f.id" type="button" role="tab" :aria-selected="filter === f.id" :class="{ on: filter === f.id }" @click="filter = f.id">
        {{ f.label }} <span class="count">{{ counts[f.id] }}</span>
      </button>
    </div>

    <div v-if="!items.length" class="empty">
      <Icon name="share" :size="34" />
      <p><strong>Rien pour l'instant.</strong></p>
      <p>Les sons reçus ou envoyés (discussion avec un proche, partage, copie entre vos appareils) apparaîtront ici. Les sons reçus sont rangés dans Musique › Music Player › Reçus.</p>
    </div>

    <section v-for="g in groups" :key="g.day" class="day">
      <h2>{{ g.day }}</h2>
      <ul>
        <li v-for="s in g.items" :key="`${s.direction}-${s.id}-${s.at}`" :class="['item', s.direction]">
          <span class="dir" :aria-label="s.direction === 'recu' ? 'Reçu' : 'Envoyé'"><Icon :name="s.direction === 'recu' ? 'import' : 'share'" :size="16" /></span>
          <span class="text">
            <strong>{{ describe(s).title }}</strong>
            <small>{{ describe(s).artist }}<template v-if="describe(s).artist"> · </template>{{ meta(s) }}</small>
          </span>
          <button v-if="describe(s).track" type="button" class="icon-btn play" :aria-label="`Écouter ${describe(s).title}`" @click="play(s)"><Icon name="play" :size="16" /></button>
          <small v-else class="gone">Plus sur cet appareil</small>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 20px;
}
.filters button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-2);
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.filters button.on {
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}
.count {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  opacity: 0.75;
}
.empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 48px 16px;
  text-align: center;
  color: var(--text-2);
}
.empty p {
  margin: 0;
  max-width: 46ch;
}
.empty strong {
  color: var(--text);
}
.day + .day {
  margin-top: 22px;
}
.day h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-2);
}
ul {
  margin: 0;
  padding: 0;
  list-style: none;
  border-radius: 14px;
  background: var(--bg-hover);
  overflow: hidden;
}
.item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 58px;
  padding: 8px 12px 8px 14px;
}
.item + .item {
  border-top: 1px solid color-mix(in srgb, var(--text) 7%, transparent);
}
.dir {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}
.envoye .dir {
  background: color-mix(in srgb, var(--text) 10%, transparent);
  color: var(--text-2);
}
.text {
  display: grid;
  flex: 1;
  min-width: 0;
}
.text strong,
.text small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.text strong {
  font-size: 14.5px;
  font-weight: 600;
}
.text small {
  font-size: 12.5px;
  color: var(--text-2);
}
.play {
  flex: none;
  width: 40px;
  height: 40px;
}
.gone {
  flex: none;
  font-size: 11.5px;
  color: var(--text-2);
}
</style>
