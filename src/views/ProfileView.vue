<script setup lang="ts">
import { computed, ref } from "vue";
import { type Crop, renderCrop } from "@/lib/imageCrop";
import { applyIconSize, ICON_SIZE_KEY, ICON_SIZES, type IconSize } from "@/lib/profileIcon";
import { remembered } from "@/lib/remember";
import { useAppearanceStore } from "@/stores/appearance";
import { useFavoritesStore } from "@/stores/favorites";
import { useFriendsStore } from "@/stores/friends";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import CropDialog from "@/components/CropDialog.vue";
import Icon from "@/components/Icon.vue";

// Mon profil : photo, nom, code d'ami et raccourcis, au même endroit (ouvert par l'icône du profil).
const appearance = useAppearanceStore();
const friends = useFriendsStore();
const library = useLibraryStore();
const playlists = usePlaylistsStore();
const favorites = useFavoritesStore();
const ui = useUiStore();

const profile = computed(() => appearance.settings.profile);
const cropUrl = ref<string | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);

function onImageFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    ui.notify("Choisissez une image (JPG, PNG, WebP…).");
    return;
  }
  cropUrl.value = URL.createObjectURL(file);
}
function closeCrop() {
  if (cropUrl.value) URL.revokeObjectURL(cropUrl.value);
  cropUrl.value = null;
}
async function confirmCrop(crop: Crop) {
  if (!cropUrl.value) return;
  busy.value = true;
  try {
    await appearance.setAvatar(await renderCrop(cropUrl.value, crop, { size: 512 }));
    ui.notify("Photo de profil enregistrée");
  } catch (e) {
    ui.notify(`Impossible : ${e}`);
  } finally {
    busy.value = false;
    closeCrop();
  }
}
function setName(event: Event) {
  appearance.settings.profile = { ...profile.value, name: (event.target as HTMLInputElement).value.trim().slice(0, 40) };
  appearance.changed();
}

const iconSize = remembered<IconSize>(ICON_SIZE_KEY, "normale", ["petite", "normale", "grande"]);
function setSize(id: IconSize) {
  iconSize.value = id;
  applyIconSize(id);
}

async function copyCode() {
  if (!friends.me) return;
  try {
    await navigator.clipboard.writeText(friends.me.code);
    ui.notify("Code copié");
  } catch {
    ui.notify(friends.me.code);
  }
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Mon profil</h1>

    <section class="section-card head">
      <button type="button" class="avatar" :aria-label="profile.avatar ? 'Changer la photo de profil' : 'Choisir une photo de profil'" @click="imageInput?.click()">
        <img v-if="profile.avatar" :src="appearance.assetUrl(profile.avatar)" alt="" />
        <Icon v-else name="user" :size="48" />
        <span class="avatar-edit"><Icon name="image" :size="15" /></span>
      </button>
      <div class="fields">
        <label class="field">
          <span>Nom</span>
          <input class="fieldbox" :value="profile.name" maxlength="40" placeholder="Prénom ou pseudo" @change="setName" />
        </label>
        <button v-if="profile.avatar" type="button" class="link" @click="appearance.setAvatar(null)">Retirer la photo</button>
        <div v-if="friends.me" class="code-row">
          <span class="muted">Code d'ami</span>
          <strong class="code">{{ friends.me.code }}</strong>
          <button type="button" class="link" @click="copyCode">Copier</button>
        </div>
      </div>
    </section>

    <section class="section-card">
      <h2>Icône du profil</h2>
      <div class="sizes" role="radiogroup" aria-label="Taille de l'icône du profil">
        <button v-for="s in ICON_SIZES" :key="s.id" type="button" role="radio" :aria-checked="iconSize === s.id" :class="{ on: iconSize === s.id }" @click="setSize(s.id)">{{ s.label }}</button>
      </div>
    </section>

    <section class="section-card stats">
      <button type="button" @click="ui.go({ name: 'songs' })"><strong>{{ library.tracks.length }}</strong> morceaux</button>
      <button type="button" @click="ui.go({ name: 'playlists' })"><strong>{{ playlists.items.length }}</strong> playlists</button>
      <button type="button" @click="ui.go({ name: 'favorites' })"><strong>{{ favorites.count }}</strong> titres aimés</button>
      <button type="button" @click="ui.go({ name: 'friends' })"><strong>{{ friends.friends.length }}</strong> proches</button>
    </section>

    <nav class="section-card links" aria-label="Raccourcis du profil">
      <button type="button" @click="ui.go({ name: 'stats' })"><Icon name="stats" :size="18" /> Mon écoute</button>
      <button type="button" @click="ui.go({ name: 'appearance' })"><Icon name="brush" :size="18" /> Personnalisation</button>
      <button type="button" @click="ui.go({ name: 'settings' })"><Icon name="settings" :size="18" /> Réglages</button>
    </nav>

    <input ref="imageInput" type="file" accept="image/*" hidden @change="onImageFile" />
    <CropDialog :src="cropUrl" title="Photo de profil" shape="circle" :confirm-label="busy ? 'Enregistrement…' : 'Valider'" @confirm="confirmCrop" @cancel="closeCrop" />
  </div>
</template>

<style scoped>
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 20px;
}
.avatar {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 112px;
  height: 112px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
}
.avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}
.avatar-edit {
  position: absolute;
  right: 2px;
  bottom: 2px;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
}
.fields {
  flex: 1;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  font-size: 13px;
  font-weight: 600;
}
.field input {
  height: 38px;
  padding: 0 11px;
  border: 0;
  border-radius: var(--radius-sm);
  background: rgba(var(--fg-rgb), 0.07);
  font-size: 15px;
  font-weight: 400;
}
.code-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}
.code {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.link {
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
}
.sizes {
  display: flex;
  gap: var(--space-2);
}
.sizes button {
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--radius-pill);
  background: rgba(var(--fg-rgb), 0.08);
  color: var(--text-2);
}
.sizes button.on {
  background: var(--accent);
  color: var(--on-accent);
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
}
.stats button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 4px;
  border: 0;
  border-radius: 10px;
  background: none;
  color: var(--text-2);
  font-size: 12.5px;
}
.stats button:hover {
  background: rgba(var(--fg-rgb), 0.06);
}
.stats strong {
  color: var(--text);
  font-size: 22px;
}
.links {
  display: flex;
  flex-direction: column;
  padding: 8px;
}
.links button {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 0;
  border-radius: 10px;
  background: none;
  color: var(--text);
  font-size: 15px;
  text-align: left;
}
.links button:hover {
  background: rgba(var(--fg-rgb), 0.06);
}
.links svg {
  color: var(--accent);
}
</style>
