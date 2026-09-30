<script setup lang="ts">
import { computed } from "vue";
import { useNow } from "@/lib/clock";
import { usePlayerStore } from "@/stores/player";
import { useUiStore, type Route } from "@/stores/ui";
import Artwork from "./Artwork.vue";
import Icon from "./Icon.vue";

// Téléphone : mini-lecteur (touche pour ouvrir « À l'écoute ») et onglets en bas d'écran.
const player = usePlayerStore();
const ui = useUiStore();
const now = useNow();

const track = computed(() => player.currentTrack);
const ratio = computed(() => {
  const d = track.value?.duration_secs ?? 0;
  return d ? Math.min(1, player.positionAt(now.value) / d) : 0;
});

const TABS: { route: Route; label: string; icon: string }[] = [
  { route: { name: "recent" }, label: "Accueil", icon: "clock" },
  { route: { name: "albums" }, label: "Albums", icon: "album" },
  { route: { name: "artists" }, label: "Artistes", icon: "artist" },
  { route: { name: "songs" }, label: "Morceaux", icon: "songs" },
  { route: { name: "playlists" }, label: "Playlists", icon: "playlist" },
];

function active(route: Route) {
  const name = ui.route.name;
  if (route.name === "albums") return name === "albums" || name === "album";
  if (route.name === "playlists") return name === "playlists" || name === "playlist";
  return name === route.name;
}
</script>

<template>
  <div class="mobile-bar">
    <div v-if="track" class="mini" role="button" tabindex="0" aria-label="Afficher « À l'écoute »" @click="ui.openNowPlaying()">
      <Artwork :track="track" :radius="6" eager class="mini-art" />
      <div class="mini-text">
        <span class="t">{{ track.title }}</span>
        <span class="a">{{ track.artist }}</span>
      </div>
      <button type="button" class="mini-btn" :aria-label="player.isPaused ? 'Lire' : 'Pause'" @click.stop="player.togglePlayPause()">
        <Icon :name="player.isPaused ? 'play' : 'pause'" :size="24" />
      </button>
      <button type="button" class="mini-btn" aria-label="Suivant" @click.stop="player.next()">
        <Icon name="next" :size="22" />
      </button>
      <span class="mini-progress" :style="{ transform: `scaleX(${ratio})` }" />
    </div>
    <nav class="tabs" aria-label="Navigation">
      <button v-for="t in TABS" :key="t.route.name" type="button" class="tab" :class="{ on: active(t.route) }" @click="ui.go(t.route)">
        <Icon :name="t.icon" :size="21" />
        <span>{{ t.label }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.mobile-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  padding-bottom: env(safe-area-inset-bottom);
  background: rgba(4, 11, 32, 0.94);
  backdrop-filter: blur(24px) saturate(1.4);
  border-top: 1px solid var(--separator);
}
.mini {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 8px 0;
  padding: 7px 8px;
  border-radius: 12px;
  background: linear-gradient(120deg, rgba(31, 107, 255, 0.28), rgba(63, 224, 255, 0.12));
  box-shadow: inset 0 0 0 1px rgba(120, 180, 255, 0.18);
  overflow: hidden;
}
.mini-art {
  width: 42px;
  flex: none;
}
.mini-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.mini-text span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.t {
  font-weight: 600;
  font-size: 14px;
}
.a {
  font-size: 12.5px;
  color: var(--text-2);
}
.mini-btn {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--text);
}
.mini-btn:active {
  background: var(--bg-active);
}
.mini-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent);
  transform-origin: left;
}
.tabs {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  padding: 4px 4px 6px;
}
.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 0 4px;
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
}
.tab.on {
  color: var(--accent);
}
</style>
