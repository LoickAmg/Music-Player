<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { formatCollection } from "@/lib/format";
import { remembered } from "@/lib/remember";
import { SCROLLER, useViewport } from "@/lib/virtual";
import type { Artist } from "@/lib/types";
import { useLibraryStore } from "@/stores/library";
import { useListeningStore } from "@/stores/listening";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import AlbumCard from "@/components/AlbumCard.vue";
import ArtistAvatar from "@/components/ArtistAvatar.vue";
import Artwork from "@/components/Artwork.vue";
import FastScroll from "@/components/FastScroll.vue";
import Icon from "@/components/Icon.vue";
import TrackRow from "@/components/TrackRow.vue";

// Artistes : la grille de portraits, rangée par lettre (index A-Z), puis la page de l'artiste
// touché. Faute de photo, un portrait est fait de ses pochettes.
const props = defineProps<{ artist?: string }>();
const library = useLibraryStore();
const listening = useListeningStore();
const player = usePlayerStore();
const ui = useUiStore();
const scroller = inject(SCROLLER, ref(null));

const artists = computed(() => library.artists);
const selected = computed<Artist | null>(() => (props.artist ? (artists.value.find((a) => a.name === props.artist) ?? null) : null));
const open = (a: Artist) => ui.go({ name: "artists", artist: a.name });

// ---------------------------------------------------------------- Grille (virtuelle)
const letterOf = (name: string) => {
  const c = name.trim().normalize("NFD").replace(/[̀-ͯ]/g, "").charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
};
const groups = computed(() => {
  const map = new Map<string, Artist[]>();
  for (const a of artists.value) {
    const l = letterOf(a.name);
    if (!map.has(l)) map.set(l, []);
    map.get(l)!.push(a);
  }
  return [...map.entries()].sort(([x], [y]) => (x === "#" ? -1 : y === "#" ? 1 : x.localeCompare(y)));
});

const host = ref<HTMLElement | null>(null);
const { top, height, width } = useViewport(host);
const gap = computed(() => (ui.isMobile ? 12 : 22));
const minWidth = computed(() => (ui.isMobile ? 100 : 150));
const columns = computed(() => Math.max(2, Math.floor((width.value + gap.value) / (minWidth.value + gap.value))));
const itemWidth = computed(() => (width.value - gap.value * (columns.value - 1)) / columns.value);
const HEADER = 52;
const NAME = 46;
const rowHeight = computed(() => itemWidth.value + NAME + gap.value);

interface Block {
  key: string;
  y: number;
  letter?: string;
  items?: Artist[];
}
const layout = computed(() => {
  const blocks: Block[] = [];
  const letterY: Record<string, number> = {};
  let y = 0;
  for (const [letter, list] of groups.value) {
    letterY[letter] = y;
    blocks.push({ key: `h-${letter}`, y, letter });
    y += HEADER;
    for (let i = 0; i < list.length; i += columns.value) {
      blocks.push({ key: `r-${letter}-${i}`, y, items: list.slice(i, i + columns.value) });
      y += rowHeight.value;
    }
  }
  return { blocks, total: y, letterY };
});
const visible = computed(() => {
  const from = top.value - rowHeight.value * 2;
  const to = top.value + height.value + rowHeight.value * 2;
  return layout.value.blocks.filter((b) => b.y + rowHeight.value >= from && b.y <= to);
});
function jump(letter: string) {
  const sc = scroller.value;
  const el = host.value;
  if (!sc || !el) return;
  const offset = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  sc.scrollTo({ top: offset + (layout.value.letterY[letter] ?? 0) - 8, behavior: "smooth" });
}
/** Repère de la barre de défilement rapide (téléphone). */
const flatIndex = computed(() => artists.value.map((a) => letterOf(a.name)));

function shuffleAll() {
  player.playShuffled(library.tracks.map((t) => t.id));
}

// ---------------------------------------------------------------- Page de l'artiste
const ids = computed(() => selected.value?.tracks.map((t) => t.id) ?? []);
const duration = computed(() => selected.value?.tracks.reduce((s, t) => s + t.duration_secs, 0) ?? 0);
const genre = computed(() => {
  const counts = new Map<string, number>();
  for (const t of selected.value?.tracks ?? []) if (t.genre) counts.set(t.genre, (counts.get(t.genre) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
});
const years = computed(() => {
  const ys = (selected.value?.albums ?? []).map((a) => a.year).filter((y): y is number => !!y);
  if (!ys.length) return null;
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  return lo === hi ? `${lo}` : `${lo} – ${hi}`;
});
const albumsView = remembered<"grille" | "liste">("mp:artiste-albums", "grille", ["grille", "liste"]);

/** Les plus écoutés (journal d'écoute), sinon l'ordre de la bibliothèque. */
const top5 = computed(() => {
  if (!selected.value) return [];
  const mine = new Set(ids.value);
  const plays = new Map<string, number>();
  for (const l of listening.music) if (mine.has(l.track_id)) plays.set(l.track_id, (plays.get(l.track_id) ?? 0) + 1);
  return [...plays.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, n]) => ({ track: library.byId(id)!, plays: n }))
    .filter((x) => !!x.track);
});
const shown = ref(40);
watch(
  () => props.artist,
  () => {
    shown.value = 40;
    if (!listening.loaded) void listening.load();
  },
  { immediate: true },
);

/** Apparaît aussi avec : les noms d'artistes qui contiennent celui-ci (« feat. », « x », « & »). */
const together = computed(() => {
  const a = selected.value;
  if (!a || a.name.length < 3) return [];
  const needle = a.name.toLowerCase();
  return artists.value.filter((o) => o.name !== a.name && o.name.toLowerCase().includes(needle)).slice(0, 12);
});

const backLabel = "Artistes";
</script>

<template>
  <!-- Page d'un artiste -->
  <div v-if="artist" class="page artist-page">
    <button type="button" class="back-link" @click="ui.back()"><Icon name="back" :size="16" /> {{ backLabel }}</button>
    <template v-if="selected">
      <header class="hero">
        <div class="hero-art"><ArtistAvatar :artist="selected" eager /></div>
        <div class="hero-text">
          <span class="kicker">Artiste</span>
          <h1>{{ selected.name }}</h1>
          <p class="facts">
            <span v-if="selected.albums.length">{{ selected.albums.length }} album{{ selected.albums.length > 1 ? "s" : "" }}</span>
            <span>{{ formatCollection(selected.tracks.length, duration) }}</span>
            <span v-if="years">{{ years }}</span>
            <span v-if="genre">{{ genre }}</span>
          </p>
          <div class="actions">
            <button type="button" class="pill pill-accent" @click="player.playQueue(ids, ids[0])"><Icon name="play" :size="14" /> Tout lire</button>
            <button type="button" class="pill pill-ghost" @click="player.playShuffled(ids)"><Icon name="shuffle" :size="15" /> Aléatoire</button>
            <button type="button" class="pill pill-ghost" @click="player.enqueue(ids).then(() => ui.notify(`${selected!.tracks.length} morceaux ajoutés à la file d'attente`))">
              <Icon name="queue" :size="15" /> Ajouter à la file
            </button>
          </div>
        </div>
      </header>

      <section v-if="top5.length" class="block">
        <h2>Les plus écoutés</h2>
        <ol class="top">
          <li v-for="(x, i) in top5" :key="x.track.id">
            <button type="button" class="top-row" @click="player.playQueue(top5.map((y) => y.track.id), x.track.id)">
              <span class="rank">{{ i + 1 }}</span>
              <span class="top-cover"><Artwork :track="x.track" :radius="6" /></span>
              <span class="top-text"><strong>{{ x.track.title }}</strong><small>{{ x.track.album }}</small></span>
              <span class="plays">{{ x.plays }} écoute{{ x.plays > 1 ? "s" : "" }}</span>
            </button>
          </li>
        </ol>
      </section>

      <section v-if="selected.albums.length" class="block">
        <div class="block-head">
          <h2>Dans votre bibliothèque</h2>
          <div class="view-toggle" role="radiogroup" aria-label="Affichage des albums">
            <button type="button" role="radio" :aria-checked="albumsView === 'liste'" :class="{ on: albumsView === 'liste' }" aria-label="En liste" @click="albumsView = 'liste'"><Icon name="queue" :size="16" /></button>
            <button type="button" role="radio" :aria-checked="albumsView === 'grille'" :class="{ on: albumsView === 'grille' }" aria-label="En grille" @click="albumsView = 'grille'"><Icon name="album" :size="16" /></button>
          </div>
        </div>
        <div v-if="albumsView === 'grille'" class="album-grid">
          <AlbumCard v-for="album in selected.albums" :key="album.key" :album="album" />
        </div>
        <ul v-else class="album-list">
          <li v-for="album in selected.albums" :key="album.key">
            <button type="button" class="album-row" @click="ui.go({ name: 'album', key: album.key })">
              <span class="al-cover"><Artwork :track="album.coverTrack" :label="album.title" :radius="6" /></span>
              <span class="al-text"><strong>{{ album.title }}</strong><small>{{ album.year ?? "Année inconnue" }} · {{ album.tracks.length }} morceau{{ album.tracks.length > 1 ? "x" : "" }}</small></span>
              <Icon name="play" :size="16" class="al-play" />
            </button>
          </li>
        </ul>
      </section>

      <section class="block">
        <h2>Morceaux</h2>
        <div v-for="(track, i) in selected.tracks.slice(0, shown)" :key="track.id" class="row">
          <TrackRow :track="track" :index="i" striped @play="player.playQueue(ids, track.id)" />
        </div>
        <button v-if="selected.tracks.length > shown" type="button" class="pill pill-ghost more" @click="shown += 100">Afficher plus ({{ selected.tracks.length - shown }})</button>
      </section>

      <section v-if="together.length" class="block">
        <h2>Apparaît aussi avec</h2>
        <div class="together">
          <button v-for="o in together" :key="o.name" type="button" class="artist-card small" @click="open(o)">
            <ArtistAvatar :artist="o" />
            <span class="artist-name">{{ o.name }}</span>
          </button>
        </div>
      </section>
    </template>
    <p v-else class="muted">Cet artiste n'est plus dans la bibliothèque.</p>
  </div>

  <!-- Grille des artistes -->
  <div v-else class="page artists-index">
    <div class="index-head">
      <h1 class="page-title">Artistes</h1>
      <span class="muted count">{{ artists.length }}</span>
      <button v-if="library.tracks.length" type="button" class="pill pill-accent shuffle" @click="shuffleAll"><Icon name="shuffle" :size="15" /> Lecture aléatoire</button>
    </div>
    <nav v-if="!ui.isTouch && groups.length > 3" class="letters" aria-label="Aller à la lettre">
      <button v-for="[l] in groups" :key="l" type="button" @click="jump(l)">{{ l }}</button>
    </nav>
    <p v-if="!artists.length" class="muted">Aucun artiste pour l'instant.</p>

    <div ref="host" class="grid-host" :style="{ height: `${layout.total}px` }">
      <template v-for="b in visible" :key="b.key">
        <h2 v-if="b.letter" class="letter" :style="{ transform: `translateY(${b.y}px)` }">{{ b.letter }}</h2>
        <div v-else class="grid-row" :style="{ transform: `translateY(${b.y}px)`, gap: `${gap}px`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }">
          <button v-for="a in b.items" :key="a.name" type="button" class="artist-card" @click="open(a)">
            <ArtistAvatar :artist="a" />
            <span class="artist-name">{{ a.name }}</span>
          </button>
        </div>
      </template>
    </div>
    <FastScroll :count="artists.length" :label="(i) => flatIndex[i] ?? ''" />
  </div>
</template>

<style scoped>
/* ------------------------------------------------ Grille */
.index-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.index-head .page-title {
  margin-bottom: 0;
}
.count {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}
.shuffle {
  margin-left: auto;
  align-self: center;
}
.letters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 16px 0 4px;
}
.letters button {
  min-width: 30px;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.06);
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
}
.letters button:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.grid-host {
  position: relative;
  margin-top: 8px;
}
.letter,
.grid-row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}
.letter {
  margin: 0;
  height: 52px;
  display: flex;
  align-items: center;
  font-family: var(--font-display);
  font-size: 22px;
  color: var(--accent);
}
.grid-row {
  display: grid;
}
.artist-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  justify-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  text-align: center;
  cursor: pointer;
}
.artist-card :deep(.artist-avatar) {
  transition: transform 0.25s var(--ease), box-shadow 0.25s var(--ease);
}
@media (hover: hover) {
  .artist-card:hover :deep(.artist-avatar) {
    transform: translateY(-3px) scale(1.02);
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.45);
  }
}
.artist-name {
  display: -webkit-box;
  width: 100%;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

/* ------------------------------------------------ Page de l'artiste */
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 14px;
  padding: 6px 10px 6px 6px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font: inherit;
  font-size: 13.5px;
  cursor: pointer;
}
.back-link:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.hero {
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 24px;
  border-radius: 22px;
  background: linear-gradient(135deg, rgba(var(--fg-rgb), 0.07), rgba(var(--fg-rgb), 0.02));
  border: 1px solid rgba(var(--fg-rgb), 0.06);
}
.hero-art {
  flex: none;
  width: 200px;
}
.hero-text {
  min-width: 0;
}
.kicker {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
}
.hero h1 {
  margin: 4px 0 8px;
  font-family: var(--font-display);
  font-size: clamp(28px, 4.4vw, 52px);
  line-height: 1.05;
  overflow-wrap: anywhere;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 0;
  margin: 0 0 18px;
  color: var(--text-2);
  font-size: 14.5px;
}
.facts span + span::before {
  content: "•";
  margin: 0 8px;
  opacity: 0.6;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.block {
  margin-top: 32px;
}
.block h2 {
  margin: 0 0 14px;
  font-family: var(--font-display);
  font-size: 20px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.block-head h2 {
  margin: 0;
}
.view-toggle {
  display: flex;
  gap: 4px;
}
.view-toggle button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text-2);
  cursor: pointer;
}
.view-toggle button.on {
  color: var(--accent);
  background: var(--bg-hover);
}
.album-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 22px;
}
.album-list,
.top {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.album-row,
.top-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 10px;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.album-row:hover,
.top-row:hover {
  background: var(--bg-hover);
}
.al-cover,
.top-cover {
  flex: none;
  width: 52px;
}
.top-cover {
  width: 44px;
}
.al-text,
.top-text {
  display: grid;
  flex: 1;
  min-width: 0;
}
.al-text strong,
.al-text small,
.top-text strong,
.top-text small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.al-text small,
.top-text small {
  font-size: 12.5px;
  color: var(--text-2);
}
.al-play {
  color: var(--text-2);
}
.rank {
  width: 22px;
  text-align: center;
  font-family: var(--font-display);
  font-size: 18px;
  color: var(--accent);
}
.plays {
  flex: none;
  font-size: 12.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.row {
  height: 52px;
}
.more {
  margin-top: 12px;
}
.together {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 18px;
}
.artist-card.small .artist-name {
  font-size: 12.5px;
}

@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .hero {
    flex-direction: column;
    text-align: center;
    gap: 16px;
    padding: 20px 16px;
  }
  .hero-art {
    width: min(200px, 56vw);
  }
  .facts,
  .actions {
    justify-content: center;
  }
  .album-grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 14px;
  }
  .together {
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  }
  .artist-name {
    font-size: 12.5px;
  }
}
</style>
