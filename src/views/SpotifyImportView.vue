<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { api } from "@/lib/api";
import {
  LibraryMatcher,
  type MatchedPlaylist,
  matchPlaylist,
  missingText,
  readExportFile,
  type SpotifyExport,
  type SpotifyTrack,
} from "@/lib/spotifyImport";
import type { FetchJob, FetchWanted } from "@/lib/types";
import { useFavoritesStore } from "@/stores/favorites";
import { useFetchStore } from "@/stores/fetch";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";

// Import Spotify : trois sources (lien, données du compte, fichier JSON/CSV) qui aboutissent
// toutes à des playlists Spotify, correspondance locale, puis téléchargement des absents par la
// file du backend (spotDL puis yt-dlp, PC seulement).
const library = useLibraryStore();
const playlists = usePlaylistsStore();
const favorites = useFavoritesStore();
const fetchStore = useFetchStore();
const ui = useUiStore();

const data = ref<SpotifyExport | null>(null);
const fileNames = ref<string[]>([]);
const reading = ref(false);
const readError = ref<string | null>(null);
const chosen = reactive<Record<number, boolean>>({});
const importLiked = ref(true);
const open = reactive<Record<string, boolean>>({});
const busy = ref(false);
const queuing = ref(false);
const importedPlaylistIds = reactive<Record<number, string>>({});
const link = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const isAndroid = /Android/i.test(navigator.userAgent);
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

/** Absents sélectionnés, chacun une seule fois (la première playlist qui le contient le reçoit). */
const missingForDownload = computed(() => {
  const seen = new Set<string>();
  const out: { track: SpotifyTrack; playlist: number | null }[] = [];
  const add = (track: SpotifyTrack, playlist: number | null) => {
    const key = `${track.artist.toLocaleLowerCase()}\0${track.title.toLocaleLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ track, playlist });
  };
  matched.value.forEach((p, i) => {
    if (chosen[i]) p.missing.forEach((t) => add(t, i));
  });
  if (importLiked.value) liked.value?.missing.forEach((t) => add(t, null));
  return out;
});

const jobStateLabel: Record<FetchJob["state"], string> = {
  queued: "En attente",
  running: "Téléchargement en cours…",
  done: "Ajouté à la bibliothèque",
  failed: "Échec",
  cancelled: "Arrêté",
};

// Une tâche terminée avec une playlist cible l'a modifiée côté backend : on recharge les
// playlists. La bibliothèque arrive par l'événement global « library-updated » ; les morceaux
// arrivés passent alors d'eux-mêmes en « retrouvés », et « Importer » redevient possible.
const seenDone = new Set<string>();
watch(
  () => fetchStore.jobs.filter((job) => job.state === "done").map((job) => job.id),
  (ids) => {
    const fresh = fetchStore.jobs.filter((job) => job.state === "done" && !seenDone.has(job.id));
    ids.forEach((id) => seenDone.add(id));
    if (!fresh.length) return;
    if (fresh.some((job) => job.wanted.playlist_id)) void playlists.fetchAll();
    done.value = null;
  },
);

onMounted(async () => {
  if (isAndroid) return;
  // Les tâches déjà terminées avant l'ouverture de la vue ne déclenchent rien.
  await fetchStore.initialize();
  for (const job of fetchStore.jobs) if (job.state === "done") seenDone.add(job.id);
});
onBeforeUnmount(() => fetchStore.dispose());

function setData(next: SpotifyExport, names: string[]) {
  Object.keys(importedPlaylistIds).forEach((key) => delete importedPlaylistIds[Number(key)]);
  Object.keys(chosen).forEach((key) => delete chosen[Number(key)]);
  data.value = next;
  fileNames.value = names;
  next.playlists.forEach((_, i) => (chosen[i] = true));
  done.value = null;
  readError.value = null;
}

async function readLink() {
  const url = link.value.trim();
  if (isAndroid || reading.value || !url) return;
  reading.value = true;
  readError.value = null;
  try {
    const result = await api.fetchReadLink(url);
    setData({ playlists: [{ name: result.name, tracks: result.tracks }], liked: [] }, ["Lien Spotify"]);
  } catch (error) {
    readError.value = `Lecture du lien impossible : ${String(error)}`;
  } finally {
    reading.value = false;
  }
}

function openFilePicker(mode: "account" | "file") {
  if (reading.value || !fileInput.value) return;
  fileInput.value.accept = mode === "account" ? ".zip,application/zip" : ".json,.csv,application/json,text/csv";
  fileInput.value.click();
}

async function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length) return;
  reading.value = true;
  readError.value = null;
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
    setData(
      merged,
      files.map((f) => f.name),
    );
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

/** Playlist créée pour la i-ième playlist Spotify (une seule fois), ou null en cas d'échec. */
async function ensurePlaylist(i: number, name: string): Promise<string | null> {
  const existing = importedPlaylistIds[i];
  if (existing) return existing;
  const id = await playlists.create(uniqueName(name));
  if (id) importedPlaylistIds[i] = id;
  return id;
}

async function runImport() {
  if (busy.value) return;
  busy.value = true;
  const result = { playlists: 0, tracks: 0, liked: 0 };
  try {
    for (const [i, p] of matched.value.entries()) {
      if (!chosen[i] || !p.found.length) continue;
      const id = await ensurePlaylist(i, p.name);
      if (!id) continue;
      result.tracks += await playlists.addTracks(
        id,
        p.found.map((t) => t.id),
      );
    }
    result.playlists = Object.keys(importedPlaylistIds).length;
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

/** Met les absents dans la file ; chaque playlist concernée est créée d'abord pour les recevoir. */
async function downloadMissing() {
  if (queuing.value || !missingForDownload.value.length) return;
  queuing.value = true;
  try {
    const wanted: FetchWanted[] = [];
    for (const { track, playlist } of missingForDownload.value) {
      const playlistId = playlist === null ? null : await ensurePlaylist(playlist, matched.value[playlist].name);
      wanted.push({
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration_secs: track.duration_secs ?? null,
        playlist_id: playlistId,
      });
    }
    const ids = await fetchStore.enqueue(wanted);
    if (ids.length) ui.notify(`${ids.length} morceau${ids.length > 1 ? "x" : ""} en file de téléchargement`);
  } finally {
    queuing.value = false;
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
        Retrouvez vos playlists et vos titres likés avec la musique déjà présente sur cet appareil. Les morceaux que
        vous n'avez pas sont listés à part, et peuvent être téléchargés sur PC.
      </p>

      <div class="import-methods">
        <div class="import-method">
          <h2>Coller un lien</h2>
          <form class="link-form" @submit.prevent="readLink">
            <input
              v-model="link"
              type="text"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              placeholder="https://open.spotify.com/playlist/…"
              aria-label="Lien Spotify (playlist, album ou morceau)"
              :disabled="isAndroid || reading"
            />
            <button type="submit" class="pill pill-accent" :disabled="isAndroid || reading || !link.trim()">
              {{ reading ? "Lecture…" : "Lire" }}
            </button>
          </form>
          <p class="muted small">
            <template v-if="isAndroid">L'import par lien est disponible sur PC avec spotDL installé. Sur téléphone, utilisez vos données Spotify ou un fichier.</template>
            <template v-else>Playlist, album ou morceau. Une playlist privée n'est pas lisible : rendez-la publique, ou utilisez vos données Spotify.</template>
          </p>
        </div>

        <div class="import-method">
          <h2>Mes données Spotify</h2>
          <ol>
            <li>Sur spotify.com : <strong>Compte → Confidentialité du compte → Télécharger vos données</strong>, cochez « Données du compte ».</li>
            <li>Spotify envoie un e-mail sous quelques jours : téléchargez <strong>my_spotify_data.zip</strong>.</li>
          </ol>
          <button type="button" class="pill pill-ghost" :disabled="reading" @click="openFilePicker('account')">
            <Icon name="import" :size="15" /> {{ reading ? "Lecture…" : "Choisir my_spotify_data.zip" }}
          </button>
        </div>

        <div class="import-method">
          <h2>Un fichier</h2>
          <p class="muted small">PlaylistN.json ou YourLibrary.json (tirés de l'export), ou un CSV d'Exportify.</p>
          <button type="button" class="pill pill-ghost" :disabled="reading" @click="openFilePicker('file')">
            <Icon name="import" :size="15" /> {{ reading ? "Lecture…" : "Choisir un fichier" }}
          </button>
        </div>
      </div>

      <input ref="fileInput" class="file-input" type="file" multiple :disabled="reading" @change="pick" />
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

      <section v-if="totals.missing && isAndroid" class="spotdl card">
        <p>Le téléchargement des morceaux manquants est disponible uniquement sur PC pour le moment. Tu peux quand même importer les morceaux déjà présents dans la bibliothèque.</p>
      </section>
      <section v-else-if="totals.missing || fetchStore.jobs.length" class="spotdl card">
        <h2>Télécharger les morceaux manquants</h2>
        <p>
          Chaque morceau est cherché avec spotDL, puis yt-dlp si besoin. La source audio est YouTube : le résultat peut
          différer de l'enregistrement Spotify, et un résultat trop éloigné du titre demandé n'est pas ajouté.
        </p>
        <p class="muted small">Sur Windows, installe Python puis <code>py -m pip install -U spotdl</code>. Installe FFmpeg avec <code>spotdl --download-ffmpeg</code> (Deno est recommandé avec <code>spotdl --download-deno</code>). Redémarre Music Player après l'installation.</p>
        <p v-if="fetchStore.initialized && !fetchStore.anyTool" class="error">
          Ni spotDL ni yt-dlp n'a été trouvé sur ce PC. Installe-en un, puis
          <button type="button" class="link" @click="fetchStore.refreshAvailability()">vérifie à nouveau</button>.
        </p>
        <div class="spotdl-actions">
          <button
            type="button"
            class="pill pill-accent"
            :disabled="queuing || !missingForDownload.length || !fetchStore.anyTool"
            @click="downloadMissing"
          >
            {{ queuing ? "Mise en file…" : `Télécharger ${missingForDownload.length} morceau${missingForDownload.length > 1 ? "x" : ""}` }}
          </button>
          <button v-if="fetchStore.finished.length" type="button" class="pill pill-ghost" @click="fetchStore.clearFinished()">
            Vider les terminées
          </button>
        </div>
        <p v-if="fetchStore.lastError" class="error">{{ fetchStore.lastError }}</p>
        <p v-if="fetchStore.active.length" class="muted small">
          {{ fetchStore.active.length }} en cours ou en attente · chaque morceau a 6 minutes au plus. La file continue même si tu quittes cette page.
        </p>
        <ul v-if="fetchStore.jobs.length" class="fetch-jobs">
          <li v-for="job in fetchStore.jobs" :key="job.id" class="fetch-job" :class="job.state">
            <div class="fetch-job-main">
              <strong>{{ job.wanted.artist ? `${job.wanted.artist} — ` : "" }}{{ job.wanted.title }}</strong>
              <span class="muted">{{ jobStateLabel[job.state] }}</span>
              <details v-if="job.last_error && job.state === 'failed'" class="job-error">
                <summary>Détails</summary>
                <pre>{{ job.last_error }}</pre>
              </details>
            </div>
            <button v-if="job.state === 'queued' || job.state === 'running'" type="button" class="pill pill-danger" @click="fetchStore.cancel(job.id)">
              Arrêter
            </button>
          </li>
        </ul>
      </section>

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
          <!-- Une playlist sans aucun morceau local reste cochable : ses absents peuvent être téléchargés. -->
          <input v-model="chosen[i]" type="checkbox" :disabled="!p.found.length && (isAndroid || !p.missing.length)" />
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
        « Importer » crée les playlists avec les morceaux déjà présents. Ceux qui arrivent ensuite par téléchargement
        sont rangés dans leur playlist automatiquement ; « Importer » redevient disponible pour les autres trouvés entre-temps.
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
.spotdl h2,
.import-method h2 {
  margin: 0 0 var(--space-2);
  font-size: 15px;
}
.import-methods {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
}
.import-method {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.14);
}
.import-method .small,
.import-method ol {
  margin: 0;
}
.import-method .pill {
  margin-top: auto;
}
.link-form {
  display: flex;
  gap: 8px;
  width: 100%;
}
.link-form input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--radius);
  background: rgba(var(--fg-rgb), 0.07);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.link-form input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.file-input {
  display: none;
}
.spotdl-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fetch-jobs {
  display: grid;
  gap: 6px;
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}
.fetch-job {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 8px 10px;
  border-radius: var(--radius);
  background: rgba(var(--fg-rgb), 0.04);
  font-size: 13px;
}
.fetch-job.done .muted {
  color: var(--success);
}
.fetch-job.failed .muted {
  color: var(--danger-text);
}
.fetch-job-main {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.fetch-job-main strong {
  overflow-wrap: anywhere;
  font-weight: 600;
}
.job-error summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-2);
}
.job-error pre {
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 10px;
  background: rgba(var(--fg-rgb), 0.05);
  border-radius: var(--radius);
  color: var(--text-2);
  font-size: 12px;
}
.how > p {
  margin: 0 0 var(--space-3);
  line-height: 1.5;
}
.how ol {
  padding-left: 18px;
  color: var(--text-2);
  line-height: 1.55;
  font-size: 13px;
}
.how strong {
  color: var(--text);
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
  padding: 0;
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
.import-method .small {
  margin-top: 0;
}
</style>
