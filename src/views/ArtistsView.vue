<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { formatCollection, hueFor } from "@/lib/format";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import AlbumCard from "@/components/AlbumCard.vue";
import Icon from "@/components/Icon.vue";
import TrackRow from "@/components/TrackRow.vue";

const props = defineProps<{ artist?: string }>();
const library = useLibraryStore();
const player = usePlayerStore();

const selectedName = ref<string | null>(props.artist ?? null);
watch(
  () => props.artist,
  (name) => {
    if (name) selectedName.value = name;
  },
);

const artists = computed(() => library.artists);
const selected = computed(
  () => artists.value.find((a) => a.name === selectedName.value) ?? artists.value[0] ?? null,
);
const ids = computed(() => selected.value?.tracks.map((t) => t.id) ?? []);
const duration = computed(() => selected.value?.tracks.reduce((s, t) => s + t.duration_secs, 0) ?? 0);
const singles = computed(() => selected.value?.tracks.slice(0, 60) ?? []);

const list = ref<HTMLElement | null>(null);
async function revealSelected() {
  await nextTick();
  list.value?.querySelector(".artist-item.active")?.scrollIntoView({ block: "center" });
}
onMounted(revealSelected);
watch(() => props.artist, revealSelected);

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
</script>

<template>
  <div class="artists">
    <nav ref="list" class="artist-list" aria-label="Artistes">
      <button
        v-for="a in artists"
        :key="a.name"
        type="button"
        class="artist-item"
        :class="{ active: selected?.name === a.name }"
        @click="selectedName = a.name"
      >
        <span class="avatar" :style="{ background: `hsl(${hueFor(a.name)} 35% 32%)` }">{{ initials(a.name) }}</span>
        <span class="name">{{ a.name }}</span>
      </button>
    </nav>

    <div v-if="selected" class="detail">
      <header>
        <h1>{{ selected.name }}</h1>
        <p class="muted">{{ formatCollection(selected.tracks.length, duration) }}</p>
        <div class="actions">
          <button type="button" class="pill pill-accent" @click="player.playQueue(ids, ids[0])"><Icon name="play" :size="14" /> Lire</button>
          <button type="button" class="pill pill-ghost" @click="player.playShuffled(ids)"><Icon name="shuffle" :size="15" /> Aléatoire</button>
        </div>
      </header>

      <section v-if="selected.albums.length">
        <h2>Albums</h2>
        <div class="grid">
          <AlbumCard v-for="album in selected.albums" :key="album.key" :album="album" />
        </div>
      </section>

      <section>
        <h2>Morceaux</h2>
        <div v-for="(track, i) in singles" :key="track.id" class="row">
          <TrackRow :track="track" :index="i" striped @play="player.playQueue(ids, track.id)" />
        </div>
        <p v-if="selected.tracks.length > singles.length" class="muted more">
          Et {{ selected.tracks.length - singles.length }} autres — « Lire » les enchaîne tous.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.artists {
  display: grid;
  grid-template-columns: 250px 1fr;
  height: 100%;
  min-height: 0;
}
.artist-list {
  overflow-y: auto;
  padding: 16px 8px;
  border-right: 1px solid var(--separator);
}
.artist-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 3px;
  background: none;
  text-align: left;
}
.artist-item:hover {
  background: var(--bg-hover);
}
.artist-item.active {
  background: var(--accent);
  color: var(--on-accent);
}
.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.85);
}
.name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.detail {
  overflow-y: auto;
  padding: 28px 36px 60px;
}
h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 46px;
  font-style: italic;
  font-weight: 800;
  text-transform: uppercase;
  text-shadow: 3px 3px 0 var(--blue);
}
header .muted {
  margin: 4px 0 16px;
}
.actions {
  display: flex;
  gap: 10px;
  margin-bottom: 28px;
}
h2 {
  margin: 0 0 12px;
  font-family: var(--font-display);
  font-style: italic;
  font-size: 24px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
section {
  margin-bottom: 30px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 20px;
}
.row {
  height: 52px;
}
.more {
  margin: 10px;
  font-size: 12.5px;
}
</style>
