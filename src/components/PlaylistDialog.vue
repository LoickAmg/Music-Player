<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "@/lib/api";
import { DEFAULT_THEME, PLAYLIST_THEMES, themeFor } from "@/lib/playlistThemes";
import type { PlaylistStyle } from "@/lib/types";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import FontPicker from "./FontPicker.vue";
import PlaylistCover from "./PlaylistCover.vue";

// Création d'une playlist ou personnalisation d'une existante : nom, jaquette (dégradé et
// motif, ou image à soi recadrée) et typographie du nom (police, couleur, taille, position),
// reprise au besoin par le titre de la page de la playlist.
const ui = useUiStore();
const playlists = usePlaylistsStore();
const library = useLibraryStore();

type Tab = "colors" | "image" | "text";
const tab = ref<Tab>("colors");
const name = ref("");
const theme = ref(DEFAULT_THEME);
const customColor = ref("#7b5cff");
const style = ref<PlaylistStyle>({});
/** Image choisie mais pas encore enregistrée. */
const pending = ref<{ blob: Blob; url: string; ext: string } | null>(null);
const saving = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);

const dialog = computed(() => ui.playlistDialog);
const editing = computed(() => (dialog.value?.mode === "edit" ? playlists.byId(dialog.value.id) : null));
const preview = computed(() => name.value.trim() || "Ma playlist");
const isCustom = computed(() => theme.value.startsWith("custom:"));
const hasImage = computed(() => !!pending.value || !!style.value.image);

const PATTERNS: { id: NonNullable<PlaylistStyle["pattern"]>; label: string }[] = [
  { id: "rings", label: "Halos" },
  { id: "none", label: "Uni" },
  { id: "dots", label: "Points" },
  { id: "stripes", label: "Rayures" },
  { id: "grid", label: "Grille" },
  { id: "waves", label: "Vagues" },
  { id: "stars", label: "Étoiles" },
];

function dropPending() {
  if (pending.value) URL.revokeObjectURL(pending.value.url);
  pending.value = null;
}

watch(
  dialog,
  async (d) => {
    dropPending();
    if (!d) return;
    tab.value = "colors";
    if (d.mode === "edit") {
      const p = playlists.byId(d.id);
      name.value = p?.name ?? "";
      theme.value = p?.theme ?? DEFAULT_THEME;
      style.value = { ...(p?.style ?? {}) };
    } else {
      name.value = "";
      // Un thème différent à chaque création, pour varier la bibliothèque.
      theme.value = PLAYLIST_THEMES[playlists.items.length % PLAYLIST_THEMES.length].id;
      style.value = {};
    }
    if (theme.value.startsWith("custom:")) customColor.value = theme.value.slice(7);
    await nextTick();
    if (!ui.isTouch) {
      nameInput.value?.focus();
      nameInput.value?.select();
    }
  },
  { immediate: true },
);

function pickCustom(e: Event) {
  customColor.value = (e.target as HTMLInputElement).value;
  theme.value = `custom:${customColor.value}`;
}

function set<K extends keyof PlaylistStyle>(key: K, value: PlaylistStyle[K]) {
  style.value = { ...style.value, [key]: value };
}

/** Image réduite à 1200 px de côté au plus (une jaquette n'en demande pas plus) : le
 *  fichier enregistré reste léger, même à partir d'une photo de 12 Mpx. */
async function shrink(file: File): Promise<{ blob: Blob; ext: string }> {
  const max = 1200;
  try {
    const bitmap = await createImageBitmap(file);
    const ratio = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * ratio);
    canvas.height = Math.round(bitmap.height * ratio);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
    if (blob) return { blob, ext: "jpg" };
  } catch {
    // format que le navigateur ne sait pas redimensionner : envoyé tel quel
  }
  return { blob: file, ext: (file.name.split(".").pop() ?? "jpg").toLowerCase() };
}

async function onImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    ui.notify("Choisissez une image (JPG, PNG, WebP…).");
    return;
  }
  const { blob, ext } = await shrink(file);
  dropPending();
  pending.value = { blob, ext, url: URL.createObjectURL(blob) };
  style.value = { ...style.value, imageX: 50, imageY: 50, imageZoom: 1, dim: style.value.dim ?? 0.35 };
}

function removeImage() {
  dropPending();
  set("image", null);
}

// Recadrage au doigt ou à la souris : glisser l'image dans l'aperçu.
let drag: { x: number; y: number; ix: number; iy: number; size: number } | null = null;
function startDrag(e: PointerEvent) {
  if (!hasImage.value || tab.value !== "image") return;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, ix: style.value.imageX ?? 50, iy: style.value.imageY ?? 50, size: el.clientWidth };
}
function moveDrag(e: PointerEvent) {
  if (!drag) return;
  const zoom = style.value.imageZoom ?? 1;
  const k = 100 / (drag.size * Math.max(1, zoom));
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  style.value = {
    ...style.value,
    imageX: clamp(drag.ix - (e.clientX - drag.x) * k),
    imageY: clamp(drag.iy - (e.clientY - drag.y) * k),
  };
}
function endDrag() {
  drag = null;
}

function close() {
  dropPending();
  ui.playlistDialog = null;
}

/** Style à enregistrer : sans les réglages restés par défaut (`null` s'il n'en reste rien). */
function cleanStyle(s: PlaylistStyle): PlaylistStyle | null {
  const out: PlaylistStyle = {};
  for (const [k, v] of Object.entries(s) as [keyof PlaylistStyle, unknown][]) {
    if (v === null || v === undefined || v === "") continue;
    (out as Record<string, unknown>)[k] = v;
  }
  if (!out.image) {
    delete out.imageX;
    delete out.imageY;
    delete out.imageZoom;
    delete out.dim;
  }
  return Object.keys(out).length ? out : null;
}

async function save() {
  const d = dialog.value;
  if (!d || saving.value) return;
  saving.value = true;
  try {
    const finalName = name.value.trim() || `Nouvelle playlist ${playlists.items.length + 1}`;
    const before = d.mode === "edit" ? playlists.byId(d.id)?.style?.image ?? null : null;
    const next = { ...style.value };
    if (pending.value) {
      next.image = await api.importAsset("image", pending.value.ext, new Uint8Array(await pending.value.blob.arrayBuffer()));
    }
    const finalStyle = cleanStyle(next);
    // Ancienne image remplacée ou retirée : le fichier n'a plus de raison d'être.
    if (before && before !== finalStyle?.image) void api.deleteAsset(before).catch(() => {});

    if (d.mode === "edit") {
      const p = playlists.byId(d.id);
      if (p && p.name !== finalName) await playlists.rename(d.id, finalName);
      if (p && p.theme !== theme.value) await playlists.setTheme(d.id, theme.value);
      if (JSON.stringify(p?.style ?? null) !== JSON.stringify(finalStyle)) await playlists.setStyle(d.id, finalStyle);
      close();
      return;
    }
    const id = await playlists.create(finalName, theme.value);
    if (!id) return;
    if (finalStyle) await playlists.setStyle(id, finalStyle);
    if (d.addTrackId) {
      await playlists.addTrack(id, d.addTrackId);
      const track = library.byId(d.addTrackId);
      ui.notify(track ? `« ${track.title} » ajouté à « ${finalName} »` : `Playlist « ${finalName} » créée`);
      close();
    } else {
      // Playlist toute neuve : on l'ouvre et on propose tout de suite d'y mettre des morceaux.
      close();
      ui.go({ name: "playlist", id });
      ui.trackPicker = id;
    }
  } catch (e) {
    ui.notify(`Enregistrement impossible : ${e}`);
  } finally {
    saving.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && dialog.value) close();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  dropPending();
});
</script>

<template>
  <div v-if="dialog" class="scrim" @mousedown.self="close">
    <form class="dialog" role="dialog" aria-modal="true" :aria-label="editing ? 'Personnaliser la playlist' : 'Nouvelle playlist'" @submit.prevent="save">
      <div class="preview-col">
        <div
          class="preview"
          :class="{ draggable: hasImage && tab === 'image' }"
          @pointerdown="startDrag"
          @pointermove="moveDrag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        >
          <PlaylistCover :name="preview" :theme="theme" :styling="{ ...style, image: pending ? null : style.image }" :image-url="pending?.url ?? null" :radius="12" />
        </div>
        <p v-if="hasImage && tab === 'image'" class="hint">Glissez l'image pour la recadrer.</p>
      </div>

      <div class="form">
        <h2>{{ editing ? "Personnaliser la playlist" : "Nouvelle playlist" }}</h2>
        <label class="field">
          <span>Nom</span>
          <input ref="nameInput" v-model="name" maxlength="80" placeholder="Ma playlist" />
        </label>

        <div class="tabs" role="tablist">
          <button type="button" role="tab" :class="{ on: tab === 'colors' }" :aria-selected="tab === 'colors'" @click="tab = 'colors'">Couleurs</button>
          <button type="button" role="tab" :class="{ on: tab === 'image' }" :aria-selected="tab === 'image'" @click="tab = 'image'">Image</button>
          <button type="button" role="tab" :class="{ on: tab === 'text' }" :aria-selected="tab === 'text'" @click="tab = 'text'">Texte</button>
        </div>

        <div v-if="tab === 'colors'" class="panel">
          <p v-if="hasImage" class="note">Une image est choisie : les couleurs servent de secours et pour la vignette.</p>
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
          <p class="label">Motif</p>
          <div class="chips">
            <button v-for="p in PATTERNS" :key="p.id" type="button" class="chip" :class="{ on: (style.pattern ?? 'rings') === p.id }" @click="set('pattern', p.id)">{{ p.label }}</button>
          </div>
        </div>

        <div v-else-if="tab === 'image'" class="panel">
          <div class="row">
            <button type="button" class="pill pill-accent" @click="imageInput?.click()">{{ hasImage ? "Changer d'image" : "Choisir une image" }}</button>
            <button v-if="hasImage" type="button" class="pill pill-ghost" @click="removeImage">Retirer</button>
            <input ref="imageInput" type="file" accept="image/*" hidden @change="onImage" />
          </div>
          <template v-if="hasImage">
            <label class="slider">
              <span>Zoom <em>{{ Math.round((style.imageZoom ?? 1) * 100) }} %</em></span>
              <input type="range" min="100" max="300" :value="Math.round((style.imageZoom ?? 1) * 100)" @input="set('imageZoom', +($event.target as HTMLInputElement).value / 100)" />
            </label>
            <label class="slider">
              <span>Cadrage horizontal</span>
              <input type="range" min="0" max="100" :value="style.imageX ?? 50" @input="set('imageX', +($event.target as HTMLInputElement).value)" />
            </label>
            <label class="slider">
              <span>Cadrage vertical</span>
              <input type="range" min="0" max="100" :value="style.imageY ?? 50" @input="set('imageY', +($event.target as HTMLInputElement).value)" />
            </label>
            <label class="slider">
              <span>Voile sous le nom <em>{{ Math.round((style.dim ?? 0.35) * 100) }} %</em></span>
              <input type="range" min="0" max="70" :value="Math.round((style.dim ?? 0.35) * 100)" @input="set('dim', +($event.target as HTMLInputElement).value / 100)" />
            </label>
          </template>
          <p v-else class="note">Une photo, un dessin, une capture… Elle est copiée dans l'application (réduite à 1200 px) : vous pouvez supprimer l'original.</p>
        </div>

        <div v-else class="panel">
          <label class="toggle">
            <input type="checkbox" :checked="style.showName !== false" @change="set('showName', ($event.target as HTMLInputElement).checked ? undefined : false)" />
            <span>Afficher le nom sur la jaquette</span>
          </label>
          <template v-if="style.showName !== false">
            <div class="row wrap">
              <div class="seg" role="group" aria-label="Alignement">
                <button type="button" :class="{ on: (style.align ?? 'start') === 'start' }" @click="set('align', 'start')">Gauche</button>
                <button type="button" :class="{ on: style.align === 'center' }" @click="set('align', 'center')">Centre</button>
                <button type="button" :class="{ on: style.align === 'end' }" @click="set('align', 'end')">Droite</button>
              </div>
              <div class="seg" role="group" aria-label="Position">
                <button type="button" :class="{ on: style.place === 'top' }" @click="set('place', 'top')">Haut</button>
                <button type="button" :class="{ on: style.place === 'middle' }" @click="set('place', 'middle')">Milieu</button>
                <button type="button" :class="{ on: (style.place ?? 'bottom') === 'bottom' }" @click="set('place', 'bottom')">Bas</button>
              </div>
            </div>
            <div class="row wrap">
              <label class="ink">
                <input type="color" :value="style.ink ?? '#ffffff'" aria-label="Couleur du nom" @input="set('ink', ($event.target as HTMLInputElement).value)" />
                <span>Couleur</span>
              </label>
              <button v-if="style.ink" type="button" class="link" @click="set('ink', null)">Couleur automatique</button>
              <label class="toggle inline">
                <input type="checkbox" :checked="!!style.uppercase" @change="set('uppercase', ($event.target as HTMLInputElement).checked || undefined)" />
                <span>MAJUSCULES</span>
              </label>
            </div>
            <label class="slider">
              <span>Taille du nom <em>{{ Math.round((style.size ?? 1) * 100) }} %</em></span>
              <input type="range" min="60" max="160" step="5" :value="Math.round((style.size ?? 1) * 100)" @input="set('size', +($event.target as HTMLInputElement).value / 100)" />
            </label>
          </template>
          <label class="toggle">
            <input type="checkbox" :checked="style.titleFont === 'cover'" @change="set('titleFont', ($event.target as HTMLInputElement).checked ? 'cover' : null)" />
            <span>Même police pour le titre de la page de la playlist</span>
          </label>
          <p class="label">Police du nom</p>
          <FontPicker :model-value="style.font ?? 'system'" system-label="Police des titres de l'appli" :sample="preview" @update:model-value="(id) => set('font', id === 'system' ? null : id)" />
        </div>

        <div class="actions">
          <button type="button" class="pill pill-ghost" @click="close">Annuler</button>
          <button type="submit" class="pill pill-accent" :disabled="saving">{{ saving ? "Enregistrement…" : editing ? "Enregistrer" : "Créer" }}</button>
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
  grid-template-columns: 240px 1fr;
  gap: 26px;
  width: min(760px, calc(100vw - 40px));
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  padding: 24px;
  border-radius: 14px;
  background: rgba(var(--surface-rgb), 0.97);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.12);
  animation: pop 0.25s var(--ease);
}
@keyframes pop {
  from {
    transform: scale(0.96);
    opacity: 0;
  }
}
.preview-col {
  align-self: start;
  position: sticky;
  top: 0;
}
.preview {
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
  border-radius: 12px;
  touch-action: none;
}
.preview.draggable {
  cursor: grab;
}
.preview.draggable:active {
  cursor: grabbing;
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  text-align: center;
  color: var(--text-3);
}
.form {
  min-width: 0;
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
.label,
.slider span {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
}
.field input {
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: rgba(var(--fg-rgb), 0.08);
  outline: none;
  font-size: 14px;
  color: var(--text);
}
.field input:focus {
  box-shadow: 0 0 0 2px var(--accent);
}
.tabs {
  display: flex;
  gap: 4px;
  margin: 16px 0 12px;
  padding: 3px;
  border-radius: 9px;
  background: rgba(var(--fg-rgb), 0.06);
}
.tabs button {
  flex: 1;
  height: 32px;
  border: 0;
  border-radius: 7px;
  background: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.tabs button.on {
  background: var(--accent);
  color: var(--on-accent);
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-3);
}
.label {
  margin: 6px 0 0;
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
  box-shadow: inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.2);
  transition: transform 0.15s var(--ease);
}
.swatch:hover {
  transform: scale(1.07);
}
.swatch.on {
  box-shadow: 0 0 0 2px rgba(var(--surface-rgb), 1), 0 0 0 4px var(--accent);
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
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 15px;
  background: rgba(var(--fg-rgb), 0.07);
  font-size: 12.5px;
}
.chip.on {
  background: var(--accent);
  color: var(--on-accent);
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row.wrap {
  flex-wrap: wrap;
  gap: 10px 14px;
}
.slider {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.slider em {
  font-style: normal;
  margin-left: 6px;
}
.slider input {
  accent-color: var(--accent);
}
.seg {
  display: flex;
  padding: 3px;
  border-radius: 8px;
  background: rgba(var(--fg-rgb), 0.06);
}
.seg button {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: none;
  font-size: 12.5px;
  color: var(--text-2);
}
.seg button.on {
  background: rgba(var(--fg-rgb), 0.14);
  color: var(--text);
}
.ink {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
}
.ink input {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
}
.ink input::-webkit-color-swatch-wrapper {
  padding: 0;
}
.ink input::-webkit-color-swatch {
  border: 2px solid rgba(var(--fg-rgb), 0.25);
  border-radius: 50%;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.toggle input {
  width: 17px;
  height: 17px;
  accent-color: var(--accent);
}
.link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  font-size: 12.5px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 22px;
}
.pill:disabled {
  opacity: 0.6;
}
/* Téléphone : une seule colonne, aperçu en haut ; grands boutons ; défilement si le
   clavier réduit l'écran ; jamais sous les barres du système. */
@media (max-width: 640px) {
  .scrim {
    padding: calc(var(--safe-top) + 12px) calc(var(--safe-right) + 10px) calc(var(--safe-bottom) + 12px)
      calc(var(--safe-left) + 10px);
  }
  .dialog {
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
    width: 100%;
    max-width: 460px;
    max-height: 100%;
    padding: 18px 16px 16px;
    border-radius: 20px;
  }
  .preview-col {
    position: static;
    justify-self: center;
    width: 150px;
  }
  h2 {
    text-align: center;
  }
  .field input {
    height: 46px;
    font-size: 16px;
  }
  .swatches {
    grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
    gap: 10px;
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .actions .pill {
    justify-content: center;
    min-height: 48px;
    font-size: 15px;
  }
}
</style>
