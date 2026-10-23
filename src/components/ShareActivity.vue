<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { formatBytes } from "@/lib/format";
import { usePlaylistsStore } from "@/stores/playlists";
import { useShareStore, type Transfer } from "@/stores/share";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";
import TransferRow from "./TransferRow.vue";

// Réception : envoi proposé par un appareil voisin (accepter ou refuser), réception avec un
// code, et suivi des transferts en cours quand la fenêtre « Partager » est fermée.
const share = useShareStore();
const playlists = usePlaylistsStore();
const ui = useUiStore();

const offer = computed(() => share.offers[0] ?? null);
const offerText = computed(() => {
  const o = offer.value?.offer;
  if (!o) return "";
  const what = o.kind === "playlist" ? `la playlist « ${o.name} » (${o.tracks} morceau${o.tracks > 1 ? "x" : ""})` : `le morceau « ${o.name} »`;
  return `${o.from} veut vous envoyer ${what}, ${formatBytes(o.size)}.`;
});

const code = ref("");
const input = ref<HTMLInputElement | null>(null);
const current = ref<Transfer | null>(null);
watch(
  () => share.receiving,
  async (open) => {
    if (!open) return;
    code.value = "";
    current.value = null;
    await nextTick();
    input.value?.focus();
  },
);
const busy = computed(() => !!current.value && ["attente", "reception"].includes(current.value.progress.stage));

async function receive() {
  if (!code.value.trim() || busy.value) return;
  const pending = share.receiveRemote(code.value);
  // Suivi dès le début (la réception attend l'expéditeur puis télécharge).
  await nextTick();
  current.value = share.transfers[0] ?? null;
  current.value = await pending;
  if (current.value.result) await playlists.fetchAll();
}

function openResult(t: Transfer) {
  if (t.result?.playlist_id) ui.go({ name: "playlist", id: t.result.playlist_id });
  else ui.go({ name: "recent" });
  share.receiving = false;
}

/** Transferts montrés en bas de l'écran : ceux qui ne sont pas dans une fenêtre ouverte. */
const floating = computed(() =>
  share.sharing || share.receiving ? [] : share.transfers.filter((t) => t.progress.stage !== "fini" || t.direction === "reception").slice(0, 3),
);

// Réception terminée (voisin) : playlists à jour.
watch(
  () => share.transfers.map((t) => t.progress.stage).join(),
  () => {
    if (share.transfers.some((t) => t.direction === "reception" && t.progress.stage === "fini")) void playlists.fetchAll();
  },
);
</script>

<template>
  <Transition name="dialog">
    <div v-if="offer" class="scrim">
      <section class="card offer" role="alertdialog" aria-modal="true" aria-labelledby="offer-title">
        <span class="badge" aria-hidden="true"><Icon name="import" :size="24" /></span>
        <h2 id="offer-title">Partage reçu</h2>
        <p class="text">{{ offerText }}</p>
        <p class="hint">Les morceaux seront ajoutés à votre bibliothèque.</p>
        <div class="actions">
          <button type="button" class="pill pill-ghost" @click="share.answer(offer.id, false)">Refuser</button>
          <button type="button" class="pill pill-accent" @click="share.answer(offer.id, true)">Accepter</button>
        </div>
      </section>
    </div>
  </Transition>

  <Transition name="dialog">
    <div v-if="share.receiving" class="scrim" @click.self="!busy && (share.receiving = false)">
      <section class="card" role="dialog" aria-modal="true" aria-labelledby="receive-title">
        <header>
          <h2 id="receive-title">Recevoir avec un code</h2>
          <button type="button" class="icon-btn" aria-label="Fermer" @click="share.receiving = false"><Icon name="close" :size="18" /></button>
        </header>
        <p class="hint">Saisissez le code donné par la personne qui partage, par exemple 4821-soleil-guitare.</p>
        <form class="code-form" @submit.prevent="receive">
          <input
            ref="input"
            v-model="code"
            class="code-input fieldbox"
            type="text"
            inputmode="text"
            autocapitalize="none"
            autocomplete="off"
            spellcheck="false"
            placeholder="4821-soleil-guitare"
            aria-label="Code de partage"
            :disabled="busy"
          />
          <button type="submit" class="pill pill-accent" :disabled="busy || !code.trim()">Recevoir</button>
        </form>
        <p v-if="!share.relayInUse" class="hint warn">Aucun relais de partage n'est réglé : Réglages → Partage.</p>
        <TransferRow v-if="current" :transfer="current" />
        <div v-if="current?.result" class="actions">
          <button type="button" class="pill pill-accent" @click="openResult(current)">
            {{ current.result.playlist_id ? "Ouvrir la playlist" : "Voir les ajouts récents" }}
          </button>
        </div>
      </section>
    </div>
  </Transition>

  <div v-if="floating.length" class="floating" aria-live="polite">
    <TransferRow v-for="t in floating" :key="t.id" :transfer="t" />
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: grid;
  place-items: center;
  padding: calc(var(--safe-top) + 16px) calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 16px)
    calc(var(--safe-left) + 16px);
  background: rgba(2, 6, 20, 0.6);
}
.card {
  width: min(100%, 420px);
  padding: 20px;
  border-radius: 18px;
  background: rgba(var(--surface-rgb), 0.98);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.12);
  color: var(--text);
}
.card.offer {
  text-align: center;
}
.badge {
  display: inline-grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: 10px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
}
.text {
  margin: 8px 0 0;
  font-size: 15px;
  line-height: 1.5;
}
.hint {
  margin: 8px 0 12px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-2);
}
.hint.warn {
  color: #ffcf7a;
}
.actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 16px;
}
.code-form {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}
.code-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: 10px;
  background: rgba(var(--fg-rgb), 0.08);
  font-size: 16px;
  font-weight: 600;
}
.pill:disabled {
  opacity: 0.5;
}
.floating {
  position: fixed;
  right: calc(var(--safe-right) + 16px);
  bottom: calc(var(--safe-bottom) + 96px);
  z-index: 70;
  width: min(340px, calc(100vw - 32px));
  padding: 4px 12px;
  border-radius: 14px;
  background: rgba(var(--surface-rgb), 0.96);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.12);
  backdrop-filter: blur(20px);
}
@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .floating {
    left: calc(var(--safe-left) + 12px);
    right: calc(var(--safe-right) + 12px);
    width: auto;
    bottom: calc(var(--safe-bottom) + 150px);
  }
}
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity 0.2s ease;
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
</style>
