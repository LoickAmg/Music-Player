<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { api, onScanEvents } from "@/lib/api";
import { SCROLLER } from "@/lib/virtual";
import { useAmbienceStore } from "@/stores/ambience";
import { useEqStore } from "@/stores/eq";
import { useLibraryStore } from "@/stores/library";
import { useLyricsStore } from "@/stores/lyrics";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";
import NowPlaying from "@/components/NowPlaying.vue";
import PlaylistDialog from "@/components/PlaylistDialog.vue";
import PlayerBar from "@/components/PlayerBar.vue";
import SidePanel from "@/components/SidePanel.vue";
import Sidebar from "@/components/Sidebar.vue";
import TrackMenu from "@/components/TrackMenu.vue";
import AlbumDetail from "@/views/AlbumDetail.vue";
import AlbumsView from "@/views/AlbumsView.vue";
import ArtistsView from "@/views/ArtistsView.vue";
import PlaylistView from "@/views/PlaylistView.vue";
import RecentView from "@/views/RecentView.vue";
import SearchView from "@/views/SearchView.vue";
import SettingsView from "@/views/SettingsView.vue";
import SongsView from "@/views/SongsView.vue";

const library = useLibraryStore();
const player = usePlayerStore();
const playlists = usePlaylistsStore();
const eq = useEqStore();
const ui = useUiStore();
const lyrics = useLyricsStore();
const ambience = useAmbienceStore();

const ready = ref(false);
const demoMode = "__MP_DEMO__" in window;
const scroller = ref<HTMLElement | null>(null);
const sidebar = ref<InstanceType<typeof Sidebar> | null>(null);
provide(SCROLLER, scroller);

// Chaque changement de page repart du haut.
watch(
  () => ui.route,
  () => scroller.value?.scrollTo({ top: 0 }),
);

// Les couleurs de l'interface suivent la pochette du morceau en cours.
watch(
  () => player.currentTrack,
  (track) => void ambience.follow(track),
  { immediate: true },
);

// Les paroles ne sont chargées que lorsqu'elles sont visibles.
watch(
  () => [player.currentTrack?.id, ui.panel, ui.nowPlayingOpen] as const,
  ([id, panel, full]) => {
    if (panel === "lyrics" || full) void lyrics.load(id ?? null);
  },
);

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

function onKey(e: KeyboardEvent) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "f") {
    e.preventDefault();
    sidebar.value?.focusSearch();
    return;
  }
  if (ctrl && e.key.toLowerCase() === "l") {
    e.preventDefault();
    ui.togglePanel("lyrics");
    return;
  }
  if (isTyping(e) || !player.currentTrack) return;
  if (e.code === "Space") {
    e.preventDefault();
    void player.togglePlayPause();
  } else if (ctrl && e.key === "ArrowRight") {
    void player.next();
  } else if (ctrl && e.key === "ArrowLeft") {
    void player.previous();
  } else if (e.key === "ArrowRight") {
    void player.seek(Math.min(player.currentTrack.duration_secs, player.positionAt(performance.now()) + 5));
  } else if (e.key === "ArrowLeft") {
    void player.seek(Math.max(0, player.positionAt(performance.now()) - 5));
  }
}

let unlisten: (() => void) | null = null;
let saveInterval: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  unlisten = await onScanEvents({
    progress: (p) => library.applyProgress(p),
    updated: (tracks) => library.applyScanResult(tracks),
  });
  const initial = await api.getInitialState();
  library.setFromInitialState(initial.library_root, initial.library, initial.scanning);
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
  saveInterval = setInterval(() => void api.saveSession(), 15_000);
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  player.stopPolling();
  unlisten?.();
  if (saveInterval) clearInterval(saveInterval);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div v-if="ready" class="app">
    <Sidebar ref="sidebar" />

    <div class="main">
      <PlayerBar />
      <div v-if="demoMode" class="banner demo">
        Mode démonstration (navigateur) : pistes fictives, pas de son. L'application de bureau lit vos vrais fichiers.
      </div>
      <Transition name="fade">
        <div v-if="player.error" class="banner error" role="alert">
          <span>{{ player.error }}</span>
          <button type="button" class="icon-btn" aria-label="Fermer" @click="player.error = null"><Icon name="close" :size="14" /></button>
        </div>
      </Transition>

      <div class="body">
        <div
          ref="scroller"
          class="content"
          :class="{ flush: ui.route.name === 'artists', home: !library.root || ui.route.name === 'recent', ambient: !!player.currentTrack }"
        >
          <div v-if="!library.root" class="welcome">
            <img class="welcome-art" src="/logo.png" alt="" />
            <h1>Bienvenue</h1>
            <p>Choisissez le dossier où se trouve votre musique : l'application l'analyse une fois, puis s'ouvre instantanément.</p>
            <button type="button" class="pill pill-accent" @click="library.chooseFolderAndScan()">
              <Icon name="folder" :size="15" /> Choisir mon dossier de musique
            </button>
          </div>
          <div v-else-if="!library.tracks.length && library.scanning" class="welcome">
            <span class="big-spinner" />
            <h1>Analyse de votre musique…</h1>
            <p v-if="library.progress?.total">{{ library.progress.done.toLocaleString("fr-FR") }} / {{ library.progress.total.toLocaleString("fr-FR") }} fichiers</p>
          </div>
          <template v-else>
            <RecentView v-if="ui.route.name === 'recent'" />
            <AlbumsView v-else-if="ui.route.name === 'albums'" />
            <ArtistsView v-else-if="ui.route.name === 'artists'" :artist="ui.route.artist" />
            <SongsView v-else-if="ui.route.name === 'songs'" />
            <AlbumDetail v-else-if="ui.route.name === 'album'" :key="ui.route.key" :album-key="ui.route.key" />
            <PlaylistView v-else-if="ui.route.name === 'playlist'" :key="ui.route.id" :id="ui.route.id" />
            <SearchView v-else-if="ui.route.name === 'search'" :query="ui.route.query" />
            <SettingsView v-else-if="ui.route.name === 'settings'" />
          </template>
          <button v-if="ui.canGoBack && ui.route.name !== 'recent' && ui.route.name !== 'artists'" type="button" class="back icon-btn" aria-label="Retour" @click="ui.back()">
            <Icon name="back" :size="18" />
          </button>
        </div>
        <SidePanel v-if="ui.panel" />
      </div>
    </div>

    <Transition name="np">
      <NowPlaying v-if="ui.nowPlayingOpen" />
    </Transition>
    <TrackMenu />
    <PlaylistDialog />
    <Transition name="fade">
      <div v-if="ui.toast" class="toast" role="status">{{ ui.toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: grid;
  grid-template-columns: 236px 1fr;
  background: var(--bg-content);
}
.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.content {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
/* Hors accueil : un halo discret aux couleurs de la pochette en cours. */
.content.ambient {
  background:
    radial-gradient(ellipse 90% 55% at 50% -12%, color-mix(in srgb, var(--amb-primary) 34%, transparent), transparent 72%),
    radial-gradient(ellipse 50% 40% at 100% 0%, color-mix(in srgb, var(--amb-secondary) 18%, transparent), transparent 70%);
}
/* Accueil : palette de Persona 3 Reload (bleu nuit, bleu électrique, cyan), couleurs seulement. */
.content.home {
  --accent: #3fb8ff;
  --accent-soft: rgba(63, 184, 255, 0.16);
  --bg-hover: rgba(63, 184, 255, 0.08);
  --bg-active: rgba(63, 184, 255, 0.16);
  --text-2: rgba(205, 225, 255, 0.68);
  --text-3: rgba(170, 200, 245, 0.42);
  --separator: rgba(120, 170, 255, 0.12);
  background:
    radial-gradient(ellipse 70% 50% at 90% -5%, rgba(31, 107, 255, 0.42), transparent 70%),
    radial-gradient(ellipse 55% 45% at 0% 105%, rgba(63, 224, 255, 0.14), transparent 70%),
    linear-gradient(165deg, #0a2361 0%, #061640 40%, #030b24 100%);
}
.content.flush {
  overflow: hidden;
}
.back {
  position: absolute;
  top: 14px;
  left: 10px;
  z-index: 3;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 16px;
  font-size: 12.5px;
}
.demo {
  background: #3b2d10;
  color: #ffd98a;
}
.error {
  background: #4a1620;
  color: #ffd1d8;
}
.welcome {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px;
  text-align: center;
}
.welcome h1 {
  margin: 12px 0 0;
  font-family: var(--font-display);
  font-size: 28px;
}
.welcome p {
  max-width: 420px;
  margin: 0 0 12px;
  color: var(--text-2);
  line-height: 1.55;
}
.welcome-art {
  width: 112px;
  height: 112px;
  border-radius: 26px;
  object-fit: cover;
  box-shadow: 0 16px 40px rgba(0, 10, 40, 0.5);
}
.big-spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.12);
  border-top-color: var(--accent);
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  z-index: 70;
  transform: translateX(-50%);
  padding: 9px 16px;
  border-radius: 10px;
  background: rgba(50, 50, 54, 0.95);
  backdrop-filter: blur(20px);
  box-shadow: var(--shadow);
  font-size: 13px;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.np-leave-active {
  transition: opacity 0.3s, transform 0.3s var(--ease);
}
.np-leave-to {
  opacity: 0;
  transform: translateY(40px);
}
</style>
