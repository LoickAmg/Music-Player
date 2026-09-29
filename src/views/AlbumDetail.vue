<script setup lang="ts">
import { computed } from "vue";
import { formatCollection } from "@/lib/format";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Artwork from "@/components/Artwork.vue";
import Icon from "@/components/Icon.vue";
import TrackRow from "@/components/TrackRow.vue";

const props = defineProps<{ albumKey: string }>();
const library = useLibraryStore();
const player = usePlayerStore();
const ui = useUiStore();

const album = computed(() => library.albumByKey(props.albumKey));
const ids = computed(() => album.value?.tracks.map((t) => t.id) ?? []);
const genre = computed(() => album.value?.tracks.find((t) => t.genre)?.genre ?? null);
const others = computed(() =>
  album.value ? library.albums.filter((a) => a.artist === album.value!.artist && a.key !== album.value!.key).slice(0, 12) : [],
);
</script>

<template>
  <div v-if="album" class="page">
    <header class="hero">
      <Artwork :track="album.coverTrack" :label="album.title" :radius="3" eager class="art" />
      <div class="info">
        <p class="kicker">Album</p>
        <h1>{{ album.title }}</h1>
        <button type="button" class="artist" @click="ui.go({ name: 'artists', artist: album.artist })">{{ album.artist }}</button>
        <p class="meta">
          <span v-if="genre">{{ genre }}</span><span v-if="genre && album.year"> · </span><span v-if="album.year">{{ album.year }}</span>
        </p>
        <div class="actions">
          <button type="button" class="pill pill-accent" @click="player.playQueue(ids, ids[0])">
            <Icon name="play" :size="14" /> Lire
          </button>
          <button type="button" class="pill pill-ghost" @click="player.playShuffled(ids)">
            <Icon name="shuffle" :size="15" /> Aléatoire
          </button>
        </div>
      </div>
    </header>

    <div class="tracks">
      <div v-for="(track, i) in album.tracks" :key="track.id" class="row">
        <TrackRow :track="track" :index="i" variant="album" striped @play="player.playQueue(ids, track.id)" />
      </div>
    </div>
    <p class="summary">{{ formatCollection(album.tracks.length, album.durationSecs) }}</p>

    <section v-if="others.length" class="others">
      <h2>Plus de {{ album.artist }}</h2>
      <div class="mini-grid">
        <button v-for="a in others" :key="a.key" type="button" class="mini" @click="ui.go({ name: 'album', key: a.key })">
          <Artwork :track="a.coverTrack" :label="a.title" :radius="6" />
          <span>{{ a.title }}</span>
        </button>
      </div>
    </section>
  </div>
  <div v-else class="page"><p class="muted">Cet album n'est plus dans la bibliothèque.</p></div>
</template>

<style scoped>
.hero {
  display: flex;
  align-items: flex-end;
  gap: 28px;
  margin-bottom: 28px;
}
.art {
  width: 230px;
  flex: none;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45) !important;
}
.info {
  min-width: 0;
  padding-bottom: 4px;
}
.kicker {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
h1 {
  margin: 4px 0 2px;
  font-family: var(--font-display);
  font-size: 46px;
  font-style: italic;
  font-weight: 800;
  line-height: 0.98;
  text-transform: uppercase;
  text-shadow: 3px 3px 0 var(--blue);
  line-height: 1.12;
}
.artist {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 20px;
  font-weight: 500;
}
.artist:hover {
  text-decoration: underline;
}
.meta {
  margin: 6px 0 18px;
  color: var(--text-2);
  font-size: 12.5px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.actions {
  display: flex;
  gap: 10px;
}
.tracks {
  border-top: 1px solid var(--separator);
  padding-top: 6px;
}
.row {
  height: 44px;
}
.summary {
  margin: 14px 10px 0;
  color: var(--text-2);
  font-size: 12.5px;
}
.others {
  margin-top: 40px;
}
.others h2 {
  margin: 0 0 12px;
  font-size: 18px;
  font-family: var(--font-display);
}
.mini-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 18px;
}
.mini {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  font-size: 12.5px;
  min-width: 0;
}
.mini span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
