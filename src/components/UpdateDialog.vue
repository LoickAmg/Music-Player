<script setup lang="ts">
import { computed } from "vue";
import { useUiStore } from "@/stores/ui";
import { useUpdaterStore } from "@/stores/updater";
import Icon from "./Icon.vue";

// Téléphone et tablette : la mise à jour est proposée dans une fenêtre centrée, lisible et
// facile à toucher sur tous les écrans (un bandeau en haut passait sous la barre d'état).
const updater = useUpdaterStore();
const ui = useUiStore();

const open = computed(() => ui.isMobile && !!updater.available && !updater.dismissed);
const percent = computed(() => (updater.progress === null ? null : Math.round(updater.progress * 100)));
</script>

<template>
  <Transition name="dialog">
    <div v-if="open && updater.available" class="update-scrim" @click.self="!updater.installing && (updater.dismissed = true)">
      <section class="update-card" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <span class="update-icon" aria-hidden="true"><Icon name="refresh" :size="26" /></span>
        <h2 id="update-title">Mise à jour disponible</h2>
        <p class="update-text">
          Music Player <strong>{{ updater.available.version }}</strong> est prête à être installée.
          <span class="update-current">Version actuelle : {{ updater.available.current }}</span>
        </p>

        <div v-if="updater.installing" class="update-progress" role="status">
          <div class="track" :class="{ indeterminate: percent === null }">
            <span :style="percent === null ? undefined : { transform: `scaleX(${percent / 100})` }" />
          </div>
          <p>Téléchargement… <template v-if="percent !== null">{{ percent }} %</template></p>
        </div>
        <p v-else-if="updater.message" class="update-message">{{ updater.message }}</p>

        <div class="update-actions">
          <button type="button" class="btn primary" :disabled="updater.installing" @click="updater.install()">
            {{ updater.installing ? "Téléchargement…" : "Mettre à jour" }}
          </button>
          <button type="button" class="btn secondary" :disabled="updater.installing" @click="updater.dismissed = true">Plus tard</button>
        </div>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.update-scrim {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: calc(var(--safe-top) + 20px) calc(var(--safe-right) + 20px) calc(var(--safe-bottom) + 20px)
    calc(var(--safe-left) + 20px);
  background: rgba(2, 6, 20, 0.72);
}
.update-card {
  width: min(100%, 380px);
  padding: 26px 22px 20px;
  border-radius: 22px;
  background: #0d2357;
  border: 1px solid rgba(120, 170, 255, 0.28);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  text-align: center;
}
.update-icon {
  display: inline-grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin-bottom: 12px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
}
h2 {
  margin: 0 0 8px;
  font-family: var(--font-display);
  font-size: 21px;
  font-weight: 800;
}
.update-text {
  margin: 0;
  color: rgba(230, 240, 255, 0.85);
  font-size: 15px;
  line-height: 1.5;
}
.update-current {
  display: block;
  margin-top: 4px;
  font-size: 13px;
  color: rgba(230, 240, 255, 0.55);
}
.update-message {
  margin: 14px 0 0;
  font-size: 14px;
  line-height: 1.45;
  color: #ffe2a8;
}
.update-progress {
  margin-top: 16px;
}
.update-progress p {
  margin: 8px 0 0;
  font-size: 13px;
  color: rgba(230, 240, 255, 0.75);
  font-variant-numeric: tabular-nums;
}
.track {
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.16);
  overflow: hidden;
}
.track span {
  display: block;
  height: 100%;
  background: var(--accent);
  transform-origin: left;
  transition: transform 0.2s linear;
}
.track.indeterminate span {
  width: 35%;
  animation: slide 1.1s ease-in-out infinite;
}
@keyframes slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}
.update-actions {
  display: grid;
  gap: 10px;
  margin-top: 22px;
}
.btn {
  min-height: 50px;
  border: 0;
  border-radius: 14px;
  font-size: 16px;
  font-weight: 700;
  -webkit-tap-highlight-color: transparent;
}
.btn:disabled {
  opacity: 0.6;
}
.btn.primary {
  background: var(--accent);
  color: #fff;
}
.btn.secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #e6f1ff;
}
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity 0.2s ease;
}
.dialog-enter-active .update-card,
.dialog-leave-active .update-card {
  transition: transform 0.25s cubic-bezier(0.2, 0.9, 0.25, 1);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .update-card,
.dialog-leave-to .update-card {
  transform: scale(0.94);
}
</style>
