<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { collator, formatDuration } from "@/lib/format";
import type { Album, Track } from "@/lib/types";
import { SCROLLER } from "@/lib/virtual";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Artwork from "./Artwork.vue";
import Icon from "./Icon.vue";
import VirtualList from "./VirtualList.vue";

// Sélecteur « Ajouter des morceaux » ouvert depuis une playlist : recherche instantanée,
// sélection multiple (qui survit aux recherches successives), albums ou artistes entiers
// d'un geste. Plein écran sur téléphone, grande fenêtre sur ordinateur.
const ui = useUiStore();
const library = useLibraryStore();
const playlists = usePlaylistsStore();

type Tab = "tracks" | "albums" | "artists";
type Group = { key: string; title: string; subtitle: string; cover: Track | null; tracks: Track[] };

const playlist = computed(() => (ui.trackPicker ? playlists.byId(ui.trackPicker) : null));
const inPlaylist = computed(() => new Set(playlist.value?.track_ids ?? []));

const query = ref("");
const tab = ref<Tab>("tracks");
const sort = ref<"az" | "recent">("az");
const selected = ref(new Set<string>());
const onlySelected = ref(false);
const busy = ref(false);
const lastClicked = ref<number | null>(null);

const list = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
provide(SCROLLER, list);

// Recherche sans accents ni casse (« celine » trouve « Céline »).
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const haystacks = computed(() => new Map(library.tracks.map((t) => [t.id, fold(`${t.title} ${t.artist} ${t.album} ${t.album_artist}`)])));
const words = computed(() => fold(query.value).split(/\s+/).filter(Boolean));
const hit = (t: Track) => {
  const hay = haystacks.value.get(t.id) ?? "";
  return words.value.every((w) => hay.includes(w));
};

const sortedTracks = computed(() => {
  const all = [...library.tracks];
  if (sort.value === "recent") all.sort((a, b) => b.added_secs - a.added_secs || collator.compare(a.title, b.title));
  else all.sort((a, b) => collator.compare(a.title, b.title) || collator.compare(a.artist, b.artist));
  return all;
});

const tracks = computed(() => {
  if (onlySelected.value) return sortedTracks.value.filter((t) => selected.value.has(t.id));
  return words.value.length ? sortedTracks.value.filter(hit) : sortedTracks.value;
});

function albumGroup(a: Album): Group {
  return { key: a.key, title: a.title, subtitle: a.artist, cover: a.coverTrack ?? a.tracks[0] ?? null, tracks: a.tracks };
}
const groups = computed<Group[]>(() => {
  if (tab.value === "albums") {
    return library.albums
      .filter((a) => !words.value.length || a.tracks.some(hit) || words.value.every((w) => fold(`${a.title} ${a.artist}`).includes(w)))
      .map(albumGroup);
  }
  return library.artists
    .filter((a) => !words.value.length || words.value.every((w) => fold(a.name).includes(w)) || a.tracks.some(hit))
    .map((a) => ({
      key: a.name,
      title: a.name,
      subtitle: `${a.albums.length ? `${a.albums.length} album${a.albums.length > 1 ? "s" : ""} · ` : ""}${a.tracks.length} morceau${a.tracks.length > 1 ? "x" : ""}`,
      cover: a.tracks.find((t) => t.has_cover) ?? a.tracks[0] ?? null,
      tracks: a.tracks,
    }));
});

/** Morceaux encore ajoutables parmi une liste (ceux déjà dans la playlist sont ignorés). */
const addable = (list: Track[]) => list.filter((t) => !inPlaylist.value.has(t.id));
const visibleAddable = computed(() => addable(tab.value === "tracks" ? tracks.value : groups.value.flatMap((g) => g.tracks)));
const allVisibleSelected = computed(
  () => visibleAddable.value.length > 0 && visibleAddable.value.every((t) => selected.value.has(t.id)),
);

const selection = computed(() => [...selected.value].map((id) => library.byId(id)).filter(Boolean) as Track[]);
const selectionLength = computed(() => {
  const minutes = Math.round(selection.value.reduce((s, t) => s + t.duration_secs, 0) / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
});

function setMany(ids: string[], on: boolean) {
  const next = new Set(selected.value);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  selected.value = next;
  if (!next.size) onlySelected.value = false;
}

function toggleTrack(track: Track, index: number, event: MouseEvent | KeyboardEvent) {
  if (inPlaylist.value.has(track.id)) return;
  const on = !selected.value.has(track.id);
  // Maj + clic : sélectionne toute la plage depuis le dernier morceau cliqué (ordinateur).
  if (event.shiftKey && lastClicked.value !== null) {
    const [from, to] = [Math.min(lastClicked.value, index), Math.max(lastClicked.value, index)];
    setMany(addable(tracks.value.slice(from, to + 1)).map((t) => t.id), on);
  } else {
    setMany([track.id], on);
  }
  lastClicked.value = index;
}

/** État d'un album / artiste : tout coché, en partie, rien — ou déjà entièrement dans la playlist. */
function groupState(g: Group): "all" | "some" | "none" | "done" {
  const rest = addable(g.tracks);
  if (!rest.length) return "done";
  const n = rest.filter((t) => selected.value.has(t.id)).length;
  return n === rest.length ? "all" : n ? "some" : "none";
}
function toggleGroup(g: Group) {
  const state = groupState(g);
  if (state === "done") return;
  setMany(addable(g.tracks).map((t) => t.id), state !== "all");
}
function openGroup(g: Group) {
  // Voir le détail : on bascule sur les morceaux, filtrés par cet album / artiste.
  query.value = tab.value === "albums" ? `${g.title} ${g.subtitle}` : g.title;
  tab.value = "tracks";
}

function toggleAllVisible() {
  setMany(visibleAddable.value.map((t) => t.id), !allVisibleSelected.value);
}

function close() {
  ui.trackPicker = null;
}

async function confirm() {
  const p = playlist.value;
  if (!p || !selected.value.size || busy.value) return;
  busy.value = true;
  // Ordre d'ajout : celui de la liste affichée (titres A→Z ou récents), lisible et prévisible.
  const order = new Map(sortedTracks.value.map((t, i) => [t.id, i]));
  const ids = [...selected.value].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const added = await playlists.addTracks(p.id, ids);
  busy.value = false;
  if (playlists.error) {
    ui.notify(`Ajout impossible : ${playlists.error}`);
    return;
  }
  ui.notify(added === 1 ? `1 morceau ajouté à « ${p.name} »` : `${added} morceaux ajoutés à « ${p.name} »`);
  close();
}

// Réinitialisation à chaque ouverture ; le clavier n'est ouvert d'office que sur ordinateur.
watch(
  () => ui.trackPicker,
  async (id) => {
    if (!id) return;
    query.value = "";
    tab.value = "tracks";
    selected.value = new Set();
    onlySelected.value = false;
    lastClicked.value = null;
    await nextTick();
    if (!ui.isTouch) searchInput.value?.focus();
  },
  { immediate: true },
);
watch([query, tab, onlySelected, sort], () => {
  lastClicked.value = null;
  if (list.value) list.value.scrollTop = 0;
});
watch(query, (q) => {
  if (q) onlySelected.value = false;
});

function onKey(e: KeyboardEvent) {
  if (!ui.trackPicker) return;
  if (e.key === "Escape") {
    if (query.value) query.value = "";
    else close();
    e.preventDefault();
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    void confirm();
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

const TABS: { id: Tab; label: string }[] = [
  { id: "tracks", label: "Morceaux" },
  { id: "albums", label: "Albums" },
  { id: "artists", label: "Artistes" },
];
const resultCount = computed(() => (tab.value === "tracks" ? tracks.value.length : groups.value.length));
const resultLabel = computed(() => {
  const n = resultCount.value;
  const unit = tab.value === "tracks" ? "morceau" : tab.value === "albums" ? "album" : "artiste";
  const plural = tab.value === "tracks" ? "morceaux" : `${unit}s`;
  return `${n} ${n > 1 ? plural : unit}`;
});
</script>

<template>
  <div v-if="playlist" class="scrim picker-scrim" @mousedown.self="close">
    <section class="picker" role="dialog" aria-modal="true" :aria-label="`Ajouter des morceaux à ${playlist.name}`">
      <header class="top">
        <div class="heading">
          <p class="kicker">Ajouter des morceaux</p>
          <h2>{{ playlist.name }}</h2>
        </div>
        <button type="button" class="icon-btn" aria-label="Fermer" title="Fermer (Échap)" @click="close"><Icon name="close" :size="18" /></button>
      </header>

      <label class="search">
        <Icon name="search" :size="16" />
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          enterkeyhint="search"
          placeholder="Titre, artiste, album…"
          aria-label="Rechercher dans la bibliothèque"
        />
        <button v-if="query" type="button" class="clear" aria-label="Effacer la recherche" @click="query = ''; searchInput?.focus()"><Icon name="close" :size="14" /></button>
      </label>

      <div class="bar">
        <div class="tabs" role="tablist">
          <button
            v-for="t in TABS"
            :key="t.id"
            type="button"
            role="tab"
            :aria-selected="tab === t.id && !onlySelected"
            :class="{ on: tab === t.id && !onlySelected }"
            @click="tab = t.id; onlySelected = false"
          >
            {{ t.label }}
          </button>
        </div>
        <button v-if="tab === 'tracks' && !onlySelected" type="button" class="sort" :title="sort === 'az' ? 'Trier par ajout récent' : 'Trier par titre'" @click="sort = sort === 'az' ? 'recent' : 'az'">
          {{ sort === "az" ? "A → Z" : "Récents" }}
        </button>
      </div>

      <div class="meta">
        <span>{{ onlySelected ? "Votre sélection" : resultLabel }}</span>
        <button v-if="visibleAddable.length && !onlySelected" type="button" class="link" @click="toggleAllVisible">
          {{ allVisibleSelected ? "Tout désélectionner" : words.length ? `Tout sélectionner (${visibleAddable.length})` : "Tout sélectionner" }}
        </button>
      </div>

      <div ref="list" class="list">
        <p v-if="!library.tracks.length" class="empty">Votre bibliothèque est vide : choisissez d'abord un dossier de musique dans les Réglages.</p>
        <p v-else-if="!resultCount" class="empty">Aucun résultat pour « {{ query }} ».</p>

        <VirtualList v-else-if="tab === 'tracks' || onlySelected" :items="tracks" :row-height="58">
          <template #default="{ item, index }">
            <div
              class="item"
              role="checkbox"
              tabindex="0"
              :aria-checked="selected.has(item.id) || inPlaylist.has(item.id)"
              :aria-disabled="inPlaylist.has(item.id)"
              :class="{ on: selected.has(item.id), done: inPlaylist.has(item.id) }"
              @click="toggleTrack(item, index, $event)"
              @keydown.space.prevent="toggleTrack(item, index, $event)"
              @keydown.enter.prevent="toggleTrack(item, index, $event)"
            >
              <span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" /></svg></span>
              <div class="thumb"><Artwork :track="item" :radius="5" /></div>
              <div class="text">
                <span class="t">{{ item.title }}</span>
                <span class="s">{{ item.artist }}<template v-if="item.album !== 'Album inconnu'"> · {{ item.album }}</template></span>
              </div>
              <span v-if="inPlaylist.has(item.id)" class="tag">Déjà dans la playlist</span>
              <span v-else class="dur">{{ formatDuration(item.duration_secs) }}</span>
            </div>
          </template>
        </VirtualList>

        <VirtualList v-else :items="groups" :row-height="66">
          <template #default="{ item }">
            <div
              class="item group"
              role="checkbox"
              tabindex="0"
              :aria-checked="groupState(item) === 'all' || groupState(item) === 'done' ? 'true' : groupState(item) === 'some' ? 'mixed' : 'false'"
              :class="[groupState(item), { round: tab === 'artists' }]"
              @click="toggleGroup(item)"
              @keydown.space.prevent="toggleGroup(item)"
              @keydown.enter.prevent="toggleGroup(item)"
            >
              <span class="check" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path :d="groupState(item) === 'some' ? 'M7 12h10' : 'M6 12.5l4 4 8-9'" /></svg>
              </span>
              <div class="thumb big"><Artwork :track="item.cover" :label="item.title" :radius="tab === 'artists' ? 999 : 6" /></div>
              <div class="text">
                <span class="t">{{ item.title }}</span>
                <span class="s">{{ tab === "albums" ? `${item.subtitle} · ${item.tracks.length} morceau${item.tracks.length > 1 ? "x" : ""}` : item.subtitle }}</span>
              </div>
              <span v-if="groupState(item) === 'done'" class="tag">Déjà dans la playlist</span>
              <button type="button" class="open" :aria-label="`Voir les morceaux de ${item.title}`" title="Voir les morceaux" @click.stop="openGroup(item)">
                <span>Voir</span> <span class="chev">›</span>
              </button>
            </div>
          </template>
        </VirtualList>
      </div>

      <footer class="foot" :class="{ active: selected.size }">
        <button v-if="selected.size" type="button" class="count" :class="{ on: onlySelected }" :title="onlySelected ? 'Revenir aux résultats' : 'Voir la sélection'" @click="onlySelected = !onlySelected">
          <strong>{{ selected.size }}</strong> sélectionné{{ selected.size > 1 ? "s" : "" }}
          <span class="muted">· {{ selectionLength }}</span>
        </button>
        <span v-else class="hint muted">{{ ui.isTouch ? "Touchez les morceaux à ajouter." : "Cliquez pour cocher · Maj + clic pour une plage." }}</span>
        <div class="foot-actions">
          <button v-if="selected.size" type="button" class="pill pill-ghost" @click="setMany([...selected], false)">Effacer</button>
          <button type="button" class="pill pill-accent" :disabled="!selected.size || busy" @click="confirm">
            <Icon name="plus" :size="15" /> {{ selected.size ? `Ajouter (${selected.size})` : "Ajouter" }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 75;
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
.picker {
  display: flex;
  flex-direction: column;
  width: min(780px, calc(100vw - 40px));
  height: min(760px, calc(100vh - 60px));
  border-radius: 16px;
  background: rgba(9, 24, 60, 0.98);
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
  font-size: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 20px;
  padding: 0 12px;
  height: 42px;
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
.clear {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 12px 20px 0;
}
.tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
}
.tabs button,
.sort {
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 7px;
  background: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.tabs button.on {
  background: var(--accent);
  color: #fff;
}
.sort {
  background: rgba(255, 255, 255, 0.06);
}
.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 10px 20px 4px;
  font-size: 12px;
  color: var(--text-3);
}
.link {
  padding: 4px 0;
  border: 0;
  background: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}
.list {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 10px;
}
.empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-2);
}
.item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 100%;
  padding: 0 10px;
  border-radius: 9px;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.item.on,
.item.all {
  background: var(--accent-soft);
}
.item.done {
  cursor: default;
  opacity: 0.55;
}
.check {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.6px rgba(255, 255, 255, 0.35);
  transition: background 0.15s, box-shadow 0.15s;
}
.check svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: #fff;
  stroke-width: 2.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  transform: scale(0.6);
  transition: opacity 0.15s, transform 0.15s var(--ease);
}
.item.on .check,
.item.all .check,
.item.some .check {
  background: var(--accent);
  box-shadow: none;
}
.item.done .check {
  background: rgba(255, 255, 255, 0.25);
  box-shadow: none;
}
.item.on .check svg,
.item.all .check svg,
.item.some .check svg,
.item.done .check svg {
  opacity: 1;
  transform: none;
}
.thumb {
  flex: none;
  width: 40px;
  height: 40px;
}
.thumb.big {
  width: 48px;
  height: 48px;
}
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.t,
.s {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.t {
  font-size: 14px;
  font-weight: 500;
}
.s {
  font-size: 12px;
  color: var(--text-2);
}
.dur {
  flex: none;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.tag {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
}
.open {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.07);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.open:hover {
  background: rgba(255, 255, 255, 0.14);
  color: var(--text);
}
.chev {
  font-size: 15px;
  line-height: 1;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--separator);
  background: rgba(6, 16, 42, 0.6);
}
.count {
  min-width: 0;
  padding: 6px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  font-size: 13px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.count:hover,
.count.on {
  background: rgba(255, 255, 255, 0.08);
}
.hint {
  font-size: 12px;
  min-width: 0;
}
.foot-actions {
  display: flex;
  gap: 8px;
  flex: none;
}
.pill:disabled {
  opacity: 0.45;
}

/* Téléphone (et pliable fermé) : plein écran, zones de toucher larges, barres système respectées. */
@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .scrim {
    place-items: stretch;
    backdrop-filter: none;
  }
  .picker {
    width: 100%;
    height: 100%;
    border-radius: 0;
    background: rgb(9, 24, 60);
    padding-left: var(--safe-left);
    padding-right: var(--safe-right);
    animation: slide 0.26s var(--ease);
  }
  @keyframes slide {
    from {
      transform: translateY(24px);
      opacity: 0;
    }
  }
  .top {
    padding: calc(var(--safe-top) + 12px) 14px 8px;
  }
  .search,
  .bar,
  .meta {
    margin-left: 14px;
    margin-right: 14px;
  }
  .tabs {
    flex: 1;
  }
  .tabs button {
    flex: 1;
    padding: 0 8px;
  }
  .list {
    padding: 0 4px;
  }
  .item:hover {
    background: none;
  }
  .item.on,
  .item.all {
    background: var(--accent-soft);
  }
  .tag {
    display: none;
  }
  .open span:first-child {
    display: none;
  }
  .open {
    width: 36px;
    justify-content: center;
    padding: 0;
  }
  .foot {
    padding: 10px 14px calc(var(--safe-bottom) + 10px);
  }
  .hint {
    font-size: 12px;
  }
}
@media (max-width: 380px) {
  .sort {
    padding: 0 10px;
  }
  .foot-actions .pill-ghost {
    display: none;
  }
}
:root[data-perf="lite"] .picker,
:root[data-perf="lite"] .foot {
  background: rgb(9, 24, 60);
}
</style>
