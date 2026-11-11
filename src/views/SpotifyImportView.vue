<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import { api } from "@/lib/api";
import { LibraryMatcher, type MatchedPlaylist, matchPlaylist, missingText, readExportFile, type SpotifyExport } from "@/lib/spotifyImport";
import { useFavoritesStore } from "@/stores/favorites";
import { useLibraryStore } from "@/stores/library";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";

// Import Spotify : lecture de l'export, correspondance locale, puis téléchargement optionnel
// des absents par spotDL sur PC.
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
const importedPlaylistIds = reactive<Record<number, string>>({});
const spotdlBusy = ref(false);
const spotdlReport = ref<{ items: { title: string; artist: string; status: string; detail: string }[]; imported: number } | null>(null);
const spotdlError = ref<string | null>(null);
/** Avancement du lot en cours (événements du moteur) et arrêt demandé. */
const spotdlNow = ref<{ index: number; total: number; title: string; artist: string } | null>(null);
const spotdlDone = ref<{ title: string; artist: string; status: string }[]>([]);
const spotdlStopping = ref(false);
let offProgress: (() => void) | null = null;
onBeforeUnmount(() => offProgress?.());
async function stopSpotdl() {
  spotdlStopping.value = true;
  await api.spotdlCancel().catch(() => {});
}
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
const missingForSpotdl = computed(() => {
  const source = [
    ...matched.value.filter((_, i) => chosen[i]).flatMap((p) => p.missing),
    ...(importLiked.value ? liked.value?.missing ?? [] : []),
  ];
  const seen = new Set<string>();
  return source.filter((t) => {
    const key = `${t.artist.toLocaleLowerCase()}\0${t.title.toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

async function downloadMissing() {
  if (spotdlBusy.value || !missingForSpotdl.value.length) return;
  spotdlBusy.value = true;
  spotdlStopping.value = false;
  spotdlError.value = null;
  spotdlReport.value = null;
  spotdlNow.value = null;
  spotdlDone.value = [];
  offProgress?.();
  offProgress = await api
    .onSpotdlProgress((p) => {
      if (p.status === "en_cours") spotdlNow.value = p;
      else spotdlDone.value = [...spotdlDone.value, { title: p.title, artist: p.artist, status: p.status }];
    })
    .catch(() => null);
  try {
    const report = await api.spotdlDownloadMissing(missingForSpotdl.value);
    library.applyScanResult(report.library);
    spotdlReport.value = report;
    const after = new LibraryMatcher(library.tracks);
    for (const item of spotdlReport.value.items) {
      if (item.status === "telecharge" && !after.find({ title: item.title, artist: item.artist, album: "" })) {
        item.status = "fichier_non_importe";
        item.detail = `${item.detail}\nLe processus a réussi, mais le fichier n’apparaît pas dans la bibliothèque rescannée.`;
      }
    }
    spotdlReport.value.imported = spotdlReport.value.items.filter((item) => item.status === "telecharge").length;
    if (report.items.some((item) => item.status === "telecharge")) await runImport();
  } catch (error) {
    spotdlError.value = String(error);
  } finally {
    spotdlBusy.value = false;
    spotdlNow.value = null;
    offProgress?.();
    offProgress = null;
  }
}
const spotdlCounts = computed(() => ({
  ok: spotdlDone.value.filter((d) => d.status === "telecharge").length,
  ko: spotdlDone.value.filter((d) => d.status !== "telecharge").length,
}));

function spotdlStatusLabel(status: string) {
  const labels: Record<string, string> = {
    telecharge: "Téléchargé",
    introuvable: "Aucune correspondance trouvée",
    reseau: "Problème réseau ou limitation du service",
    ffmpeg: "FFmpeg absent ou en erreur",
    deno: "Deno requis ou en erreur",
    outil_absent: "spotDL absent",
    fichier_non_importe: "Fichier téléchargé mais introuvable dans la bibliothèque",
    erreur_lancement: "Impossible de lancer spotDL",
    echec_spotdl: "Échec spotDL",
    delai: "Délai dépassé (6 min) : arrêté, le lot a continué",
    annule: "Non téléchargé (arrêté)",
  };
  return labels[status] ?? status;
}

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
    Object.keys(importedPlaylistIds).forEach((key) => delete importedPlaylistIds[Number(key)]);
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
      let id = importedPlaylistIds[i];
      if (!id) {
        id = (await playlists.create(uniqueName(p.name))) ?? "";
        if (!id) continue;
        importedPlaylistIds[i] = id;
      }
      result.tracks += await playlists.addTracks(id, p.found.map((t) => t.id));
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

      <section v-if="totals.missing && isAndroid" class="spotdl card">
        <p>Le téléchargement spotDL est disponible uniquement sur PC pour le moment. Tu peux quand même importer les morceaux déjà présents dans la bibliothèque.</p>
      </section>
      <section v-else-if="totals.missing" class="spotdl card">
        <h2>Télécharger les morceaux manquants avec spotDL</h2>
        <p>
          Les titres et artistes sélectionnés seront recherchés un à un. spotDL utilise YouTube comme source audio ;
          les résultats peuvent donc différer de l’enregistrement Spotify. Les messages détaillés seront affichés pour chaque échec.
        </p>
        <p class="muted small">Sur Windows, installe Python puis <code>py -m pip install -U spotdl</code>. Installe FFmpeg avec <code>spotdl --download-ffmpeg</code> (Deno est recommandé avec <code>spotdl --download-deno</code>). Redémarre Music Player après l’installation.</p>
        <div class="spotdl-actions">
          <button type="button" class="pill pill-accent" :disabled="spotdlBusy || !missingForSpotdl.length" @click="downloadMissing">
            {{ spotdlBusy ? "Téléchargement en cours…" : `Télécharger ${missingForSpotdl.length} morceau${missingForSpotdl.length > 1 ? "x" : ""}` }}
          </button>
          <button v-if="spotdlBusy" type="button" class="pill pill-danger" :disabled="spotdlStopping" @click="stopSpotdl">
            {{ spotdlStopping ? "Arrêt…" : "Arrêter" }}
          </button>
        </div>
        <div v-if="spotdlBusy && spotdlNow" class="spotdl-progress" role="status">
          <div class="spotdl-progress-text">
            <span>Morceau {{ spotdlNow.index + 1 }} sur {{ spotdlNow.total }} · {{ spotdlNow.artist ? `${spotdlNow.artist} — ` : "" }}{{ spotdlNow.title }}</span>
            <span class="muted">{{ spotdlCounts.ok }} téléchargé{{ spotdlCounts.ok > 1 ? "s" : "" }} · {{ spotdlCounts.ko }} échec{{ spotdlCounts.ko > 1 ? "s" : "" }}</span>
          </div>
          <div class="spotdl-bar"><span :style="{ width: `${Math.round((spotdlNow.index / spotdlNow.total) * 100)}%` }" /></div>
          <small class="muted">Chaque morceau a 6 minutes au plus ; au-delà, il est passé et le lot continue.</small>
        </div>
        <p v-if="spotdlError" class="error">{{ spotdlError }}</p>
        <template v-if="spotdlReport">
          <p class="done">{{ spotdlReport.imported }} morceau{{ spotdlReport.imported > 1 ? "x" : "" }} ajouté{{ spotdlReport.imported > 1 ? "s" : "" }} à la bibliothèque.</p>
          <details v-for="(item, i) in spotdlReport.items" :key="`${item.artist}-${item.title}-${i}`" class="spotdl-result">
            <summary><strong>{{ spotdlStatusLabel(item.status) }}</strong> · {{ item.artist ? `${item.artist} — ` : "" }}{{ item.title }}</summary>
            <pre>{{ item.detail || "spotDL n’a fourni aucun détail." }}</pre>
          </details>
        </template>
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
.spotdl h2 {
  margin: 0 0 var(--space-2);
  font-size: 16px;
}
.spotdl-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.spotdl-progress {
  display: grid;
  gap: 6px;
  margin-top: var(--space-3);
}
.spotdl-progress-text {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
  font-size: 13px;
}
.spotdl-bar {
  height: 4px;
  border-radius: 2px;
  background: rgba(var(--fg-rgb), 0.1);
  overflow: hidden;
}
.spotdl-bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}
.spotdl-result {
  margin-top: var(--space-2);
  font-size: 12.5px;
}
.spotdl-result summary {
  cursor: pointer;
}
.spotdl-result pre {
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 10px;
  background: rgba(var(--fg-rgb), 0.05);
  border-radius: var(--radius);
  color: var(--text-2);
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
