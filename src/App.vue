<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "@/lib/api";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import { useEqStore } from "@/stores/eq";
import Sidebar from "@/components/Sidebar.vue";
import LibraryPanel from "@/components/LibraryPanel.vue";
import PlaylistsPanel from "@/components/PlaylistsPanel.vue";
import EqualizerPanel from "@/components/EqualizerPanel.vue";
import NowPlayingBar from "@/components/NowPlayingBar.vue";
import QueueDrawer from "@/components/QueueDrawer.vue";

type View = "library" | "playlists" | "equalizer";

const library = useLibraryStore();
const player = usePlayerStore();
const playlists = usePlaylistsStore();
const eq = useEqStore();

const view = ref<View>("library");
const activePlaylistId = ref<string | null>(null);
const showQueue = ref(false);
const ready = ref(false);

function navigate(next: View) {
  view.value = next;
  if (next === "playlists") activePlaylistId.value = null;
}

function openPlaylist(id: string | null) {
  activePlaylistId.value = id;
  view.value = "playlists";
}

let saveInterval: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  const initial = await api.getInitialState();
  library.setFromInitialState(initial.library_root, initial.library);
  playlists.setFromInitialState(initial.playlists);
  eq.setFromInitialState(initial.eq_gains);
  player.setFromInitialState({
    current_track: initial.current_track,
    position_secs: initial.position_secs,
    volume: initial.volume,
    queue: initial.queue,
  });
  ready.value = true;

  player.startPolling();
  // Sauvegarde la session régulièrement (pas seulement à la fermeture, au
  // cas où l'app serait tuée plutôt que fermée proprement).
  saveInterval = setInterval(() => {
    void api.saveSession();
  }, 15_000);
});

onBeforeUnmount(() => {
  player.stopPolling();
  if (saveInterval) clearInterval(saveInterval);
});
</script>

<template>
  <div v-if="ready" class="app-shell">
    <div class="body">
      <Sidebar :active-view="view" :active-playlist-id="activePlaylistId" @navigate="navigate" @open-playlist="openPlaylist" />

      <main class="content">
        <LibraryPanel v-if="view === 'library'" />
        <PlaylistsPanel
          v-else-if="view === 'playlists'"
          :active-playlist-id="activePlaylistId"
          @open-playlist="openPlaylist"
        />
        <EqualizerPanel v-else-if="view === 'equalizer'" />
      </main>

      <QueueDrawer v-if="showQueue" @close="showQueue = false" />
    </div>

    <NowPlayingBar @toggle-queue="showQueue = !showQueue" />
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.body {
  flex: 1;
  display: grid;
  grid-template-columns: 220px 1fr auto;
  min-height: 0;
}

.content {
  min-width: 0;
  overflow-y: auto;
}
</style>
