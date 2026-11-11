<script setup lang="ts">
import { computed } from "vue";
import { useDevicesStore } from "@/stores/devices";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// Bandeau « un autre de vos appareils a des sons absents d'ici » : rien n'est copié tant que
// la personne ne le demande pas (Mes appareils). « Plus tard » : plus un mot jusqu'au prochain
// changement de la liste de cet appareil.
const devices = useDevicesStore();
const ui = useUiStore();
const notice = computed(() => (ui.route.name === "devices" ? null : devices.notice));
const sending = computed(() => devices.sending);
const sendCount = computed(() => sending.value.reduce((s, c) => s + c.tracks.length, 0));
</script>

<template>
  <Transition name="notice">
    <div v-if="sending.length" class="notice" role="status">
      <Icon name="share" :size="18" />
      <span class="text">
        <strong>Envoi de {{ sendCount }} son{{ sendCount > 1 ? "s" : "" }} vers {{ devices.nameOf(sending[0].from) }}</strong>
        <small>Demandé depuis {{ devices.nameOf(sending[0].from) }}.</small>
      </span>
      <button type="button" class="pill pill-ghost small" @click="ui.go({ name: 'devices' })">Détails</button>
      <button type="button" class="pill pill-danger small" @click="devices.stopSending(sending[0].from)">Arrêter</button>
    </div>
    <div v-else-if="notice" class="notice" role="status">
      <Icon :name="notice.device.platform === 'android' ? 'phone' : 'desktop'" :size="18" />
      <span class="text">
        <strong>{{ notice.device.name }} a {{ notice.count }} son{{ notice.count > 1 ? "s" : "" }} absent{{ notice.count > 1 ? "s" : "" }} d'ici</strong>
        <small>Rien n'est copié sans votre accord.</small>
      </span>
      <button type="button" class="pill pill-accent small" @click="ui.go({ name: 'devices' })">Voir</button>
      <button type="button" class="pill pill-ghost small" @click="devices.dismiss(notice.device.id)">Plus tard</button>
    </div>
  </Transition>
</template>

<style scoped>
.notice {
  position: fixed;
  left: 50%;
  bottom: calc(var(--safe-bottom) + var(--notice-offset, 96px));
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(560px, calc(100% - 24px));
  padding: 10px 10px 10px 14px;
  border-radius: 16px;
  background: rgb(var(--surface-rgb));
  border: 1px solid var(--separator);
  box-shadow: var(--shadow-lg);
  color: var(--text);
  transform: translateX(-50%);
}
.notice > :deep(svg) {
  flex: none;
  color: var(--accent);
}
.text {
  display: grid;
  flex: 1;
  min-width: 0;
}
.text strong {
  font-size: 13.5px;
}
.text small {
  font-size: 12px;
  color: var(--text-2);
}
.small {
  flex: none;
  padding: 6px 12px;
  font-size: 12.5px;
}
.notice-enter-active,
.notice-leave-active {
  transition: opacity 0.2s, transform 0.25s var(--ease);
}
.notice-enter-from,
.notice-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}
@media (max-width: 760px) {
  .notice {
    flex-wrap: wrap;
  }
  .text {
    flex-basis: calc(100% - 40px);
  }
}
</style>
