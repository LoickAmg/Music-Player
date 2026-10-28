<script setup lang="ts">
import { computed, ref } from "vue";
import { dateFromName, voiceTitle } from "@/lib/audioKind";
import { formatCollection, formatDuration } from "@/lib/format";
import type { Track } from "@/lib/types";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";
import VirtualList from "@/components/VirtualList.vue";

// Notes vocales (WhatsApp, Telegram…) et enregistrements du téléphone, rangés à part de la
// musique : du plus récent au plus ancien, avec leur date et leur durée.
const library = useLibraryStore();
const player = usePlayerStore();
const ui = useUiStore();

const filter = ref<"tout" | "vocal" | "enregistrement">("tout");

const dated = computed(() =>
  library.voices
    .map((t) => ({ track: t, kind: library.kindOf(t), date: dateFromName(t.path) ?? new Date(t.added_secs * 1000) }))
    .sort((a, b) => b.date.getTime() - a.date.getTime()),
);
const counts = computed(() => ({
  vocal: dated.value.filter((v) => v.kind === "vocal").length,
  enregistrement: dated.value.filter((v) => v.kind === "enregistrement").length,
}));
const rows = computed(() => (filter.value === "tout" ? dated.value : dated.value.filter((v) => v.kind === filter.value)));
const totalDuration = computed(() => rows.value.reduce((s, v) => s + v.track.duration_secs, 0));

const dayFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

function play(index: number) {
  const ids = rows.value.map((v) => v.track.id);
  void player.playQueue(ids, ids[index]);
}
function openMenu(event: MouseEvent, t: Track) {
  ui.menu = { x: event.clientX, y: event.clientY, trackId: t.id };
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Vocaux</h1>
    <p class="page-sub">{{ formatCollection(rows.length, totalDuration).replace(/morceaux?/, rows.length > 1 ? "fichiers" : "fichier") }}</p>

    <div class="chips" role="tablist" aria-label="Type">
      <button type="button" role="tab" :aria-selected="filter === 'tout'" :class="{ on: filter === 'tout' }" @click="filter = 'tout'">
        Tout
      </button>
      <button type="button" role="tab" :aria-selected="filter === 'vocal'" :class="{ on: filter === 'vocal' }" @click="filter = 'vocal'">
        Notes vocales · {{ counts.vocal }}
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="filter === 'enregistrement'"
        :class="{ on: filter === 'enregistrement' }"
        @click="filter = 'enregistrement'"
      >
        Enregistrements · {{ counts.enregistrement }}
      </button>
    </div>

    <p v-if="!rows.length" class="empty">
      Aucun vocal ni enregistrement : les notes vocales WhatsApp et les enregistrements du téléphone se rangent ici, à
      l'écart de la musique.
    </p>
    <VirtualList v-else :items="rows" :row-height="58">
      <template #default="{ item, index }">
        <div
          class="voice"
          :class="{ current: player.currentTrack?.id === item.track.id }"
          role="row"
          tabindex="0"
          @click="(ui.isMobile || ui.isTouch) && play(index)"
          @dblclick="play(index)"
          @keydown.enter="play(index)"
          @contextmenu.prevent="openMenu($event, item.track)"
        >
          <button type="button" class="play" :aria-label="`Lire ${voiceTitle(item.track)}`" @click.stop="play(index)">
            <Icon :name="player.currentTrack?.id === item.track.id && !player.isPaused ? 'pause' : 'mic'" :size="17" />
          </button>
          <div class="text">
            <p class="title">{{ voiceTitle(item.track) }}</p>
            <p class="sub">
              {{ item.kind === "vocal" ? "Note vocale" : "Enregistrement" }} · {{ dayFormat.format(item.date) }}
            </p>
          </div>
          <span class="dur">{{ formatDuration(item.track.duration_secs) }}</span>
          <button type="button" class="icon-btn" aria-label="Plus d'actions" @click.stop="openMenu($event, item.track)">
            <Icon name="more" :size="18" />
          </button>
        </div>
      </template>
    </VirtualList>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.chips button {
  padding: 6px 13px;
  border: 0;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.08);
  color: var(--text-2);
  font-size: 13px;
}
.chips button.on {
  background: var(--accent);
  color: #fff;
}
.empty {
  margin-top: 8px;
  color: var(--text-2);
  max-width: 60ch;
}
.voice {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 100%;
  padding: 0 8px;
  border-radius: 8px;
}
.voice:hover,
.voice:focus-visible {
  background: rgba(var(--fg-rgb), 0.06);
}
.play {
  flex: none;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 50%;
  background: var(--accent-soft, rgba(var(--fg-rgb), 0.1));
  color: var(--accent);
}
.current .play {
  background: var(--accent);
  color: #fff;
}
.text {
  flex: 1;
  min-width: 0;
}
.title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.current .title {
  color: var(--accent);
}
.sub {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-2);
}
.dur {
  font-size: 12.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
</style>
