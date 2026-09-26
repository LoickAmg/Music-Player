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
import LegalDialog from "@/components/LegalDialog.vue";

type View = "library" | "playlists" | "equalizer";

const library = useLibraryStore();
const player = usePlayerStore();
const playlists = usePlaylistsStore();
const eq = useEqStore();

const view = ref<View>("library");
const activePlaylistId = ref<string | null>(null);
const showQueue = ref(false);
const showLegal = ref(false);
const ready = ref(false);
// Vrai quand la page tourne dans un navigateur (npm run dev) et non dans l'application de bureau.
const demoMode = "__MP_DEMO__" in window;

function navigate(next: View) {
  view.value = next;
  if (next === "playlists") activePlaylistId.value = null;
}

function openPlaylist(id: string | null) {
  activePlaylistId.value = id;
  view.value = "playlists";
}

function openLegal() {
  showLegal.value = true;
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
    <div v-if="demoMode" class="demo-banner" role="status">
      Mode démonstration (navigateur) : les pistes sont fictives, ni le son ni l'ajout de dossier ne
      fonctionnent ici. Lancez l'application de bureau avec <code>npm run tauri dev</code>.
    </div>
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

    <div v-if="player.error" class="error-banner" role="alert">
      <span>{{ player.error }}</span>
      <button type="button" class="banner-close" aria-label="Fermer" @click="player.error = null">×</button>
    </div>

    <NowPlayingBar @toggle-queue="showQueue = !showQueue" />

    <footer class="app-footer">
      <span class="footer-brand">Music Player</span>
      <nav class="footer-links" aria-label="Liens légaux">
        <button type="button" class="footer-link" @click="openLegal">Mentions légales</button>
        <button type="button" class="footer-link" @click="openLegal">Confidentialité</button>
        <button type="button" class="footer-link" @click="openLegal">Contact</button>
      </nav>
    </footer>

    <LegalDialog v-if="showLegal" @close="showLegal = false" />
  </div>
</template>

<style scoped>
.demo-banner {
  padding: 0.5rem 1rem;
  background: #4a3410;
  color: #ffe2a3;
  font-size: 0.85rem;
  text-align: center;
}
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.55rem 1rem;
  background: #4a1a1a;
  color: #ffd6d6;
  font-size: 0.9rem;
}
.banner-close {
  background: none;
  border: none;
  color: inherit;
  font-size: 1.2rem;
  cursor: pointer;
}

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

.app-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1em;
  padding: 0.45em 1.1em;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 0.75em;
  color: var(--text-dim);
}

.footer-brand {
  font-weight: 600;
  color: var(--text);
}

.footer-links {
  display: flex;
  gap: 1em;
}

.footer-link {
  background: transparent;
  border: none;
  padding: 0;
  color: var(--text-dim);
  font-size: 0.85em;
  cursor: pointer;
}

.footer-link:hover {
  color: var(--accent);
}
</style>
