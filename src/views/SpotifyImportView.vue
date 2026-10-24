<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { api } from "@/lib/api";
import { LibraryMatcher, type MatchedPlaylist, matchPlaylist, missingText, readExportFile, type SpotifyExport } from "@/lib/spotifyImport";
import { useFavoritesStore } from "@/stores/favorites";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";

// Import depuis Spotify : on lit l'export de données du compte (ou un CSV) et on recrée les
// playlists et les titres likés avec les morceaux déjà présents dans la bibliothèque. Rien
// n'est téléchargé ; les morceaux absents sont listés.
const library = useLibraryStore();
const playlists = usePlaylistsStore();
const favorites = useFavoritesStore();
const ui = useUiStore();

const data = ref<SpotifyExport | null>(null);
const fileNames = ref<string[]>([]);
const reading = ref(false);
const readError = ref<string | null>(null);
const chosen = reactive<Record<number, boolean>>({});
const importLiked = ref(true);
const open = reactive<Record<string, boolean>>({});
const busy = ref(false);
const done = ref<{ playlists: number; tracks: number; liked: number } | null>(null);

const matcher = computed(() => new LibraryMatcher(library.tracks));
const matched = computed<MatchedPlaylist[]>(() => (data.value?.playlists ?? []).map((p) => matchPlaylist(matcher.value, p)));
const liked = computed<MatchedPlaylist | null>(() =>
  data.value?.liked.length ? matchPlaylist(matcher.value, { name: "Titres likés", tracks: data.value.liked }) : null,
);
const totals = computed(() => {
  const all = [...matched.value, ...(liked.value ? [liked.value] : [])];
  const found = all.reduce((s, p) => s + p.found.length, 0);
  const missing = all.reduce((s, p) => s + p.missing.length, 0);
  return { found, missing, percent: found + missing ? Math.round((found / (found + missing)) * 100) : 0 };
});
const selectedCount = computed(() => matched.value.filter((p, i) => chosen[i] && p.found.length).length);

async function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length) return;
  reading.value = true;
  readError.value = null;
  done.value = null;
  try {
    const merged: SpotifyExport = { playlists: [], liked: [] };
    for (const f of files) {
      const out = readExportFile(f.name, new Uint8Array(await f.arrayBuffer()));
      merged.playlists.push(...out.playlists);
      merged.liked.push(...out.liked);
    }
    if (!merged.playlists.length && !merged.liked.length) {
      readError.value = "Aucune playlist ni titre liké dans ce fichier. Choisissez my_spotify_data.zip, un fichier PlaylistN.json ou un CSV.";
      return;
    }
    data.value = merged;
    fileNames.value = files.map((f) => f.name);
    merged.playlists.forEach((_, i) => (chosen[i] = true));
  } catch (err) {
    readError.value = `Fichier illisible : ${String(err)}`;
  } finally {
    reading.value = false;
  }
}

function uniqueName(name: string): string {
  const taken = new Set(playlists.items.map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let candidate = `${name} (Spotify)`;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${name} (Spotify ${i})`;
  return candidate;
}

async function runImport() {
  if (busy.value) return;
  busy.value = true;
  const result = { playlists: 0, tracks: 0, liked: 0 };
  try {
    for (const [i, p] of matched.value.entries()) {
      if (!chosen[i] || !p.found.length) continue;
      const id = await playlists.create(uniqueName(p.name));
      if (!id) continue;
      result.tracks += await playlists.addTracks(id, p.found.map((t) => t.id));
      result.playlists += 1;
    }
    if (importLiked.value && liked.value?.found.length) {
      result.liked = await api.addFavorites(liked.value.found.map((t) => t.id));
      favorites.setFromInitialState(await api.listFavorites());
    }
    done.value = result;
    ui.notify(`${result.playlists} playlist${result.playlists > 1 ? "s" : ""} importée${result.playlists > 1 ? "s" : ""}`);
  } catch (e) {
    ui.notify(`Import interrompu : ${String(e)}`);
  } finally {
    busy.value = false;
  }
}

async function copyMissing(list: MatchedPlaylist[]) {
  const text = list
    .filter((p) => p.missing.length)
    .map((p) => `${p.name}\n${missingText(p.missing)}`)
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    ui.notify("Liste des morceaux manquants copiée");
  } catch {
    ui.notify("Copie impossible");
  }
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Importer de Spotify</h1>

    <section class="card how">
      <p>
        Retrouvez vos playlists et vos titres likés avec la musique déjà présente sur cet appareil. Rien n'est
        téléchargé : les morceaux que vous n'avez pas sont listés à part.
      </p>
      <ol>
        <li>Sur spotify.com : <strong>Compte → Confidentialité du compte → Télécharger vos données</strong>, cochez « Données du compte ».</li>
        <li>Spotify envoie un e-mail sous quelques jours : téléchargez <strong>my_spotify_data.zip</strong>.</li>
        <li>Choisissez ce fichier ci-dessous (un CSV d'Exportify ou un fichier PlaylistN.json marche aussi).</li>
      </ol>
      <label class="pill pill-accent file">
        <Icon name="import" :size="15" /> {{ reading ? "Lecture…" : data ? "Choisir d'autres fichiers…" : "Choisir l'export…" }}
        <input type="file" accept=".zip,.json,.csv,application/zip,application/json,text/csv" multiple :disabled="reading" @change="pick" />
      </label>
      <p v-if="readError" class="error">{{ readError }}</p>
    </section>

    <template v-if="data">
      <div class="summary">
        <span>
          <strong>{{ totals.found }}</strong> morceau{{ totals.found > 1 ? "x" : "" }} retrouvé{{ totals.found > 1 ? "s" : "" }} sur
          {{ totals.found + totals.missing }} ({{ totals.percent }} %)
          <span class="muted"> · {{ fileNames.join(", ") }}</span>
        </span>
        <div class="summary-actions">
          <button v-if="totals.missing" type="button" class="pill pill-ghost" @click="copyMissing([...matched, ...(liked ? [liked] : [])])">
            Copier les manquants
          </button>
          <button type="button" class="pill pill-accent" :disabled="busy || !!done || (!selectedCount && !(importLiked && liked?.found.length))" @click="runImport">
            {{ busy ? "Import…" : "Importer" }}
          </button>
        </div>
      </div>

      <p v-if="done" class="done">
        <Icon name="check" :size="16" />
        {{ done.playlists }} playlist{{ done.playlists > 1 ? "s" : "" }} créée{{ done.playlists > 1 ? "s" : "" }} ({{ done.tracks }} morceaux)<template v-if="done.liked">, {{ done.liked }} titre{{ done.liked > 1 ? "s" : "" }} ajouté{{ done.liked > 1 ? "s" : "" }} aux titres aimés</template>.
        <button type="button" class="link" @click="ui.go({ name: 'playlists' })">Voir les playlists</button>
      </p>

      <section v-if="liked" class="row-card">
        <label class="toggle">
          <input v-model="importLiked" type="checkbox" />
          <span class="name"><Icon name="heart" :size="15" /> Titres likés → Titres aimés</span>
        </label>
        <span class="count" :class="{ full: !liked.missing.length }">{{ liked.found.length }} / {{ liked.found.length + liked.missing.length }}</span>
        <button v-if="liked.missing.length" type="button" class="link" @click="open.liked = !open.liked">
          {{ open.liked ? "Masquer" : `${liked.missing.length} manquant${liked.missing.length > 1 ? "s" : ""}` }}
        </button>
        <ul v-if="open.liked" class="missing">
          <li v-for="(t, i) in liked.missing" :key="i">{{ t.artist ? `${t.artist} — ` : "" }}{{ t.title }}</li>
        </ul>
      </section>

      <section v-for="(p, i) in matched" :key="`${p.name}-${i}`" class="row-card" :class="{ off: !p.found.length }">
        <label class="toggle">
          <input v-model="chosen[i]" type="checkbox" :disabled="!p.found.length" />
          <span class="name">{{ p.name }}</span>
        </label>
        <span class="count" :class="{ full: !p.missing.length }">{{ p.found.length }} / {{ p.found.length + p.missing.length }}</span>
        <button v-if="p.missing.length" type="button" class="link" @click="open[i] = !open[i]">
          {{ open[i] ? "Masquer" : `${p.missing.length} manquant${p.missing.length > 1 ? "s" : ""}` }}
        </button>
        <ul v-if="open[i]" class="missing">
          <li v-for="(t, j) in p.missing" :key="j">{{ t.artist ? `${t.artist} — ` : "" }}{{ t.title }}</li>
        </ul>
      </section>
      <p class="muted small">
        Une playlist dont aucun morceau n'est sur l'appareil n'est pas créée. Après avoir ajouté des morceaux à la
        bibliothèque, rechoisissez l'export : les nouveaux sont retrouvés.
      </p>
    </template>
  </div>
</template>

<style scoped>
.card {
  padding: var(--space-4) 18px;
  border-radius: var(--radius-lg);
  background: rgba(var(--fg-rgb), 0.05);
  margin-bottom: var(--space-5);
  max-width: 760px;
}
.how p {
  margin: 0 0 var(--space-3);
  line-height: 1.5;
}
.how ol {
  margin: 0 0 var(--space-4);
  padding-left: 20px;
  color: var(--text-2);
  line-height: 1.6;
  font-size: 13.5px;
}
.how strong {
  color: var(--text);
}
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
.error {
  color: var(--danger-text);
  font-size: 13px;
}
.summary {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  padding: 10px 14px;
  border-radius: var(--radius);
  background: rgba(var(--surface-rgb), 0.92);
  backdrop-filter: blur(16px);
  box-shadow: inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.12);
  font-size: 13.5px;
}
.summary-actions {
  display: flex;
  gap: var(--space-2);
}
.done {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--success);
  font-size: 13.5px;
}
.row-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: 10px var(--space-2);
  border-bottom: 1px solid var(--separator);
}
.row-card.off {
  opacity: 0.55;
}
.row-card .toggle {
  flex: 1;
  min-width: 0;
}
.name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  font-size: 12.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.count.full {
  color: var(--success);
}
.link {
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 12.5px;
}
.missing {
  flex-basis: 100%;
  margin: 0;
  padding: var(--space-2) 0 var(--space-1) 30px;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
  user-select: text;
}
.small {
  margin-top: var(--space-4);
  font-size: 12px;
}
</style>
