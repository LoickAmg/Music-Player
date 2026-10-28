<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppearanceStore } from "@/stores/appearance";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useShareStore } from "@/stores/share";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";
import PlaylistCover from "./PlaylistCover.vue";
import FriendAvatar from "./FriendAvatar.vue";
import { useFriendsStore } from "@/stores/friends";
import { useAvisStore } from "@/stores/avis";

const ui = useUiStore();
const library = useLibraryStore();
const playlists = usePlaylistsStore();
const appearance = useAppearanceStore();
const share = useShareStore();
const friends = useFriendsStore();
const avis = useAvisStore();
const searchInput = ref<HTMLInputElement | null>(null);

defineExpose({ focusSearch: () => searchInput.value?.focus() });

const nav = [
  { name: "recent", label: "Ajouts récents", icon: "clock" },
  { name: "artists", label: "Artistes", icon: "artist" },
  { name: "albums", label: "Albums", icon: "album" },
  { name: "songs", label: "Morceaux", icon: "songs" },
  { name: "favorites", label: "Titres aimés", icon: "heart" },
  { name: "stats", label: "Mon écoute", icon: "stats" },
] as const;

const progress = computed(() => {
  const p = library.progress;
  if (!p || !p.total) return null;
  return Math.round((p.done / p.total) * 100);
});

function newPlaylist() {
  ui.playlistDialog = { mode: "create" };
}
</script>

<template>
  <aside class="sidebar">
    <label class="search fieldbox">
      <Icon name="search" :size="15" />
      <input
        ref="searchInput"
        :value="ui.search"
        type="search"
        placeholder="Rechercher"
        aria-label="Rechercher dans la bibliothèque"
        @input="ui.setSearch(($event.target as HTMLInputElement).value)"
        @keydown.esc="ui.setSearch(''); ($event.target as HTMLInputElement).blur()"
      />
    </label>

    <nav class="section" aria-label="Bibliothèque">
      <p class="section-title">Bibliothèque</p>
      <button
        v-for="item in nav"
        :key="item.name"
        type="button"
        class="nav-item"
        :class="{ active: ui.route.name === item.name }"
        @click="ui.go({ name: item.name })"
      >
        <Icon :name="item.icon" :size="17" class="ico" />
        {{ item.label }}
      </button>
      <button
        v-if="library.voices.length"
        type="button"
        class="nav-item"
        :class="{ active: ui.route.name === 'voices' }"
        @click="ui.go({ name: 'voices' })"
      >
        <Icon name="mic" :size="17" class="ico" />
        Vocaux
      </button>
    </nav>

    <nav class="section" aria-label="Proches">
      <p class="section-title">
        Proches
        <span
          v-if="friends.incoming.length + friends.unreadTotal"
          class="badge"
          :title="`${friends.incoming.length} demande(s), ${friends.unreadTotal} message(s) non lu(s)`"
          >{{ friends.incoming.length + friends.unreadTotal }}</span
        >
      </p>
      <button
        v-for="x in friends.listening.slice(0, 4)"
        :key="x.friend.code"
        type="button"
        class="nav-item friend"
        :title="`${x.friend.name} : ${x.status.title} · ${x.status.artist}`"
        @click="ui.go({ name: 'friends' })"
      >
        <FriendAvatar :name="x.friend.name" :src="x.friend.avatar" :size="22" :live="x.status.playing" />
        <span class="friend-text">
          <span class="friend-name">{{ x.friend.name }}</span>
          <span class="friend-track">{{ x.status.playing ? "♪ " : "❚❚ " }}{{ x.status.title }}</span>
        </span>
      </button>
      <button type="button" class="nav-item" :class="{ active: ui.route.name === 'friends' }" @click="ui.go({ name: 'friends' })">
        <Icon name="user" :size="17" class="ico" />
        {{ friends.enabled ? (friends.friends.length ? "Tous mes proches" : "Ajouter des proches") : "Voir ce qu'écoutent mes proches" }}
      </button>
    </nav>

    <nav class="section playlists" aria-label="Playlists">
      <p class="section-title">
        Playlists
        <span class="title-actions">
          <button type="button" class="add" title="Recevoir un partage (code)" aria-label="Recevoir un partage avec un code" @click="share.receiving = true">
            <Icon name="import" :size="14" />
          </button>
          <button type="button" class="add" title="Nouvelle playlist" aria-label="Nouvelle playlist" @click="newPlaylist">
            <Icon name="plus" :size="15" />
          </button>
        </span>
      </p>
      <button
        v-for="p in playlists.items"
        :key="p.id"
        type="button"
        class="nav-item"
        :class="{ active: ui.route.name === 'playlist' && ui.route.id === p.id }"
        @click="ui.go({ name: 'playlist', id: p.id })"
      >
        <PlaylistCover :name="p.name" :theme="p.theme" :styling="p.style" :radius="4" mini class="pl-thumb" />
        <span class="ellipsis">{{ p.name }}</span>
      </button>
      <p v-if="!playlists.items.length" class="empty">Aucune playlist pour l'instant.</p>
    </nav>

    <div class="foot">
      <div v-if="library.scanning" class="scan" role="status">
        <span class="spinner" />
        <span>
          Analyse de la bibliothèque<span v-if="progress !== null"> · {{ progress }} %</span>
        </span>
      </div>
      <button v-if="avis.isAdmin" type="button" class="nav-item" :class="{ active: ui.route.name === 'avis' }" @click="ui.go({ name: 'avis' })">
        <Icon name="check" :size="17" class="ico" />
        Avis reçus
        <span v-if="avis.fresh" class="badge">{{ avis.fresh }}</span>
      </button>
      <button type="button" class="nav-item feedback" @click="ui.feedback = true">
        <Icon name="lyrics" :size="17" class="ico" />
        Un avis ?
      </button>
      <div class="foot-row">
        <button
          type="button"
          class="nav-item"
          :class="{ active: ui.route.name === 'settings' || ui.route.name === 'appearance' }"
          @click="ui.go({ name: 'settings' })"
        >
          <span v-if="appearance.settings.profile.avatar" class="me"><img :src="appearance.assetUrl(appearance.settings.profile.avatar)" alt="" /></span>
          <Icon v-else name="settings" :size="17" class="ico" />
          <span class="me-name">{{ appearance.settings.profile.name || "Réglages" }}</span>
        </button>
        <button
          type="button"
          class="icon-btn"
          :title="appearance.light ? 'Passer en mode sombre' : 'Passer en mode clair'"
          :aria-label="appearance.light ? 'Passer en mode sombre' : 'Passer en mode clair'"
          @click="appearance.toggleScheme()"
        >
          <Icon :name="appearance.light ? 'moon' : 'sun'" :size="17" />
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px 10px 10px;
  background: linear-gradient(180deg, #06122f 0%, #040b20 100%);
  border-right: 1px solid var(--separator);
}
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 9px;
  margin: 0 4px 18px;
  border-radius: 7px;
  background: rgba(var(--fg-rgb), 0.07);
  color: var(--text-2);
  box-shadow: inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.06);
}
.search:focus-within {
  box-shadow: 0 0 0 2px var(--accent);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  font-size: 13px;
}
.search input::-webkit-search-cancel-button {
  filter: invert(1) opacity(0.5);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 18px;
}
.badge {
  min-width: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
}
.friend {
  gap: 9px;
}
.friend-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.2;
}
.friend-name {
  font-size: 12.5px;
}
.friend-track {
  font-size: 11px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.playlists {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 10px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
}
.title-actions {
  display: flex;
  gap: 2px;
}
.add {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--text-2);
}
.add:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: none;
  text-align: left;
  font-size: 13.5px;
  min-width: 0;
}
.nav-item:hover {
  background: var(--bg-hover);
}
.nav-item.active {
  background: var(--bg-active);
}
.ico {
  flex: none;
  color: var(--accent);
}
.pl-thumb {
  flex: none;
  width: 20px;
}
.ellipsis {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.empty {
  margin: 2px 10px;
  font-size: 12px;
  color: var(--text-3);
}
.foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--separator);
}
.foot-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.foot-row .nav-item {
  flex: 1;
  min-width: 0;
}
.me {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  overflow: hidden;
}
.me img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.me-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-2);
}
.spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid rgba(var(--fg-rgb), 0.15);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
