<script setup lang="ts">
import { ref } from "vue";
import { formatCollection } from "@/lib/format";
import { BAND_LABELS, EQ_PRESETS, useEqStore } from "@/stores/eq";
import { useLibraryStore } from "@/stores/library";
import { useLyricsStore } from "@/stores/lyrics";
import Icon from "@/components/Icon.vue";
import LegalDialog from "@/components/LegalDialog.vue";

const library = useLibraryStore();
const eq = useEqStore();
const lyrics = useLyricsStore();
const showLegal = ref(false);

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

    <section class="card">
      <h2><Icon name="folder" :size="17" /> Bibliothèque</h2>
      <p class="path">{{ library.root ?? "Aucun dossier choisi" }}</p>
      <p class="muted">{{ formatCollection(library.tracks.length, library.totalDuration) }} · {{ library.albums.length.toLocaleString("fr-FR") }} albums</p>
      <div class="actions">
        <button type="button" class="pill pill-accent" @click="library.chooseFolderAndScan()">Choisir un dossier…</button>
        <button type="button" class="pill pill-ghost" :disabled="!library.root || library.scanning" @click="library.root && library.scan(library.root)">
          <Icon name="refresh" :size="15" /> {{ library.scanning ? "Analyse en cours…" : "Rescanner" }}
        </button>
      </div>
      <p v-if="library.error" class="error">{{ library.error }}</p>
    </section>

    <section class="card">
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

    <section class="card">
      <h2><Icon name="lyrics" :size="17" /> Paroles</h2>
      <label class="toggle">
        <input type="checkbox" :checked="lyrics.allowOnline" @change="lyrics.setAllowOnline(($event.target as HTMLInputElement).checked)" />
        <span>Trouver automatiquement les paroles en ligne (LRCLIB)</span>
      </label>
      <p class="muted small">
        Utilisé seulement si le morceau n'a pas de paroles intégrées ni de fichier <code>.lrc</code> à côté de lui.
        Seuls le titre, l'artiste, l'album et la durée sont envoyés ; les résultats sont gardés en cache sur cet appareil.
      </p>
    </section>

    <section class="card">
      <h2>Raccourcis clavier</h2>
      <dl class="keys">
        <template v-for="[k, v] in shortcuts" :key="k">
          <dt><kbd>{{ k }}</kbd></dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>
    </section>

    <section class="card">
      <h2>À propos</h2>
      <p class="muted small">
        Music Player — lecteur de musique local : la plupart des formats audio (ffmpeg en appoint), paroles
        synchronisées, égaliseur. Vos fichiers ne quittent jamais votre ordinateur.
      </p>
      <button type="button" class="pill pill-ghost" @click="showLegal = true">Mentions légales et confidentialité</button>
    </section>

    <LegalDialog v-if="showLegal" @close="showLegal = false" />
  </div>
</template>

<style scoped>
.settings {
  max-width: 760px;
}
.card {
  margin-bottom: 16px;
  padding: 18px 20px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  box-shadow: inset 0 0 0 0.5px var(--separator);
}
h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 15px;
}
h2 :deep(svg) {
  color: var(--accent);
}
.path {
  margin: 0 0 2px;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 12.5px;
  word-break: break-all;
  user-select: text;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}
.pill:disabled {
  opacity: 0.45;
}
.error {
  color: #ff6b7d;
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
.toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13.5px;
}
.toggle input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
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
</style>
