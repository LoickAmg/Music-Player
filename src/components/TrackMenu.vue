<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { albumKey, useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import { usePlayerStore } from "@/stores/player";

const ui = useUiStore();
const library = useLibraryStore();
const playlists = usePlaylistsStore();
const player = usePlayerStore();

const box = ref<HTMLElement | null>(null);
const pos = ref({ x: 0, y: 0 });
const showPlaylists = ref(false);

const track = computed(() => (ui.menu ? library.byId(ui.menu.trackId) : null));

watch(
  () => ui.menu,
  async (menu) => {
    showPlaylists.value = false;
    if (!menu) return;
    pos.value = { x: menu.x, y: menu.y };
    await nextTick();
    const rect = box.value?.getBoundingClientRect();
    if (rect) {
      pos.value = {
        x: Math.min(menu.x, window.innerWidth - rect.width - 8),
        y: Math.min(menu.y, window.innerHeight - rect.height - 8),
      };
    }
  },
);

function close() {
  ui.menu = null;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

async function addTo(playlistId: string, name: string) {
  if (!track.value) return;
  await playlists.addTrack(playlistId, track.value.id);
  ui.notify(`Ajouté à « ${name} »`);
  close();
}
async function addToNew() {
  if (!track.value) return;
  const name = `Nouvelle playlist ${playlists.items.length + 1}`;
  const id = await playlists.create(name);
  if (id) await addTo(id, name);
}
async function removeFromPlaylist() {
  if (!track.value || !ui.menu?.playlistId) return;
  await playlists.removeTrack(ui.menu.playlistId, track.value.id);
  close();
}
</script>

<template>
  <div v-if="ui.menu && track" class="scrim" @mousedown.self="close" @contextmenu.prevent="close">
    <div ref="box" class="menu" role="menu" :style="{ left: `${pos.x}px`, top: `${pos.y}px` }">
      <p class="head">{{ track.title }}</p>
      <button type="button" role="menuitem" @click="player.playTrackNow(track.id); close()">Lire maintenant</button>
      <button type="button" role="menuitem" @click="showPlaylists = !showPlaylists">
        Ajouter à une playlist <span class="chev">›</span>
      </button>
      <div v-if="showPlaylists" class="sub">
        <button type="button" role="menuitem" @click="addToNew">＋ Nouvelle playlist</button>
        <button v-for="p in playlists.items" :key="p.id" type="button" role="menuitem" @click="addTo(p.id, p.name)">
          {{ p.name }}
        </button>
      </div>
      <hr />
      <button
        v-if="track.album !== 'Album inconnu'"
        type="button"
        role="menuitem"
        @click="ui.go({ name: 'album', key: albumKey(track)}); close()"
      >
        Afficher l'album
      </button>
      <button type="button" role="menuitem" @click="ui.go({ name: 'artists', artist: track.artist }); close()">
        Afficher l'artiste
      </button>
      <template v-if="ui.menu.playlistId">
        <hr />
        <button type="button" role="menuitem" class="danger" @click="removeFromPlaylist">Retirer de la playlist</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.menu {
  position: fixed;
  min-width: 220px;
  max-width: 300px;
  max-height: 70vh;
  overflow: auto;
  padding: 5px;
  border-radius: 10px;
  background: rgba(44, 44, 48, 0.94);
  backdrop-filter: blur(24px) saturate(1.6);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(255, 255, 255, 0.12);
  animation: pop 0.14s var(--ease);
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
.head {
  margin: 4px 10px 6px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
button {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: 6px;
  background: none;
  text-align: left;
  font-size: 13px;
}
button:hover {
  background: var(--accent);
  color: #fff;
}
.sub {
  margin: 2px 0 2px 10px;
  border-left: 1px solid var(--separator);
  padding-left: 4px;
}
.chev {
  color: var(--text-2);
}
.danger {
  color: #ff6b7d;
}
hr {
  border: 0;
  border-top: 1px solid var(--separator);
  margin: 5px 6px;
}
</style>
