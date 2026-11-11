<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { normalize } from "@/lib/duplicates";
import type { Artist, Track } from "@/lib/types";
import { useFriendsStore } from "@/stores/friends";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import AlbumCard from "@/components/AlbumCard.vue";
import ArtistAvatar from "@/components/ArtistAvatar.vue";
import Artwork from "@/components/Artwork.vue";
import FriendAvatar from "@/components/FriendAvatar.vue";
import Icon from "@/components/Icon.vue";
import TrackRow from "@/components/TrackRow.vue";

// Résultats d'une recherche : le meilleur résultat mis en avant (artiste ou morceau, à lire
// d'un geste), puis artistes, albums, morceaux et proches ; un filtre pour n'en garder qu'un.
const props = defineProps<{ query: string }>();
const library = useLibraryStore();
const player = usePlayerStore();
const ui = useUiStore();
const friends = useFriendsStore();

type Tab = "tout" | "morceaux" | "albums" | "artistes" | "proches";
const tab = ref<Tab>("tout");
watch(
  () => props.query,
  () => (tab.value = "tout"),
);

const results = computed(() => library.search(props.query));
const q = computed(() => normalize(props.query));
const artists = computed<Artist[]>(() => {
  const wanted = new Set(results.value.artists);
  const list = library.artists.filter((a) => wanted.has(a.name));
  // Le nom exact d'abord, puis ceux qui commencent par la recherche, puis le plus de morceaux.
  const rank = (a: Artist) => (normalize(a.name) === q.value ? 0 : normalize(a.name).startsWith(q.value) ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || b.tracks.length - a.tracks.length);
});
const people = computed(() => (q.value ? friends.friends.filter((f) => normalize(f.name).includes(q.value) || normalize(f.code).includes(q.value)) : []));
const tracks = computed(() => results.value.tracks);
const albums = computed(() => results.value.albums);
const empty = computed(() => !people.value.length && !tracks.value.length && !albums.value.length && !artists.value.length);

/** Meilleur résultat : un artiste dont le nom correspond bien, sinon le premier morceau. */
const best = computed<{ kind: "artiste"; artist: Artist } | { kind: "morceau"; track: Track } | null>(() => {
  const a = artists.value[0];
  if (a && normalize(a.name).startsWith(q.value)) return { kind: "artiste", artist: a };
  const t = tracks.value.find((x) => normalize(x.title).startsWith(q.value)) ?? tracks.value[0];
  if (t) return { kind: "morceau", track: t };
  return a ? { kind: "artiste", artist: a } : null;
});

const TABS = computed(() =>
  (
    [
      { id: "tout", label: "Tout", n: -1 },
      { id: "morceaux", label: "Morceaux", n: tracks.value.length },
      { id: "albums", label: "Albums", n: albums.value.length },
      { id: "artistes", label: "Artistes", n: artists.value.length },
      { id: "proches", label: "Proches", n: people.value.length },
    ] as { id: Tab; label: string; n: number }[]
  ).filter((t) => t.n !== 0),
);
const show = (t: Tab) => tab.value === "tout" || tab.value === t;
const limit = (t: Tab, n: number) => (tab.value === t ? Infinity : n);

function playTracks(from: Track) {
  const ids = tracks.value.map((t) => t.id);
  void player.playQueue(ids, from.id);
}
function playBest() {
  const b = best.value;
  if (!b) return;
  if (b.kind === "morceau") playTracks(b.track);
  else {
    const ids = b.artist.tracks.map((t) => t.id);
    void player.playQueue(ids, ids[0]);
  }
}
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
</script>

<template>
  <div class="page">
    <h1 class="page-title">Résultats pour « {{ query }} »</h1>

    <div v-if="!empty" class="tabs" role="tablist" aria-label="Filtrer les résultats">
      <button v-for="t in TABS" :key="t.id" type="button" role="tab" :aria-selected="tab === t.id" :class="{ on: tab === t.id }" @click="tab = t.id">
        {{ t.label }}<span v-if="t.n > 0" class="n">{{ t.n }}</span>
      </button>
    </div>

    <div v-if="empty" class="empty">
      <Icon name="search" :size="34" />
      <p><strong>Rien trouvé pour « {{ query }} »</strong></p>
      <p class="muted">Vérifiez l'orthographe, ou cherchez un titre, un artiste ou un album plus court.</p>
    </div>

    <!-- Meilleur résultat et premiers morceaux -->
    <div v-if="tab === 'tout' && best" class="top">
      <section class="best-wrap">
        <h2>Meilleur résultat</h2>
        <div class="best" role="button" tabindex="0" @click="best.kind === 'artiste' ? ui.go({ name: 'artists', artist: best.artist.name }) : playTracks(best.track)" @keydown.enter="playBest">
          <div class="best-art" :class="{ round: best.kind === 'artiste' }">
            <ArtistAvatar v-if="best.kind === 'artiste'" :artist="best.artist" eager />
            <Artwork v-else :track="best.track" :radius="10" eager />
          </div>
          <strong class="best-title">{{ best.kind === "artiste" ? best.artist.name : best.track.title }}</strong>
          <span class="best-sub">
            <span class="badge">{{ best.kind === "artiste" ? "Artiste" : "Morceau" }}</span>
            {{ best.kind === "artiste" ? plural(best.artist.tracks.length, "morceau", "morceaux") : best.track.artist }}
          </span>
          <button type="button" class="best-play" :aria-label="best.kind === 'artiste' ? `Lire ${best.artist.name}` : `Lire ${best.track.title}`" @click.stop="playBest">
            <Icon name="play" :size="20" />
          </button>
        </div>
      </section>
      <section v-if="tracks.length" class="quick">
        <div class="head">
          <h2>Morceaux</h2>
          <button v-if="tracks.length > 4" type="button" class="see-all" @click="tab = 'morceaux'">Tout voir</button>
        </div>
        <div v-for="(track, i) in tracks.slice(0, 4)" :key="track.id" class="row">
          <TrackRow :track="track" :index="i" striped @play="playTracks(track)" />
        </div>
      </section>
    </div>

    <section v-if="show('artistes') && artists.length" class="block">
      <div class="head">
        <h2>Artistes</h2>
        <button v-if="tab === 'tout' && artists.length > 6" type="button" class="see-all" @click="tab = 'artistes'">Tout voir</button>
      </div>
      <div class="artist-grid" :class="{ strip: tab === 'tout' }">
        <button v-for="a in artists.slice(0, limit('artistes', 6))" :key="a.name" type="button" class="artist-card" @click="ui.go({ name: 'artists', artist: a.name })">
          <ArtistAvatar :artist="a" />
          <span class="artist-name">{{ a.name }}</span>
          <small class="muted">{{ plural(a.tracks.length, "morceau", "morceaux") }}</small>
        </button>
      </div>
    </section>

    <section v-if="show('albums') && albums.length" class="block">
      <div class="head">
        <h2>Albums</h2>
        <button v-if="tab === 'tout' && albums.length > 6" type="button" class="see-all" @click="tab = 'albums'">Tout voir</button>
      </div>
      <div class="album-grid">
        <AlbumCard v-for="album in albums.slice(0, limit('albums', 6))" :key="album.key" :album="album" />
      </div>
    </section>

    <section v-if="show('morceaux') && tracks.length && tab !== 'tout'" class="block">
      <h2>Morceaux</h2>
      <div v-for="(track, i) in tracks" :key="track.id" class="row">
        <TrackRow :track="track" :index="i" striped @play="playTracks(track)" />
      </div>
      <p v-if="tracks.length >= 200" class="muted">Les 200 premiers : précisez la recherche pour en voir d'autres.</p>
    </section>
    <section v-if="tab === 'tout' && tracks.length > 4" class="block">
      <div class="head">
        <h2>Autres morceaux</h2>
        <button type="button" class="see-all" @click="tab = 'morceaux'">Tout voir ({{ tracks.length }})</button>
      </div>
      <div v-for="(track, i) in tracks.slice(4, 12)" :key="track.id" class="row">
        <TrackRow :track="track" :index="i + 4" striped @play="playTracks(track)" />
      </div>
    </section>

    <section v-if="show('proches') && people.length" class="block">
      <h2>Proches</h2>
      <button v-for="f in people" :key="f.code" type="button" class="person" @click="friends.openChat(f.code)">
        <FriendAvatar :name="f.name" :src="f.avatar" :size="40" />
        <span class="person-text">
          <strong>{{ f.name }}</strong>
          <small>{{ f.code }}</small>
        </span>
        <span class="person-go"><Icon name="lyrics" :size="16" /> Écrire</span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: -4px 0 22px;
}
.tabs button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.07);
  color: var(--text-2);
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.tabs button.on {
  background: var(--accent);
  color: var(--on-accent, #fff);
}
.n {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
.empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 56px 16px;
  text-align: center;
  color: var(--text-2);
}
.empty p {
  margin: 0;
}
.empty strong {
  color: var(--text);
}
h2 {
  margin: 0 0 12px;
  font-family: var(--font-display);
  font-size: 19px;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.see-all {
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.block {
  margin-top: 30px;
}

.top {
  display: grid;
  grid-template-columns: minmax(260px, 380px) minmax(0, 1fr);
  gap: 28px;
}
.best {
  position: relative;
  display: grid;
  gap: 6px;
  padding: 20px;
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(var(--fg-rgb), 0.09), rgba(var(--fg-rgb), 0.03));
  border: 1px solid rgba(var(--fg-rgb), 0.06);
  cursor: pointer;
  transition: background 0.2s;
}
.best:hover {
  background: linear-gradient(135deg, rgba(var(--fg-rgb), 0.13), rgba(var(--fg-rgb), 0.05));
}
.best-art {
  width: 108px;
  margin-bottom: 10px;
}
.best-title {
  font-family: var(--font-display);
  font-size: 28px;
  line-height: 1.1;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}
.best-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  color: var(--text-2);
}
.badge {
  padding: 2px 9px;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.1);
  color: var(--text);
  font-size: 11.5px;
  font-weight: 700;
}
.best-play {
  position: absolute;
  right: 18px;
  bottom: 18px;
  display: grid;
  place-items: center;
  width: 50px;
  height: 50px;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent, #fff);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 0.2s, transform 0.2s var(--ease);
}
.best:hover .best-play,
.best:focus-visible .best-play {
  opacity: 1;
  transform: none;
}
@media (hover: none) {
  .best-play {
    opacity: 1;
    transform: none;
  }
}
.row {
  height: 52px;
}

.artist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 22px;
}
.artist-grid.strip {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}
.artist-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  justify-items: center;
  align-content: start;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  text-align: center;
  cursor: pointer;
}
.artist-card :deep(.artist-avatar) {
  transition: transform 0.25s var(--ease);
}
@media (hover: hover) {
  .artist-card:hover :deep(.artist-avatar) {
    transform: translateY(-3px) scale(1.02);
  }
}
.artist-name {
  display: -webkit-box;
  width: 100%;
  margin-top: 4px;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 13.5px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.artist-card small {
  font-size: 12px;
}
.album-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 22px;
}

.person {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.person:hover {
  background: rgba(var(--fg-rgb), 0.06);
}
.person-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.person-text small {
  color: var(--text-2);
  font-size: 12px;
}
.person-go {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
}

@media (max-width: 1100px) {
  .artist-grid.strip {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .top {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }
  .best-title {
    font-size: 24px;
  }
  .artist-grid,
  .artist-grid.strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
  }
  .album-grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 14px;
  }
}
</style>
