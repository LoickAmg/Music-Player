<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { api } from "@/lib/api";
import { deleteAudioFiles } from "@/lib/androidMedia";
import { findDuplicates, formatLabel } from "@/lib/duplicates";
import { formatDuration } from "@/lib/format";
import { useFavoritesStore } from "@/stores/favorites";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";

// Doublons de la bibliothèque : copies d'un même morceau (même titre, même artiste, même
// durée). Pour chaque groupe, la meilleure copie est proposée ; les autres partent à la
// corbeille (ordinateur) ou sont effacées avec l'accord du système (téléphone).
const library = useLibraryStore();
const player = usePlayerStore();
const playlists = usePlaylistsStore();
const favorites = useFavoritesStore();
const ui = useUiStore();

const groups = computed(() => findDuplicates(library.tracks));
/** Copie gardée par groupe (choix de la personne, sinon la proposition). */
const kept = reactive<Record<string, string>>({});
/** Groupes laissés de côté (pas de vrais doublons). */
const skipped = reactive<Record<string, boolean>>({});
const confirming = ref(false);
const busy = ref(false);
const onAndroid = typeof window !== "undefined" && !!window.AndroidFiles;

const keepOf = (key: string, fallback: string) => kept[key] ?? fallback;
const chosen = computed(() =>
  groups.value
    .filter((g) => !skipped[g.key])
    .map((g) => {
      const keep = keepOf(g.key, g.keep);
      return { keep, remove: g.tracks.filter((t) => t.id !== keep).map((t) => t.id) };
    }),
);
const extra = computed(() => chosen.value.reduce((s, g) => s + g.remove.length, 0));

function folder(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.slice(-2).join("/") || path;
}

async function removeAll() {
  if (!extra.value || busy.value) return;
  busy.value = true;
  confirming.value = false;
  try {
    const groupsToSend = chosen.value;
    let outcome = await api.removeDuplicates(groupsToSend);
    let removed = outcome.removed;
    // Téléphone : la musique d'autres applis ne s'efface qu'avec l'accord du système.
    for (let round = 0; outcome.failed.length && round < 5; round++) {
      const ok = await deleteAudioFiles(outcome.failed);
      if (!ok) break;
      outcome = await api.removeDuplicates(groupsToSend);
      removed += outcome.removed;
    }
    if (removed) await library.refresh();
    await playlists.fetchAll();
    favorites.setFromInitialState(await api.listFavorites());
    const s = removed > 1 ? "s" : "";
    if (removed) ui.notify(`${removed} copie${s} ${onAndroid ? `supprimée${s}` : `mise${s} à la corbeille`}`);
    if (outcome.failed.length) {
      ui.notify(`${outcome.failed.length} fichier${outcome.failed.length > 1 ? "s" : ""} n'${outcome.failed.length > 1 ? "ont" : "a"} pas pu être supprimé${outcome.failed.length > 1 ? "s" : ""}`);
    }
  } catch (e) {
    ui.notify(`Suppression impossible : ${String(e)}`);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Doublons</h1>
    <p class="muted intro">
      Copies d'un même morceau (même titre, même artiste, même durée). La meilleure copie est proposée : format sans
      perte, pochette, étiquettes complètes. Les playlists et les titres aimés suivront la copie gardée.
      {{ onAndroid ? "Android demandera votre accord avant d'effacer." : "Les copies retirées vont à la corbeille." }}
    </p>

    <p v-if="!groups.length" class="empty"><Icon name="check" :size="18" /> Aucun doublon dans la bibliothèque.</p>

    <template v-else>
      <div class="summary">
        <span>
          {{ groups.length }} morceau{{ groups.length > 1 ? "x" : "" }} en double ·
          <strong>{{ extra }} copie{{ extra > 1 ? "s" : "" }} en trop</strong>
        </span>
        <div class="summary-actions">
          <template v-if="confirming">
            <button type="button" class="pill pill-ghost" @click="confirming = false">Annuler</button>
            <button type="button" class="pill pill-danger" :disabled="busy" @click="removeAll">
              <Icon name="trash" :size="15" /> Oui, retirer {{ extra }} copie{{ extra > 1 ? "s" : "" }}
            </button>
          </template>
          <button v-else type="button" class="pill pill-accent" :disabled="!extra || busy" @click="confirming = true">
            <Icon name="trash" :size="15" /> {{ busy ? "Suppression…" : "Retirer les copies en trop" }}
          </button>
        </div>
      </div>

      <section v-for="g in groups" :key="g.key" class="group" :class="{ off: skipped[g.key] }">
        <header>
          <div class="name">
            <strong>{{ g.tracks[0].title }}</strong>
            <span class="muted">{{ g.tracks[0].artist }}</span>
          </div>
          <label class="skip">
            <input v-model="skipped[g.key]" type="checkbox" />
            Garder toutes les copies
          </label>
        </header>
        <label v-for="t in g.tracks" :key="t.id" class="copy" :class="{ keep: keepOf(g.key, g.keep) === t.id }">
          <input
            type="radio"
            :name="g.key"
            :checked="keepOf(g.key, g.keep) === t.id"
            :disabled="skipped[g.key]"
            @change="kept[g.key] = t.id"
          />
          <span class="badge">{{ formatLabel(t) }}</span>
          <span class="info">
            <span class="line">
              {{ t.album }} · {{ formatDuration(t.duration_secs) }}
              <span v-if="t.has_cover" class="muted">· pochette</span>
              <span v-if="g.keep === t.id" class="best">proposée</span>
            </span>
            <span class="path" :title="t.path">{{ folder(t.path) }}</span>
          </span>
          <span class="verdict">{{ skipped[g.key] ? "" : keepOf(g.key, g.keep) === t.id ? "Gardée" : "Retirée" }}</span>
          <button type="button" class="icon-btn" :aria-label="`Écouter cette copie`" @click.prevent="player.playTrackNow(t.id)">
            <Icon name="play" :size="15" />
          </button>
        </label>
      </section>
    </template>
  </div>
</template>

<style scoped>
.intro {
  margin: -12px 0 18px;
  max-width: 70ch;
  font-size: 13px;
  line-height: 1.5;
}
.empty {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
}
.summary {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 16px;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(var(--surface-rgb), 0.92);
  backdrop-filter: blur(16px);
  box-shadow: inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.12);
  font-size: 13.5px;
}
.summary-actions {
  display: flex;
  gap: 8px;
}
.pill-danger {
  background: #e5484d;
  color: #fff;
}
.group {
  margin-bottom: 14px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(var(--fg-rgb), 0.04);
}
.group.off {
  opacity: 0.55;
}
.group header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.name {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.skip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.copy {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
}
.copy:hover {
  background: rgba(var(--fg-rgb), 0.05);
}
.badge {
  flex: none;
  min-width: 44px;
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(var(--fg-rgb), 0.1);
  font-size: 11px;
  font-weight: 700;
  text-align: center;
}
.keep .badge {
  background: var(--accent);
  color: #fff;
}
.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.line {
  font-size: 13px;
}
.path {
  font-size: 11.5px;
  color: var(--text-3, var(--text-2));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.best {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(60, 200, 120, 0.18);
  color: #3cc878;
  font-size: 11px;
}
.verdict {
  flex: none;
  font-size: 12px;
  color: var(--text-2);
}
.keep .verdict {
  color: var(--accent);
  font-weight: 600;
}
</style>
