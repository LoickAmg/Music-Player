<script setup lang="ts">
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// Téléphone : retour, recherche et réglages en haut de l'écran.
const ui = useUiStore();
</script>

<template>
  <header class="mobile-top">
    <button v-if="ui.canGoBack && !['recent', 'albums', 'artists', 'songs', 'playlists'].includes(ui.route.name)" type="button" class="top-btn" aria-label="Retour" @click="ui.back()">
      <Icon name="back" :size="22" />
    </button>
    <label class="search">
      <Icon name="search" :size="16" />
      <input
        :value="ui.search"
        type="search"
        placeholder="Rechercher"
        aria-label="Rechercher dans la bibliothèque"
        enterkeyhint="search"
        @input="ui.setSearch(($event.target as HTMLInputElement).value)"
      />
    </label>
    <button type="button" class="top-btn" :class="{ on: ui.route.name === 'settings' }" aria-label="Réglages" @click="ui.go({ name: 'settings' })">
      <Icon name="settings" :size="21" />
    </button>
  </header>
</template>

<style scoped>
.mobile-top {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: calc(env(safe-area-inset-top) + 10px) 12px 10px;
  background: linear-gradient(rgba(5, 13, 36, 0.96), rgba(5, 13, 36, 0.82));
  backdrop-filter: blur(20px);
}
.search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 12px;
  border-radius: 10px;
  background: rgba(80, 170, 255, 0.1);
  color: var(--text-2);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  font-size: 15px;
}
.top-btn {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 10px;
  background: none;
  color: var(--text-2);
}
.top-btn.on {
  color: var(--accent);
}
</style>
