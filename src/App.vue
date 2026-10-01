<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { listen } from "@tauri-apps/api/event";
import { api, onScanEvents } from "@/lib/api";
import { installAndroidMedia, installInsets } from "@/lib/androidMedia";
import { nudgeClock, setClockRunning } from "@/lib/clock";
import type { Track } from "@/lib/types";
import { SCROLLER } from "@/lib/virtual";
import { useAmbienceStore } from "@/stores/ambience";
import { useEqStore } from "@/stores/eq";
import { useLibraryStore } from "@/stores/library";
import { useLyricsStore } from "@/stores/lyrics";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import { useUpdaterStore } from "@/stores/updater";
import Icon from "@/components/Icon.vue";
import MobileBar from "@/components/MobileBar.vue";
import MobileTop from "@/components/MobileTop.vue";
import NowPlaying from "@/components/NowPlaying.vue";
import PlaylistDialog from "@/components/PlaylistDialog.vue";
import PlayerBar from "@/components/PlayerBar.vue";
import SidePanel from "@/components/SidePanel.vue";
import Sidebar from "@/components/Sidebar.vue";
import TrackMenu from "@/components/TrackMenu.vue";
import UpdateDialog from "@/components/UpdateDialog.vue";
import AlbumDetail from "@/views/AlbumDetail.vue";
import AlbumsView from "@/views/AlbumsView.vue";
import ArtistsView from "@/views/ArtistsView.vue";
import PlaylistView from "@/views/PlaylistView.vue";
import PlaylistsView from "@/views/PlaylistsView.vue";
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
const updater = useUpdaterStore();

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

installInsets();

// Téléphone, fenêtre étroite, ou écran tactile jusqu'à 1100 px (tablette, pliable ouvert en
// paysage) : interface tactile (onglets en bas, lecteur compact). Même requête que les
// règles CSS « mobiles ».
const narrow = window.matchMedia("(max-width: 760px), (pointer: coarse) and (max-width: 1100px)");
ui.isMobile = narrow.matches;
narrow.addEventListener("change", (e) => (ui.isMobile = e.matches));
const coarse = window.matchMedia("(pointer: coarse)");
ui.isTouch = coarse.matches;
coarse.addEventListener("change", (e) => (ui.isTouch = e.matches));
const onAndroid = /Android/i.test(navigator.userAgent);

// WebView trop ancienne pour les couleurs dynamiques (color-mix, Chrome 111+) : conseil
// de mise à jour affiché une fois.
const WEBVIEW_NOTICE = "mp:webview-notice";
const oldWebView = ref(
  onAndroid &&
    !CSS.supports("color", "color-mix(in srgb, red, blue)") &&
    (() => {
      try {
        return localStorage.getItem(WEBVIEW_NOTICE) !== "1";
      } catch {
        return true;
      }
    })(),
);
function dismissWebViewNotice() {
  oldWebView.value = false;
  try {
    localStorage.setItem(WEBVIEW_NOTICE, "1");
  } catch {
    // stockage indisponible
  }
}

// Les couleurs de l'interface suivent la pochette du morceau en cours.
watch(
  () => player.currentTrack,
  (track) => void ambience.follow(track),
  { immediate: true },
);

// L'horloge d'affichage (progression, paroles) ne tourne que pendant la lecture ; une
// image suffit après une pause, un saut ou un changement de morceau.
watch(
  () => !player.isPaused && !!player.currentTrack,
  (on) => setClockRunning(on),
  { immediate: true },
);
watch(
  () => [player.positionStamp, player.currentTrack?.id, ui.nowPlayingOpen],
  () => nudgeClock(),
);

// Paroles cherchées dès le début du morceau (prêtes quand on les affiche), et celles du
// morceau suivant préparées en avance.
watch(
  () => player.currentTrack?.id,
  (id) => {
    void lyrics.load(id ?? null);
    lyrics.prefetch(player.upNextIds[0]);
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
const offPlayback: (() => void)[] = [];
const onPopState = () => ui.onPopState();
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
  // Morceau suivant enchaîné côté Rust (continue écran éteint) : l'interface suit.
  try {
    offPlayback.push(await listen<Track | null>("track-changed", (e) => void player.afterTrackChange(e.payload)));
    offPlayback.push(await listen<string>("playback-error", (e) => (player.error = e.payload)));
  } catch {
    // mode démo du navigateur
  }
  // Bouton retour d'Android : l'historique de la vue web suit les pages de l'interface.
  window.history.replaceState({ mp: "root" }, "");
  window.addEventListener("popstate", onPopState);
  installAndroidMedia(player);
  // Nouvelle version publiée ? (vérifiée une fois l'interface affichée)
  if (!demoMode) setTimeout(() => void updater.check(), 4000);
  saveInterval = setInterval(() => void api.saveSession(), 15_000);
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  player.stopPolling();
  unlisten?.();
  offPlayback.forEach((off) => off());
  window.removeEventListener("popstate", onPopState);
  if (saveInterval) clearInterval(saveInterval);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div v-if="ready" class="app" :class="{ mobile: ui.isMobile, 'has-track': !!player.currentTrack }">
    <Sidebar v-if="!ui.isMobile" ref="sidebar" />

    <div class="main">
      <PlayerBar v-if="!ui.isMobile" />
      <div v-if="demoMode" class="banner demo">
        Mode démonstration (navigateur) : pistes fictives, pas de son. L'application de bureau lit vos vrais fichiers.
      </div>
      <!-- Messages : bandeaux en haut sur ordinateur ; sur téléphone, cartes au-dessus du
           mini-lecteur, à portée de pouce (en haut, elles passaient sous la barre d'état).
           La mise à jour, elle, s'ouvre en fenêtre centrée sur téléphone (UpdateDialog). -->
      <div class="notices">
      <Transition name="fade">
        <div v-if="updater.available && !updater.dismissed && !ui.isMobile" class="banner update" role="status">
          <span v-if="updater.installing">
            Téléchargement de la version {{ updater.available.version }}…
            <template v-if="updater.progress !== null">{{ Math.round(updater.progress * 100) }} %</template>
            <template v-if="!onAndroid">— l'application redémarrera toute seule.</template>
          </span>
          <span v-else-if="updater.message">{{ updater.message }}</span>
          <span v-else>Music Player {{ updater.available.version }} est disponible (version installée : {{ updater.available.current }}).</span>
          <span v-if="!updater.installing" class="banner-actions">
            <button type="button" class="pill pill-accent" @click="updater.install()">Mettre à jour</button>
            <button type="button" class="icon-btn" aria-label="Plus tard" @click="updater.dismissed = true"><Icon name="close" :size="14" /></button>
          </span>
        </div>
      </Transition>
      <Transition name="fade">
        <div v-if="player.error" class="banner error" role="alert">
          <span>{{ player.error }}</span>
          <button type="button" class="icon-btn" aria-label="Fermer" @click="player.error = null"><Icon name="close" :size="14" /></button>
        </div>
      </Transition>
      <Transition name="fade">
        <div v-if="oldWebView" class="banner error" role="status">
          <span>
            Le composant d'affichage de ce téléphone est ancien : mettez à jour « Android System WebView »
            (Play Store ou boutique du téléphone) pour un affichage correct.
          </span>
          <button type="button" class="icon-btn" aria-label="Fermer" @click="dismissWebViewNotice"><Icon name="close" :size="14" /></button>
        </div>
      </Transition>
      </div>

      <div class="body">
        <div
          ref="scroller"
          class="content"
          :class="{ flush: ui.route.name === 'artists' && !ui.isMobile, home: !library.root || ui.route.name === 'recent', ambient: !!player.currentTrack }"
        >
          <MobileTop v-if="ui.isMobile" />
          <div v-if="!library.root" class="welcome">
            <img class="welcome-art" src="/logo.png" alt="" />
            <h1>Bienvenue</h1>
            <p>Choisissez le dossier où se trouve votre musique : l'application l'analyse une fois, puis s'ouvre instantanément.</p>
            <button type="button" class="pill pill-accent" @click="library.chooseFolderAndScan()">
              <Icon name="folder" :size="15" /> {{ onAndroid ? "Analyser la musique du téléphone" : "Choisir mon dossier de musique" }}
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
            <PlaylistsView v-else-if="ui.route.name === 'playlists'" />
          </template>
          <button v-if="!ui.isMobile && ui.canGoBack && ui.route.name !== 'recent' && ui.route.name !== 'artists'" type="button" class="back icon-btn" aria-label="Retour" @click="ui.back()">
            <Icon name="back" :size="18" />
          </button>
        </div>
        <SidePanel v-if="ui.panel && !ui.isMobile" />
      </div>
    </div>

    <Transition name="np">
      <NowPlaying v-if="ui.nowPlayingOpen" />
    </Transition>
    <MobileBar v-if="ui.isMobile" />
    <UpdateDialog />
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
.app.mobile {
  grid-template-columns: 1fr;
  /* Encoche ou caméra sur le côté (paysage, pliables) */
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}
/* Espace réservé sous le contenu pour les onglets (+ le mini-lecteur s'il y a un morceau) */
.app.mobile .content {
  padding-bottom: calc(76px + var(--safe-bottom));
}
.app.mobile.has-track .content {
  padding-bottom: calc(140px + var(--safe-bottom));
}
.app.mobile .toast {
  bottom: calc(150px + var(--safe-bottom));
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
  background: rgba(31, 107, 255, 0.22);
  color: #cfe6ff;
}
.update {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: #e6f1ff;
}
.banner-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.update .pill {
  padding: 5px 14px;
  font-size: 12px;
}
/* Téléphone : cartes au-dessus du mini-lecteur (et des onglets), larges et lisibles. */
.app.mobile .notices {
  position: fixed;
  left: calc(12px + var(--safe-left));
  right: calc(12px + var(--safe-right));
  bottom: calc(84px + var(--safe-bottom));
  z-index: 45;
  display: grid;
  gap: 8px;
  pointer-events: none;
}
.app.mobile.has-track .notices {
  bottom: calc(150px + var(--safe-bottom));
}
.app.mobile .notices .banner {
  pointer-events: auto;
  padding: 14px 16px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.45;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
}
.app.mobile .notices .error {
  background: #4a1230;
}
.app.mobile .demo {
  padding-top: calc(var(--safe-top) + 7px);
}
.error {
  background: #3a0f24;
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
  background: rgba(10, 26, 64, 0.95);
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
