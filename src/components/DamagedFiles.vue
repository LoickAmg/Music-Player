<script setup lang="ts">
import { computed, ref } from "vue";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Track } from "@/lib/types";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

// Rubrique « Fichiers illisibles » des Réglages : fichiers audio vides ou abîmés (souvent un
// téléchargement inachevé), tenus à l'écart des albums. Regroupés par dossier.
const library = useLibraryStore();
const ui = useUiStore();
const onAndroid = /Android/i.test(navigator.userAgent);
const expanded = ref(false);
const PREVIEW = 6;

function split(path: string) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { folder: i >= 0 ? path.slice(0, i) : "", file: i >= 0 ? path.slice(i + 1) : path };
}

/** Dossier affiché relativement à la bibliothèque (« Damso\Damso - J'ai Menti »). */
function shortFolder(folder: string) {
  const root = library.root;
  if (root && folder.toLowerCase().startsWith(root.toLowerCase())) {
    return folder.slice(root.length).replace(/^[\\/]+/, "") || "Dossier de la bibliothèque";
  }
  return folder;
}

const groups = computed(() => {
  const map = new Map<string, Track[]>();
  for (const t of library.damaged) {
    const { folder } = split(t.path);
    if (!map.has(folder)) map.set(folder, []);
    map.get(folder)!.push(t);
  }
  return [...map.entries()]
    .map(([folder, tracks]) => ({ folder, label: shortFolder(folder), tracks: tracks.sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => b.tracks.length - a.tracks.length || a.label.localeCompare(b.label));
});

// Aperçu limité tant qu'on n'a pas tout déplié : les premiers fichiers, dossier par dossier.
const visible = computed(() => {
  if (expanded.value) return groups.value;
  let left = PREVIEW;
  const out: typeof groups.value = [];
  for (const g of groups.value) {
    if (left <= 0) break;
    out.push({ ...g, tracks: g.tracks.slice(0, left) });
    left -= g.tracks.length;
  }
  return out;
});

async function reveal(path: string) {
  try {
    await revealItemInDir(path);
  } catch {
    ui.notify("Impossible d'ouvrir le dossier.");
  }
}
</script>

<template>
  <section id="fichiers-illisibles" class="card">
    <h2>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 4 21 19.5H3Z M12 10v4.2 M12 17h.01" />
      </svg>
      Fichiers illisibles
      <span v-if="library.damaged.length" class="count">{{ library.damaged.length }}</span>
    </h2>

    <p v-if="!library.damaged.length" class="muted">Aucun : tous les fichiers audio de la bibliothèque sont lisibles.</p>
    <template v-else>
      <p class="muted intro">
        Ces fichiers sont vides ou abîmés (souvent un téléchargement interrompu) : impossible d'en lire le son, le titre ou l'album.
        Ils sont tenus à l'écart des albums et des morceaux. Téléchargez-les à nouveau ou supprimez-les ; une fois remplacés,
        ils retrouvent leur place tout seuls au prochain passage de l'analyse.
      </p>
      <div v-for="g in visible" :key="g.folder" class="group">
        <div class="folder">
          <span class="folder-name" :title="g.folder">{{ g.label }}</span>
          <button v-if="!onAndroid" type="button" class="link" @click="reveal(g.tracks[0].path)">Ouvrir le dossier</button>
        </div>
        <ul>
          <li v-for="t in g.tracks" :key="t.id">
            <span class="file">{{ split(t.path).file }}</span>
            <span class="reason">{{ t.damage }}</span>
          </li>
        </ul>
      </div>
      <button v-if="library.damaged.length > PREVIEW" type="button" class="link more" @click="expanded = !expanded">
        {{ expanded ? "Réduire" : `Afficher les ${library.damaged.length} fichiers` }}
      </button>
    </template>
  </section>
</template>

<style scoped>
.card {
  margin-bottom: 16px;
  padding: 18px 20px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  box-shadow: inset 0 0 0 0.5px var(--separator);
  /* Lien « N fichiers illisibles » : le titre reste visible sous la barre du haut. */
  scroll-margin-top: 24px;
}
@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .card {
    scroll-margin-top: calc(var(--safe-top) + 84px);
  }
}
h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 15px;
}
h2 svg {
  color: #ffb454;
}
.count {
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(255, 180, 84, 0.16);
  color: #ffb454;
  font-size: 12px;
}
.intro {
  margin: 0 0 14px;
  line-height: 1.5;
}
.group + .group {
  margin-top: 14px;
}
.folder {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.folder-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
ul {
  margin: 0;
  padding: 0;
  list-style: none;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}
li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 2px 12px;
  padding: 8px 12px;
  font-size: 13px;
}
li + li {
  border-top: 1px solid var(--separator);
}
.file {
  min-width: 0;
  overflow-wrap: anywhere;
  user-select: text;
}
.reason {
  font-size: 12px;
  color: var(--text-3);
}
.link {
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 12.5px;
}
.more {
  margin-top: 12px;
}
</style>
