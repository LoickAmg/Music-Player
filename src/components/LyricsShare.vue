<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { coverUrl } from "@/lib/covers";
import { drawLyricsCard, MAX_LINES } from "@/lib/lyricsCard";
import { paletteFromImage } from "@/lib/palette";
import { shareCanvas } from "@/lib/shareCard";
import { useLyricsStore } from "@/stores/lyrics";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// « Partager un extrait » : on touche les lignes à garder, l'aperçu montre la carte telle qu'elle
// partira sur les réseaux.
const ui = useUiStore();
const lyrics = useLyricsStore();
const player = usePlayerStore();

const lines = computed(() => {
  const l = lyrics.lyrics;
  const all = l?.synced ? l.synced.map((x) => x.text) : (l?.plain ?? "").split("\n");
  return all.map((t) => t.trim()).filter(Boolean);
});
const picked = ref<number[]>([]);
const chosen = computed(() => [...picked.value].sort((a, b) => a - b).map((i) => lines.value[i]));
const preview = ref<string | null>(null);
const busy = ref(false);
let canvas: HTMLCanvasElement | null = null;
let token = 0;

watch(
  () => ui.lyricsShare,
  () => {
    picked.value = [];
    preview.value = null;
    canvas = null;
  },
);

function toggle(i: number) {
  if (picked.value.includes(i)) picked.value = picked.value.filter((x) => x !== i);
  else if (picked.value.length < MAX_LINES) picked.value = [...picked.value, i];
  else ui.notify(`${MAX_LINES} lignes au plus sur une carte`);
}

watch(chosen, async (list) => {
  const mine = ++token;
  const track = player.currentTrack;
  if (!list.length || !track) {
    preview.value = null;
    canvas = null;
    return;
  }
  const cover = await coverUrl(track);
  const drawn = await drawLyricsCard({ lines: list, title: track.title, artist: track.artist, coverUrl: cover, palette: cover ? await paletteFromImage(cover) : null });
  if (mine !== token) return;
  canvas = drawn;
  preview.value = drawn.toDataURL("image/jpeg", 0.8);
});

async function share() {
  if (!canvas || !player.currentTrack) return;
  busy.value = true;
  try {
    const problem = await shareCanvas(canvas, `Paroles ${player.currentTrack.title}`);
    if (problem) ui.notify(problem);
    else ui.lyricsShare = false;
  } catch (e) {
    ui.notify(`Partage impossible : ${e}`);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Transition name="dialog">
    <div v-if="ui.lyricsShare" class="scrim" @click.self="ui.lyricsShare = false">
      <section class="card" role="dialog" aria-modal="true" aria-labelledby="lyrics-share-title">
        <header>
          <h2 id="lyrics-share-title">Partager un extrait</h2>
          <button type="button" class="icon-btn" aria-label="Fermer" @click="ui.lyricsShare = false"><Icon name="close" :size="18" /></button>
        </header>
        <img v-if="preview" class="preview" :src="preview" alt="Aperçu de la carte" />
        <p v-else class="hint">Touchez les lignes à mettre sur la carte ({{ MAX_LINES }} au plus).</p>
        <div class="lines" role="group" aria-label="Lignes des paroles">
          <button v-for="(line, i) in lines" :key="i" type="button" class="line" :class="{ on: picked.includes(i) }" :aria-pressed="picked.includes(i)" @click="toggle(i)">{{ line }}</button>
        </div>
        <footer>
          <button type="button" class="pill pill-accent" :disabled="!preview || busy" @click="share"><Icon name="share" :size="15" /> {{ busy ? "Préparation…" : "Partager la carte" }}</button>
        </footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: grid;
  place-items: center;
  padding: calc(var(--safe-top) + 16px) calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 16px) calc(var(--safe-left) + 16px);
  background: rgba(2, 6, 20, 0.6);
}
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(100%, 460px);
  height: 100%;
  max-height: 760px;
  min-height: 0;
  padding: 18px 20px 16px;
  border-radius: 18px;
  background: rgba(var(--surface-rgb), 0.98);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.12);
  color: var(--text);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 18px;
}
.hint {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
}
.preview {
  flex: none;
  align-self: center;
  height: 34%;
  max-height: 260px;
  border-radius: 10px;
}
.lines {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.line {
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text);
  font-size: 15px;
  line-height: 1.3;
  text-align: left;
  overflow-wrap: anywhere;
}
.line:hover {
  background: rgba(var(--fg-rgb), 0.06);
}
.line.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}
footer {
  display: flex;
  justify-content: flex-end;
}
</style>
