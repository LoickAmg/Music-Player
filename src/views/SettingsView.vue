<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "@/lib/api";
import { openDefaultApps } from "@/lib/androidMedia";
import { formatCollection } from "@/lib/format";
import { BAND_LABELS, EQ_PRESETS, useEqStore } from "@/stores/eq";
import { useLibraryStore } from "@/stores/library";
import { useLyricsStore } from "@/stores/lyrics";
import { usePlaylistsStore } from "@/stores/playlists";
import { useShareStore } from "@/stores/share";
import { useUiStore } from "@/stores/ui";
import { useUpdaterStore } from "@/stores/updater";
import { autoReason, lite, perfSetting, resetDetection, setPerfSetting, type PerfSetting } from "@/lib/perf";
import DamagedFiles from "@/components/DamagedFiles.vue";
import BackupSection from "@/components/BackupSection.vue";
import AccountSection from "@/components/AccountSection.vue";
import AdminAccess from "@/components/AdminAccess.vue";
import Icon from "@/components/Icon.vue";
import LegalDialog from "@/components/LegalDialog.vue";

const library = useLibraryStore();
const eq = useEqStore();
const lyrics = useLyricsStore();
const updater = useUpdaterStore();
const playlists = usePlaylistsStore();
const share = useShareStore();
const ui = useUiStore();

const modelMo = computed(() => Math.round((lyrics.model?.bytes ?? 80_500_000) / 1_000_000));
onMounted(() => void lyrics.refreshModel());
async function toggleAlign(on: boolean) {
  if (on) await lyrics.enableAlign();
  else lyrics.disableAlign();
}

const importing = ref(false);
async function importShare() {
  importing.value = true;
  try {
    const path = await api.pickShareFile();
    if (!path) return;
    const result = await api.importShareBundle(path);
    await playlists.fetchAll();
    const what = result.kind === "playlist" ? `la playlist « ${result.name} »` : `« ${result.name} »`;
    ui.notify(`${what} importée (${result.added_tracks} morceau${result.added_tracks > 1 ? "x" : ""}).`);
  } catch (e) {
    ui.notify(`Import impossible : ${e}`);
  } finally {
    importing.value = false;
  }
}
const PERF_CHOICES: { value: PerfSetting; label: string }[] = [
  { value: "auto", label: "Automatique" },
  { value: "full", label: "Complet" },
  { value: "lite", label: "Léger" },
];
const showLegal = ref(false);
function showDamaged() {
  document.getElementById("fichiers-illisibles")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
const onAndroid = /Android/i.test(navigator.userAgent);
const onWindows = /Windows/i.test(navigator.userAgent);

async function makeDefault() {
  if (onAndroid) {
    if (!openDefaultApps()) ui.notify("Réglages introuvables : ouvrez Paramètres → Applications → Applis par défaut.");
    return;
  }
  try {
    await api.makeDefaultPlayer();
    ui.notify("Dans la fenêtre de Windows, choisissez Music Player pour les formats audio.");
  } catch (e) {
    ui.notify(String(e));
  }
}

// Android : l'économiseur de batterie (très strict sur Huawei, Xiaomi…) peut retarder la
// vérification des mises à jour en arrière-plan. Relu au retour des réglages d'Android.
const backgroundAllowed = ref(true);
const AndroidUpdate = window.AndroidUpdate;
function readBackground() {
  try {
    backgroundAllowed.value = window.AndroidUpdate?.backgroundAllowed?.() ?? true;
  } catch {
    backgroundAllowed.value = true;
  }
}
function onVisible() {
  if (!document.hidden) readBackground();
}
onMounted(() => {
  readBackground();
  document.addEventListener("visibilitychange", onVisible);
});
onBeforeUnmount(() => document.removeEventListener("visibilitychange", onVisible));
const version = ref<string | null>(null);
onMounted(async () => {
  try {
    version.value = await getVersion();
  } catch {
    // mode démo du navigateur
  }
});

const shortcuts = [
  ["Espace", "Lecture / pause"],
  ["Ctrl + →  /  Ctrl + ←", "Morceau suivant / précédent"],
  ["→  /  ←", "Avancer / reculer de 5 s"],
  ["Ctrl + F", "Rechercher"],
  ["Ctrl + L", "Afficher les paroles"],
  ["Échap", "Fermer « À l'écoute »"],
];
</script>

<template>
  <div class="page settings">
    <h1 class="page-title">Réglages</h1>

    <button type="button" class="feedback-card" @click="ui.feedback = true">
      <Icon name="lyrics" :size="20" />
      <span>
        <strong>Un avis ?</strong>
        <small>Un problème, une idée, une suggestion : écrivez-moi, captures d'écran comprises.</small>
      </span>
      <span class="chev" aria-hidden="true">›</span>
    </button>

    <section class="section-card custom-card">
      <h2><Icon name="brush" :size="17" /> Personnalisation</h2>
      <p class="muted">Thèmes et couleurs, polices de l'interface, des titres et des paroles, taille des paroles. Jaquettes de playlists : bouton « Personnaliser » de chaque playlist.</p>
      <div class="actions">
        <button type="button" class="pill pill-accent" @click="ui.go({ name: 'appearance' })">Ouvrir la personnalisation</button>
      </div>
    </section>

    <section class="section-card">
      <h2><Icon name="folder" :size="17" /> Bibliothèque</h2>
      <p class="path">{{ library.root ?? "Aucun dossier choisi" }}</p>
      <p class="muted">
        {{ formatCollection(library.tracks.length, library.totalDuration) }} · {{ library.albums.length.toLocaleString("fr-FR") }} albums
        <template v-if="library.damaged.length">
          · <a href="#fichiers-illisibles" class="warn" @click.prevent="showDamaged">{{ library.damaged.length }} fichier{{ library.damaged.length > 1 ? "s" : "" }} illisible{{ library.damaged.length > 1 ? "s" : "" }}</a>
        </template>
      </p>
      <div class="actions">
        <button type="button" class="pill pill-accent" @click="library.chooseFolderAndScan()">Choisir un dossier…</button>
        <button type="button" class="pill pill-ghost" :disabled="!library.root || library.scanning" @click="library.root && library.scan(library.root)">
          <Icon name="refresh" :size="15" /> {{ library.scanning ? "Analyse en cours…" : "Rescanner" }}
        </button>
        <button type="button" class="pill pill-ghost" :disabled="!library.tracks.length" @click="ui.go({ name: 'duplicates' })">
          <Icon name="songs" :size="15" /> Doublons…
        </button>
      </div>
      <p v-if="library.error" class="error">{{ library.error }}</p>
      <label class="toggle">
        <input type="checkbox" :checked="library.separateVoices" @change="library.setSeparateVoices(($event.target as HTMLInputElement).checked)" />
        <span>
          Ranger à part les notes vocales et les enregistrements
          <template v-if="library.voices.length">({{ library.voices.length }}, page « Vocaux »)</template>
        </span>
      </label>
      <p class="muted small">Notes vocales WhatsApp, Telegram, dictaphone, appels enregistrés. Un fichier mal rangé se corrige depuis son menu (« ⋯ »).</p>
    </section>

    <section v-if="onAndroid || onWindows" class="section-card">
      <h2><Icon name="play" :size="17" /> Lecteur par défaut</h2>
      <p v-if="onWindows" class="muted">
        Ouvrez vos fichiers audio avec Music Player d'un double-clic. Windows vous laisse choisir l'application par
        défaut : le bouton ouvre la bonne page des Paramètres, il ne reste qu'à confirmer.
      </p>
      <p v-else class="muted">
        Music Player apparaît quand une autre appli ouvre un fichier audio (gestionnaire de fichiers, WhatsApp,
        téléchargements) : choisissez-le puis « Toujours ». Pour changer ce choix plus tard, ouvrez les applis par
        défaut du téléphone.
      </p>
      <div class="actions">
        <button type="button" class="pill pill-accent" @click="makeDefault">
          {{ onWindows ? "Définir comme lecteur par défaut…" : "Ouvrir les applis par défaut" }}
        </button>
      </div>
    </section>

    <section class="section-card">
      <h2><Icon name="share" :size="17" /> Partage</h2>
      <p class="muted">
        Un morceau ou une playlist se partage depuis son menu (« Partager ») : à un appareil voisin sur le même Wi-Fi, à distance
        avec un code, ou par une autre application. Les fichiers audio voyagent avec : la personne qui reçoit n'a pas besoin de
        les avoir.
      </p>
      <div class="actions">
        <button type="button" class="pill pill-accent" @click="share.receiving = true">
          <Icon name="import" :size="15" /> Recevoir avec un code
        </button>
        <button v-if="!onAndroid" type="button" class="pill pill-ghost" :disabled="importing" @click="importShare">
          {{ importing ? "Import…" : "Importer un fichier .mpshare…" }}
        </button>
      </div>
      <p v-if="onAndroid" class="muted small">Un fichier .mpshare reçu par messagerie s'ouvre avec « Ouvrir avec Music Player ».</p>
      <label class="toggle">
        <input type="checkbox" :checked="share.visible" @change="share.setVisible(($event.target as HTMLInputElement).checked)" />
        <span>Visible des appareils à proximité (même Wi-Fi), sous le nom « {{ share.deviceName }} »</span>
      </label>
      <p class="muted small">
        Le nom vient de votre profil (Personnalisation). Rien n'est reçu sans votre accord.
        <template v-if="onAndroid">Sur téléphone, l'appareil n'est visible que pendant que Music Player est à l'écran.</template>
      </p>
      <label class="field-label" for="relay">Relais pour le partage à distance</label>
      <input
        id="relay"
        class="relay fieldbox"
        type="url"
        :value="share.relay"
        :placeholder="share.defaultRelay ?? 'https://…workers.dev'"
        spellcheck="false"
        autocomplete="off"
        @change="share.setRelay(($event.target as HTMLInputElement).value)"
      />
      <p class="muted small">
        Il ne fait que mettre les deux appareils en relation : le contenu est chiffré de bout en bout avec les mots du code, qu'il ne
        reçoit jamais. <template v-if="share.defaultRelay">Laissez vide pour utiliser celui de l'application.</template>
        <template v-else>Aucun relais n'est fourni avec cette version : voir relay/README.md dans le dépôt pour en mettre un en ligne gratuitement.</template>
      </p>
    </section>

    <DamagedFiles />
    <AccountSection />
    <BackupSection />

    <section class="section-card">
      <h2><Icon name="refresh" :size="17" /> Mises à jour</h2>
      <p v-if="onAndroid" class="muted">
        Version installée : {{ version ?? "—" }}. L'application vérifie au démarrage, et en arrière-plan quelques fois par
        jour même fermée, si une nouvelle version est publiée : une notification « Mettre à jour » vous prévient. Android
        télécharge alors l'APK (même sur une connexion lente, avec reprise), puis ouvre l'installation, par-dessus la
        version actuelle (rien n'est perdu).
      </p>
      <p v-if="onAndroid && !backgroundAllowed" class="muted small">
        Sur certains téléphones (Huawei, Xiaomi…), l'économiseur de batterie retarde cette vérification en arrière-plan.
        <button type="button" class="link-btn" @click="AndroidUpdate?.openBatterySettings?.()">Autoriser Music Player en arrière-plan</button>
      </p>
      <p v-else class="muted">
        Version installée : {{ version ?? "—" }}. Au démarrage, l'application vérifie si une nouvelle version est publiée
        et propose de l'installer en un clic (elle redémarre ensuite toute seule, sans rien perdre).
      </p>
      <div class="actions">
        <button type="button" class="pill pill-ghost" :disabled="updater.checking || updater.installing" @click="updater.check(true)">
          {{ updater.checking ? "Vérification…" : "Rechercher une mise à jour" }}
        </button>
        <button v-if="updater.available" type="button" class="pill pill-accent" :disabled="updater.installing" @click="updater.install()">
          {{ updater.installing ? (updater.progress !== null ? `Téléchargement… ${Math.round(updater.progress * 100)} %` : "Téléchargement…") : `Installer la version ${updater.available.version}` }}
        </button>
      </div>
      <p v-if="updater.message" class="muted small">{{ updater.message }}</p>
      <div v-if="updater.failed" class="actions">
        <button type="button" class="pill pill-ghost" @click="updater.openInBrowser()">Télécharger avec le navigateur</button>
      </div>
    </section>

    <section class="section-card">
      <h2><Icon name="brush" :size="17" /> Affichage</h2>
      <div class="presets">
        <button
          v-for="c in PERF_CHOICES"
          :key="c.value"
          type="button"
          class="chip"
          :class="{ on: perfSetting === c.value }"
          @click="setPerfSetting(c.value)"
        >
          {{ c.label }}
        </button>
      </div>
      <p class="muted small">
        « Léger » garde la même musique et les mêmes paroles synchronisées, avec moins d'effets : fond fixe aux couleurs
        de la pochette, ligne chantée surlignée en entier. Il ménage la batterie et évite que les téléphones modestes ne
        chauffent ou ne saccadent.
        <template v-if="perfSetting === 'auto'">
          <br />Actuellement : <strong>{{ lite ? "léger" : "complet" }}</strong><template v-if="lite && autoReason"> ({{ autoReason }})</template>.
          <button v-if="lite && autoReason.startsWith('saccades')" type="button" class="link-btn" @click="resetDetection()">Réessayer le mode complet</button>
        </template>
      </p>
    </section>

    <section class="section-card">
      <h2><Icon name="eq" :size="17" /> Égaliseur</h2>
      <div class="presets">
        <button v-for="p in EQ_PRESETS" :key="p.name" type="button" class="chip" :class="{ on: eq.activePreset === p.name }" @click="eq.applyPreset(p.gains)">{{ p.name }}</button>
      </div>
      <div class="bands">
        <label v-for="(label, i) in BAND_LABELS" :key="label" class="band">
          <span class="db">{{ eq.gains[i] > 0 ? "+" : "" }}{{ eq.gains[i] }} dB</span>
          <input type="range" min="-12" max="12" step="1" :value="eq.gains[i]" :aria-label="label" @input="eq.setGain(i as 0 | 1 | 2, Number(($event.target as HTMLInputElement).value))" />
          <span>{{ label }}</span>
        </label>
      </div>
    </section>

    <section class="section-card">
      <h2><Icon name="lyrics" :size="17" /> Paroles</h2>
      <label class="toggle">
        <input type="checkbox" :checked="lyrics.allowOnline" @change="lyrics.setAllowOnline(($event.target as HTMLInputElement).checked)" />
        <span>Trouver automatiquement les paroles en ligne (LRCLIB, et lyrics.ovh en secours)</span>
      </label>
      <p class="muted small">
        Utilisé seulement si le morceau n'a pas de paroles intégrées ni de fichier <code>.lrc</code> à côté de lui.
        Seuls le titre, l'artiste, l'album et la durée sont envoyés ; les résultats sont gardés en cache sur cet appareil.
        Si seule une version sans minutage existe, une version synchronisée est recherchée de nouveau toute seule pendant l'écoute.
      </p>
      <label class="toggle">
        <input type="checkbox" :checked="lyrics.alignEnabled" :disabled="lyrics.installing !== null" @change="toggleAlign(($event.target as HTMLInputElement).checked)" />
        <span>Synchroniser automatiquement les paroles sans minutage</span>
      </label>
      <p class="muted small">
        Reconnaissance vocale faite sur cet appareil (aucun son n'est envoyé) avec un modèle à télécharger une fois
        ({{ modelMo }} Mo). Le calcul prend de quelques secondes à quelques minutes par morceau.
        <template v-if="lyrics.installing !== null"><br />Téléchargement… {{ Math.round(lyrics.installing * 100) }} %</template>
        <template v-else-if="lyrics.model?.installed">
          <br />Modèle installé.
          <button type="button" class="link-btn" @click="lyrics.removeModel()">Supprimer le modèle</button>
        </template>
      </p>
      <p v-if="lyrics.installError" class="error">{{ lyrics.installError }}</p>
    </section>

    <section class="section-card">
      <h2>Raccourcis clavier</h2>
      <dl class="keys">
        <template v-for="[k, v] in shortcuts" :key="k">
          <dt><kbd>{{ k }}</kbd></dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>
    </section>

    <section class="section-card">
      <h2>À propos</h2>
      <p class="muted small">
        Music Player — lecteur de musique local : la plupart des formats audio (ffmpeg en appoint), paroles
        synchronisées, égaliseur. Vos fichiers ne quittent jamais votre ordinateur.
      </p>
      <button type="button" class="pill pill-ghost" @click="showLegal = true">Mentions légales et confidentialité</button>
    </section>

    <LegalDialog v-if="showLegal" @close="showLegal = false" />
    <AdminAccess />
  </div>
</template>

<style scoped>
.feedback-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin: 0 0 var(--space-4);
  padding: 12px 14px;
  border: 0;
  border-radius: var(--radius-lg);
  background: var(--accent-soft);
  color: var(--text);
  text-align: left;
}
.feedback-card > :first-child {
  color: var(--accent);
}
.feedback-card span:not(.chev) {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.feedback-card small {
  font-size: 12px;
  color: var(--text-2);
}
.feedback-card .chev {
  font-size: 20px;
  color: var(--text-2);
}
.settings {
  max-width: 760px;
}
.path {
  margin: 0 0 2px;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12.5px;
  word-break: break-all;
  user-select: text;
}
.pill:disabled {
  opacity: 0.45;
}
.error {
  color: var(--danger);
}
.warn {
  color: var(--warning);
  text-decoration: none;
}
.warn:hover {
  text-decoration: underline;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 18px;
}
.chip {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 14px;
  background: var(--bg-active);
  font-size: 12.5px;
}
.chip.on {
  background: var(--accent);
  color: #fff;
}
.bands {
  display: flex;
  gap: 40px;
  padding-left: 8px;
}
.band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.band input {
  writing-mode: vertical-lr;
  direction: rtl;
  height: 120px;
  accent-color: var(--accent);
}
.db {
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.small {
  font-size: 12.5px;
  line-height: 1.55;
}
.keys {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 8px 18px;
  margin: 0;
  font-size: 13px;
}
.keys dd {
  margin: 0;
  color: var(--text-2);
}
kbd {
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--bg-active);
  font-family: inherit;
  font-size: 12px;
}
.field-label {
  display: block;
  margin-top: 14px;
  font-size: 13px;
  font-weight: 600;
}
.relay {
  width: 100%;
  height: 36px;
  margin-top: 6px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: rgba(var(--fg-rgb), 0.07);
  font-size: 13px;
}
.link-btn {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  text-decoration: underline;
}
</style>
