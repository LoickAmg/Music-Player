<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { api } from "@/lib/api";
import { shareFile } from "@/lib/androidMedia";
import { type Backup, buildBackup, parseBackup, planRestore, restorePrefs } from "@/lib/backup";
import { useAppearanceStore } from "@/stores/appearance";
import { useFavoritesStore } from "@/stores/favorites";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useShareStore } from "@/stores/share";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// Réglages → Sauvegarde : tout ce qui n'est pas la musique elle-même (playlists, titres
// aimés, écoute, apparence, réglages) dans un fichier, à restaurer sur cet appareil ou un autre.
const library = useLibraryStore();
const playlists = usePlaylistsStore();
const favorites = useFavoritesStore();
const appearance = useAppearanceStore();
const share = useShareStore();
const ui = useUiStore();
const onAndroid = /Android/i.test(navigator.userAgent);

const saving = ref(false);
const backup = ref<Backup | null>(null);
const readError = ref<string | null>(null);
const restoring = ref(false);
const parts = reactive({ playlists: true, favorites: true, listens: true, settings: true });
const done = ref<string | null>(null);

const plan = computed(() => (backup.value ? planRestore(backup.value, library.tracks) : null));
const found = computed(() => plan.value?.playlists.reduce((s, p) => s + p.found.length, 0) ?? 0);
const hasSettings = computed(() => !!backup.value && (!!backup.value.appearance || Object.keys(backup.value.prefs).length > 0));
const total = computed(() => plan.value?.playlists.reduce((s, p) => s + p.found.length + p.missing.length, 0) ?? 0);

async function save() {
  saving.value = true;
  try {
    const data = buildBackup({
      device: share.deviceName || (onAndroid ? "Téléphone" : "Ordinateur"),
      playlists: playlists.items,
      favoriteIds: [...favorites.ids],
      byId: (id) => library.byId(id),
      listens: await api.getListens(),
      appearance: JSON.parse(JSON.stringify(appearance.settings)),
    });
    const day = new Date().toISOString().slice(0, 10);
    const path = await api.saveBackup(JSON.stringify(data), `Sauvegarde Music Player ${day}`);
    if (!path) return;
    if (onAndroid) shareFile(path);
    else ui.notify("Sauvegarde enregistrée");
  } catch (e) {
    ui.notify(`Sauvegarde impossible : ${String(e)}`);
  } finally {
    saving.value = false;
  }
}

function open(text: string) {
  readError.value = null;
  done.value = null;
  try {
    backup.value = parseBackup(text);
  } catch (e) {
    backup.value = null;
    readError.value = e instanceof Error ? e.message : String(e);
  }
}

async function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) open(await file.text());
}

// Sauvegarde ouverte avec l'appli (« Ouvrir avec Music Player »).
watch(
  () => ui.backupToRestore,
  (text) => {
    if (!text) return;
    open(text);
    ui.backupToRestore = null;
  },
  { immediate: true },
);

async function restore() {
  if (!backup.value || !plan.value) return;
  restoring.value = true;
  const summary: string[] = [];
  try {
    if (parts.playlists) {
      let n = 0;
      for (const p of plan.value.playlists) {
        if (!p.found.length) continue;
        const ids = p.found.map((t) => t.id);
        const existing = playlists.items.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
        if (existing) {
          await playlists.addTracks(existing.id, ids);
        } else {
          const id = await playlists.create(p.name, p.theme);
          if (!id) continue;
          if (p.style) await playlists.setStyle(id, p.style);
          await playlists.addTracks(id, ids);
        }
        n += 1;
      }
      summary.push(`${n} playlist${n > 1 ? "s" : ""}`);
    }
    if (parts.favorites && plan.value.favorites.length) {
      const added = await api.addFavorites(plan.value.favorites.map((t) => t.id));
      favorites.setFromInitialState(await api.listFavorites());
      summary.push(`${added} titre${added > 1 ? "s" : ""} aimé${added > 1 ? "s" : ""}`);
    }
    if (parts.listens && plan.value.listens.length) {
      const added = await api.importListens(plan.value.listens);
      summary.push(`${added} écoute${added > 1 ? "s" : ""}`);
    }
    if (parts.settings && hasSettings.value) {
      if (backup.value.appearance) appearance.restore(backup.value.appearance);
      restorePrefs(backup.value.prefs);
      summary.push("apparence et réglages");
    }
    done.value = `Restauré : ${summary.join(", ")}.`;
    backup.value = null;
  } catch (e) {
    ui.notify(`Restauration interrompue : ${String(e)}`);
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <section class="section-card">
    <h2><Icon name="folder" :size="17" /> Sauvegarde</h2>
    <p class="muted">
      Playlists, titres aimés, historique d'écoute, apparence et réglages dans un fichier (.mpsave), à restaurer ici ou
      sur un autre appareil. La musique n'y est pas : les morceaux sont retrouvés dans la bibliothèque de l'appareil.
    </p>
    <div class="actions">
      <button type="button" class="pill pill-accent" :disabled="saving" @click="save">
        <Icon name="share" :size="15" /> {{ saving ? "Préparation…" : onAndroid ? "Sauvegarder et envoyer…" : "Enregistrer une sauvegarde…" }}
      </button>
      <label class="pill pill-ghost file">
        <Icon name="import" :size="15" /> Restaurer une sauvegarde…
        <input type="file" accept=".mpsave,application/json" @change="pick" />
      </label>
    </div>
    <p v-if="readError" class="error">{{ readError }}</p>
    <p v-if="done" class="ok"><Icon name="check" :size="15" /> {{ done }}</p>

    <div v-if="backup && plan" class="restore">
      <p class="from">
        Sauvegarde de <strong>{{ backup.device || "un appareil" }}</strong>
        <template v-if="backup.created"> du {{ new Date(backup.created).toLocaleDateString("fr-FR") }}</template>
      </p>
      <label class="toggle">
        <input v-model="parts.playlists" type="checkbox" />
        <span>{{ plan.playlists.length }} playlist{{ plan.playlists.length > 1 ? "s" : "" }} · {{ found }} morceau{{ found > 1 ? "x" : "" }} retrouvé{{ found > 1 ? "s" : "" }} sur {{ total }}</span>
      </label>
      <label class="toggle">
        <input v-model="parts.favorites" type="checkbox" />
        <span>{{ plan.favorites.length }} titre{{ plan.favorites.length > 1 ? "s" : "" }} aimé{{ plan.favorites.length > 1 ? "s" : "" }}<template v-if="plan.favoritesMissing"> ({{ plan.favoritesMissing }} absent{{ plan.favoritesMissing > 1 ? "s" : "" }} ici)</template></span>
      </label>
      <label class="toggle">
        <input v-model="parts.listens" type="checkbox" />
        <span>{{ plan.listens.length }} écoute{{ plan.listens.length > 1 ? "s" : "" }} (Mon écoute, rétrospectives)</span>
      </label>
      <label v-if="hasSettings" class="toggle">
        <input v-model="parts.settings" type="checkbox" />
        <span>Apparence et réglages (visuels, paroles, Proches)</span>
      </label>
      <div class="actions">
        <button type="button" class="pill pill-ghost" @click="backup = null">Annuler</button>
        <button type="button" class="pill pill-accent" :disabled="restoring" @click="restore">{{ restoring ? "Restauration…" : "Restaurer" }}</button>
      </div>
      <p class="muted small">Rien n'est effacé : les playlists du même nom sont complétées, les autres créées.</p>
    </div>
  </section>
</template>

<style scoped>
.file {
  position: relative;
  overflow: hidden;
  cursor: pointer;
}
.file input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.restore {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius);
  background: rgba(var(--fg-rgb), 0.05);
}
.from {
  margin: 0 0 var(--space-1);
  font-size: 13.5px;
}
.ok {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--success);
  font-size: 13px;
}
.error {
  color: var(--danger-text);
  font-size: 13px;
}
.small {
  margin: 0;
  font-size: 12px;
}
</style>
