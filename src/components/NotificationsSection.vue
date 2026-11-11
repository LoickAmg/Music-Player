<script setup lang="ts">
import { ref } from "vue";
import { ALERT_KINDS, type AlertKind, alertSettings, setAlert } from "@/lib/alerts";
import { notify } from "@/lib/notify";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// Réglages des notifications : un interrupteur par type, et un essai pour vérifier que le système
// les laisse passer (autorisation, mode « Ne pas déranger »…).
const ui = useUiStore();
const settings = ref(alertSettings());
const onAndroid = /Android/i.test(navigator.userAgent);
/** Android : notifications instantanées appli fermée (service discret, notification permanente). */
const INSTANT_KEY = "mp:notifs-instantanees";
const instantAvailable = typeof window !== "undefined" && typeof window.AndroidProches?.instant === "function";
const instant = ref(readInstant());
function readInstant(): boolean {
  try {
    return localStorage.getItem(INSTANT_KEY) === "1";
  } catch {
    return false;
  }
}
function setInstant(on: boolean) {
  instant.value = on;
  try {
    localStorage.setItem(INSTANT_KEY, on ? "1" : "0");
  } catch {
    // réglage valable pour la session
  }
  window.AndroidProches?.instant?.(on);
  ui.notify(on ? "Notifications instantanées activées : messages et sons arrivent même appli fermée." : "Notifications instantanées désactivées.");
}

function toggle(kind: AlertKind, on: boolean) {
  setAlert(kind, on);
  settings.value = alertSettings();
}
async function test() {
  const ok = await notify("Music Player", "Les notifications fonctionnent sur cet appareil.");
  ui.notify(ok ? "Notification envoyée : regardez le volet des notifications." : "Notifications refusées : autorisez-les dans les réglages du système.");
}
</script>

<template>
  <section class="section-card">
    <h2><Icon name="lyrics" :size="17" /> Notifications</h2>
    <p class="muted">
      Appli sous vos yeux : une bannière en bas de l'écran. Appli réduite, derrière une autre fenêtre ou téléphone ailleurs : une notification du
      système. Pendant un transfert, l'avancement s'affiche aussi {{ onAndroid ? "dans le volet des notifications" : "sur l'icône de la barre des tâches" }}.
    </p>
    <label v-for="k in ALERT_KINDS" :key="k.id" class="toggle row">
      <input type="checkbox" :checked="settings[k.id]" @change="toggle(k.id, ($event.target as HTMLInputElement).checked)" />
      <span>
        <strong>{{ k.label }}</strong>
        <small class="muted">{{ k.hint }}</small>
      </span>
    </label>
    <label v-if="onAndroid" class="toggle row">
      <input type="checkbox" :checked="instant" :disabled="!instantAvailable" @change="setInstant(($event.target as HTMLInputElement).checked)" />
      <span>
        <strong>Notifications instantanées, appli fermée</strong>
        <small class="muted">
          Sans elles, Android ne vérifie les messages que de temps en temps (parfois des heures sur certains téléphones). Activées, un service discret
          vérifie chaque minute, signalé par une petite notification permanente. Un peu plus de batterie.
          <template v-if="!instantAvailable"> Disponible après la mise à jour de l'appli.</template>
        </small>
      </span>
    </label>
    <div class="actions">
      <button type="button" class="pill pill-ghost" @click="test">Essayer une notification</button>
    </div>
  </section>
</template>

<style scoped>
.row {
  align-items: flex-start;
  margin-top: 10px;
}
.row span {
  display: grid;
  gap: 2px;
}
.row small {
  font-size: 12.5px;
}
.actions {
  margin-top: 14px;
}
</style>
