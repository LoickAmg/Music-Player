<script setup lang="ts">
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";
import LyricsView from "./LyricsView.vue";
import QueueList from "./QueueList.vue";

const ui = useUiStore();
</script>

<template>
  <aside class="side-panel" :aria-label="ui.panel === 'lyrics' ? 'Paroles' : 'À suivre'">
    <div class="tabs">
      <button type="button" :class="{ on: ui.panel === 'lyrics' }" @click="ui.panel = 'lyrics'">Paroles</button>
      <button type="button" :class="{ on: ui.panel === 'queue' }" @click="ui.panel = 'queue'">À suivre</button>
      <button type="button" class="icon-btn close" aria-label="Fermer le panneau" @click="ui.panel = null">
        <Icon name="close" :size="15" />
      </button>
    </div>

    <LyricsView v-if="ui.panel === 'lyrics'" />

    <QueueList v-else />
  </aside>
</template>

<style scoped>
.side-panel {
  /* Paroles sur le fond du thème : couleur du texte du thème. */
  --lyrics-rgb: var(--fg-rgb);
  width: 340px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--separator);
  animation: slide 0.25s var(--ease);
}
@keyframes slide {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
}
.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 12px 6px;
}
.tabs > button:not(.close) {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--text-2);
  font-weight: 600;
  font-size: 13px;
}
.tabs > button.on {
  background: var(--bg-active);
  color: var(--text);
}
.close {
  margin-left: auto;
}
</style>
