<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { api } from "@/lib/api";
import { coverUrl } from "@/lib/covers";
import { CARD_FORMATS, CARD_STYLES, type CardFormat, type CardStyle, drawLyricsCard, luminance, MAX_LINES } from "@/lib/lyricsCard";
import { css, type Palette, paletteFromImage } from "@/lib/palette";
import { canvasToPng } from "@/lib/recapCard";
import { remembered } from "@/lib/remember";
import { shareCanvas } from "@/lib/shareCard";
import { activeLineIndex, useLyricsStore } from "@/stores/lyrics";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// « Partager un extrait », en deux temps. 1. Choisir : les paroles sur un fond aux couleurs de
// la pochette ; une ligne touchée devient une bulle (glisser le doigt en prend plusieurs d'un
// coup), la ligne en cours de lecture est proposée d'emblée. 2. La carte : style, format, puis
// partager, enregistrer ou copier le texte.
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
const step = ref<"choisir" | "carte">("choisir");
const style = remembered<CardStyle>("mp:carte-paroles-style", "bulles", ["halo", "bulles", "pochette", "papier"]);
const format = remembered<CardFormat>("mp:carte-paroles-format", "portrait", ["carre", "portrait", "story"]);
const palette = ref<Palette | null>(null);
const cover = ref<string | null>(null);
const preview = ref<string | null>(null);
const busy = ref(false);
const list = ref<HTMLElement | null>(null);
let canvas: HTMLCanvasElement | null = null;
let token = 0;

/** Fond de l'écran de choix : la couleur vive de la pochette (texte sombre ou clair selon elle). */
const theme = computed(() => {
  const c = palette.value?.glow ?? [70, 140, 160];
  const light = luminance(c) > 0.55;
  return { background: css(c), "--ink": light ? "#0b0b10" : "#ffffff", "--pill": light ? "#0b0b10" : "rgba(0,0,0,0.62)", "--pill-ink": light ? css(c) : "#ffffff" };
});

watch(
  () => ui.lyricsShare,
  async (open) => {
    picked.value = [];
    preview.value = null;
    canvas = null;
    step.value = "choisir";
    if (!open) return;
    const track = player.currentTrack;
    cover.value = track ? await coverUrl(track) : null;
    palette.value = cover.value ? await paletteFromImage(cover.value) : null;
    // La ligne en cours de lecture est proposée, et mise en vue.
    const synced = lyrics.lyrics?.synced;
    if (synced?.length) {
      const at = activeLineIndex(synced, player.positionSecs * 1000);
      const text = synced[at]?.text.trim();
      const index = text ? lines.value.indexOf(text) : -1;
      if (index >= 0) {
        picked.value = [index];
        await nextTick();
        list.value?.querySelectorAll<HTMLElement>(".line")[index]?.scrollIntoView({ block: "center" });
      }
    }
  },
);

function buzz() {
  try {
    navigator.vibrate?.(8);
  } catch {
    // pas de vibreur
  }
}
function toggle(i: number) {
  if (picked.value.includes(i)) picked.value = picked.value.filter((x) => x !== i);
  else if (picked.value.length < MAX_LINES) picked.value = [...picked.value, i];
  else return ui.notify(`${MAX_LINES} lignes au plus sur une carte`);
  buzz();
}

// Glisser sur les lignes : toutes celles survolées prennent l'état de la première touchée.
let dragging: { adding: boolean; last: number } | null = null;
function lineAt(e: PointerEvent): number {
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-line]");
  return el ? Number(el.dataset.line) : -1;
}
function onDown(e: PointerEvent, i: number) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  dragging = { adding: !picked.value.includes(i), last: i };
  toggle(i);
}
function onMove(e: PointerEvent) {
  if (!dragging) return;
  const i = lineAt(e);
  if (i < 0 || i === dragging.last) return;
  dragging.last = i;
  const has = picked.value.includes(i);
  if (dragging.adding && !has) toggle(i);
  else if (!dragging.adding && has) toggle(i);
}
function onUp() {
  dragging = null;
}

watch([chosen, style, format, step], async () => {
  const mine = ++token;
  const track = player.currentTrack;
  if (step.value !== "carte" || !chosen.value.length || !track) return;
  const drawn = await drawLyricsCard({ lines: chosen.value, title: track.title, artist: track.artist, coverUrl: cover.value, palette: palette.value, style: style.value, format: format.value });
  if (mine !== token) return;
  canvas = drawn;
  preview.value = drawn.toDataURL("image/jpeg", 0.85);
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
async function save() {
  if (!canvas || !player.currentTrack) return;
  busy.value = true;
  try {
    await api.saveImage(await canvasToPng(canvas), `Paroles ${player.currentTrack.title}`);
    ui.notify("Carte enregistrée dans Images › Music Player.");
  } catch (e) {
    ui.notify(`Enregistrement impossible : ${e}`);
  } finally {
    busy.value = false;
  }
}
async function copyText() {
  const track = player.currentTrack;
  const text = `${chosen.value.join("\n")}\n— ${track?.artist ?? ""}, « ${track?.title ?? ""} »`;
  try {
    await navigator.clipboard.writeText(text);
    ui.notify("Paroles copiées.");
  } catch {
    ui.notify("Copie impossible sur cet appareil.");
  }
}
</script>

<template>
  <Transition name="sheet">
    <div v-if="ui.lyricsShare" class="sheet" :style="step === 'choisir' ? theme : undefined" :class="step" role="dialog" aria-modal="true" aria-labelledby="lyrics-share-title">
      <header>
        <button v-if="step === 'carte'" type="button" class="round" aria-label="Revenir aux paroles" @click="step = 'choisir'"><Icon name="back" :size="20" /></button>
        <button v-else type="button" class="round" aria-label="Fermer" @click="ui.lyricsShare = false"><Icon name="expand" :size="20" /></button>
        <div class="title">
          <strong id="lyrics-share-title">{{ step === "choisir" ? "Choisir les paroles" : "Votre carte" }}</strong>
          <small>{{ picked.length ? `${picked.length} ligne${picked.length > 1 ? "s" : ""} choisie${picked.length > 1 ? "s" : ""}` : `Touchez ou glissez sur les lignes (${MAX_LINES} au plus)` }}</small>
        </div>
        <button v-if="step === 'choisir'" type="button" class="next" :disabled="!picked.length" @click="step = 'carte'">Suivant</button>
        <span v-else class="spacer" />
      </header>

      <!-- 1. Choisir -->
      <div v-if="step === 'choisir'" ref="list" class="lines" role="group" aria-label="Lignes des paroles" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @pointerleave="onUp">
        <button
          v-for="(line, i) in lines"
          :key="i"
          type="button"
          class="line"
          :class="{ on: picked.includes(i) }"
          :data-line="i"
          :aria-pressed="picked.includes(i)"
          @pointerdown.prevent="onDown($event, i)"
          @keydown.enter.prevent="toggle(i)"
          @keydown.space.prevent="toggle(i)"
        >
          {{ line }}
        </button>
        <p v-if="!lines.length" class="none">Pas de paroles pour ce morceau.</p>
      </div>

      <!-- 2. La carte -->
      <div v-else class="studio">
        <div class="stage" :class="format">
          <img v-if="preview" :src="preview" alt="Aperçu de la carte" />
          <div v-else class="loading" aria-hidden="true" />
        </div>
        <div class="controls">
          <div class="choice" role="radiogroup" aria-label="Style de la carte">
            <button v-for="s in CARD_STYLES" :key="s.id" type="button" role="radio" :aria-checked="style === s.id" :class="{ on: style === s.id }" @click="style = s.id">{{ s.label }}</button>
          </div>
          <div class="choice" role="radiogroup" aria-label="Format de la carte">
            <button v-for="f in CARD_FORMATS" :key="f.id" type="button" role="radio" :aria-checked="format === f.id" :class="{ on: format === f.id }" @click="format = f.id">{{ f.label }}</button>
          </div>
          <div class="actions">
            <button type="button" class="pill pill-accent" :disabled="!preview || busy" @click="share"><Icon name="share" :size="15" /> Partager</button>
            <button type="button" class="pill pill-ghost" :disabled="!preview || busy" @click="save"><Icon name="image" :size="15" /> Enregistrer</button>
            <button type="button" class="pill pill-ghost" @click="copyText"><Icon name="lyrics" :size="15" /> Copier le texte</button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.sheet {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 85;
  display: flex;
  flex-direction: column;
  padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
  background: rgb(var(--surface-rgb));
  color: var(--ink, var(--text));
  transition: background 0.4s var(--ease);
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}
.round {
  display: grid;
  flex: none;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.12);
  color: inherit;
  cursor: pointer;
}
.title {
  display: grid;
  flex: 1;
  min-width: 0;
  text-align: center;
}
.title strong {
  font-size: 16px;
}
.title small {
  font-size: 12.5px;
  opacity: 0.75;
}
.next {
  flex: none;
  height: 38px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: var(--pill, var(--accent));
  color: var(--pill-ink, #fff);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.2s;
}
.next:disabled {
  opacity: 0.35;
  cursor: default;
}
.spacer {
  width: 42px;
}

.lines {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 16px 40px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  touch-action: pan-y;
  user-select: none;
}
.line {
  max-width: 100%;
  padding: 10px 16px;
  border: 0;
  border-radius: 20px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: clamp(20px, 5.2vw, 30px);
  font-weight: 800;
  line-height: 1.25;
  text-align: left;
  overflow-wrap: anywhere;
  opacity: 0.55;
  cursor: pointer;
  transition: opacity 0.2s, background 0.2s, color 0.2s, transform 0.18s var(--ease);
}
@media (hover: hover) {
  .line:hover {
    opacity: 0.85;
  }
}
.line.on {
  opacity: 1;
  background: var(--pill);
  color: var(--pill-ink);
  animation: pop 0.22s var(--ease);
}
@keyframes pop {
  50% {
    transform: scale(1.03);
  }
}
.none {
  margin: auto;
  opacity: 0.7;
}

.studio {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 16px;
  padding: 4px 16px 18px;
}
/* L'aperçu tient dans la place laissée par les réglages, quel que soit le format (story compris). */
.stage {
  position: relative;
  min-height: 0;
}
.stage img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 18px 40px rgba(0, 0, 0, 0.45));
}
.loading {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  border-radius: 16px;
}
.loading {
  width: min(70vw, 360px);
  aspect-ratio: 4 / 5;
  background: rgba(var(--fg-rgb), 0.08);
}
.controls {
  display: grid;
  gap: 12px;
  justify-items: center;
}
.choice {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}
.choice button {
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.08);
  color: var(--text-2);
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.choice button.on {
  background: var(--accent);
  color: var(--on-accent, #fff);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.sheet-enter-active,
.sheet-leave-active {
  transition: transform 0.3s var(--ease), opacity 0.25s;
}
.sheet-enter-from,
.sheet-leave-to {
  transform: translateY(24px);
  opacity: 0;
}
@media (min-width: 900px) {
  .lines {
    width: min(760px, 100%);
    margin: 0 auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .line.on {
    animation: none;
  }
}
</style>
