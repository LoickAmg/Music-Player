<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { DEFAULT_THEME, PLAYLIST_THEMES, themeFor } from "@/lib/playlistThemes";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import PlaylistCover from "./PlaylistCover.vue";

// Création d'une playlist (nom + thème de jaquette) ou personnalisation d'une existante.
const ui = useUiStore();
const playlists = usePlaylistsStore();
const library = useLibraryStore();

const name = ref("");
const theme = ref(DEFAULT_THEME);
const customColor = ref("#7b5cff");
const nameInput = ref<HTMLInputElement | null>(null);

const dialog = computed(() => ui.playlistDialog);
const editing = computed(() => (dialog.value?.mode === "edit" ? playlists.byId(dialog.value.id) : null));
const preview = computed(() => name.value.trim() || "Ma playlist");
const isCustom = computed(() => theme.value.startsWith("custom:"));

watch(
  dialog,
  async (d) => {
    if (!d) return;
    if (d.mode === "edit") {
      const p = playlists.byId(d.id);
      name.value = p?.name ?? "";
      theme.value = p?.theme ?? DEFAULT_THEME;
    } else {
      name.value = "";
      // Un thème différent à chaque création, pour varier la bibliothèque.
      theme.value = PLAYLIST_THEMES[playlists.items.length % PLAYLIST_THEMES.length].id;
    }
    if (theme.value.startsWith("custom:")) customColor.value = theme.value.slice(7);
    await nextTick();
    nameInput.value?.focus();
    nameInput.value?.select();
  },
  { immediate: true },
);

function pickCustom(e: Event) {
  customColor.value = (e.target as HTMLInputElement).value;
  theme.value = `custom:${customColor.value}`;
}

function close() {
  ui.playlistDialog = null;
}

async function save() {
  const d = dialog.value;
  if (!d) return;
  const finalName = name.value.trim() || `Nouvelle playlist ${playlists.items.length + 1}`;
  if (d.mode === "edit") {
    const p = playlists.byId(d.id);
    if (p && p.name !== finalName) await playlists.rename(d.id, finalName);
    if (p && p.theme !== theme.value) await playlists.setTheme(d.id, theme.value);
    close();
    return;
  }
  const id = await playlists.create(finalName, theme.value);
  if (!id) return;
  if (d.addTrackId) {
    await playlists.addTrack(id, d.addTrackId);
    const track = library.byId(d.addTrackId);
    ui.notify(track ? `« ${track.title} » ajouté à « ${finalName} »` : `Playlist « ${finalName} » créée`);
  } else {
    ui.go({ name: "playlist", id });
  }
  close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div v-if="dialog" class="scrim" @mousedown.self="close">
    <form class="dialog" role="dialog" aria-modal="true" :aria-label="editing ? 'Personnaliser la playlist' : 'Nouvelle playlist'" @submit.prevent="save">
      <div class="preview">
        <PlaylistCover :name="preview" :theme="theme" :radius="12" />
      </div>
      <div class="form">
        <h2>{{ editing ? "Personnaliser la playlist" : "Nouvelle playlist" }}</h2>
        <label class="field">
          <span>Nom</span>
          <input ref="nameInput" v-model="name" maxlength="80" placeholder="Ma playlist" />
        </label>

        <p class="label">Jaquette</p>
        <div class="swatches" role="radiogroup" aria-label="Thème de la jaquette">
          <button
            v-for="t in PLAYLIST_THEMES"
            :key="t.id"
            type="button"
            role="radio"
            class="swatch"
            :class="{ on: theme === t.id }"
            :aria-checked="theme === t.id"
            :title="t.label"
            :style="{ background: t.background }"
            @click="theme = t.id"
          />
          <label class="swatch custom" :class="{ on: isCustom }" title="Couleur personnalisée" :style="isCustom ? { background: themeFor(theme).background } : undefined">
            <input type="color" :value="customColor" aria-label="Couleur personnalisée" @input="pickCustom" />
            <span v-if="!isCustom">＋</span>
          </label>
        </div>
        <p class="theme-name">{{ themeFor(theme).label }}</p>

        <div class="actions">
          <button type="button" class="pill pill-ghost" @click="close">Annuler</button>
          <button type="submit" class="pill pill-accent">{{ editing ? "Enregistrer" : "Créer" }}</button>
        </div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  animation: fade 0.18s ease;
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
.dialog {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 26px;
  width: min(640px, calc(100vw - 40px));
  padding: 24px;
  border-radius: 14px;
  background: rgba(9, 24, 60, 0.97);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(255, 255, 255, 0.12);
  animation: pop 0.25s var(--ease);
}
@keyframes pop {
  from {
    transform: scale(0.96);
    opacity: 0;
  }
}
.preview {
  align-self: start;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
  border-radius: 12px;
}
h2 {
  margin: 0 0 16px;
  font-family: var(--font-display);
  font-size: 19px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field span,
.label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
}
.field input {
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.08);
  outline: none;
  font-size: 14px;
}
.field input:focus {
  box-shadow: 0 0 0 2px var(--accent);
}
.label {
  margin: 18px 0 8px;
}
.swatches {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 8px;
}
.swatch {
  position: relative;
  aspect-ratio: 1;
  border: 0;
  border-radius: 8px;
  box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.2);
  transition: transform 0.15s var(--ease);
}
.swatch:hover {
  transform: scale(1.07);
}
.swatch.on {
  box-shadow: 0 0 0 2px rgba(9, 24, 60, 1), 0 0 0 4px #3fe0ff;
}
.custom {
  display: grid;
  place-items: center;
  background: conic-gradient(from 0deg, #ff5a5a, #ffd23f, #4be38a, #3fb6ff, #9b6bff, #ff5ab4, #ff5a5a);
  color: #fff;
  font-weight: 700;
  cursor: pointer;
}
.custom input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.custom span {
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}
.theme-name {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-2);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 22px;
}
</style>
