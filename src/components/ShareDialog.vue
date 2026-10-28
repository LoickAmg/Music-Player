<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/lib/api";
import { shareText } from "@/lib/androidMedia";
import { revealOrShare } from "@/lib/share";
import { useShareStore } from "@/stores/share";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";
import TransferRow from "./TransferRow.vue";

// Partager un morceau ou une playlist : à un appareil voisin (même Wi-Fi), à distance avec
// un code, ou par une autre application (fichier).
const share = useShareStore();
const ui = useUiStore();

const item = computed(() => share.sharing);
const code = ref<string | null>(null);
const codeBusy = ref(false);
const fileBusy = ref(false);
const copied = ref(false);

watch(item, () => {
  code.value = null;
  copied.value = false;
});

/** Transferts lancés pour ce qui est ouvert dans la fenêtre. */
const transfers = computed(() =>
  item.value ? share.transfers.filter((t) => t.direction === "envoi" && t.label === item.value!.name) : [],
);

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

async function createCode() {
  codeBusy.value = true;
  code.value = await share.sendRemote();
  codeBusy.value = false;
}

async function giveCode() {
  if (!code.value) return;
  const message = `Pour recevoir « ${item.value?.name} » dans Music Player : Réglages → Partage → Recevoir avec un code, puis saisir ${code.value}`;
  if (shareText(message)) return;
  try {
    await navigator.clipboard.writeText(code.value);
    copied.value = true;
  } catch {
    ui.notify("Copie impossible : notez le code à la main.");
  }
}

async function viaFile() {
  if (!item.value) return;
  fileBusy.value = true;
  try {
    const path =
      item.value.kind === "track"
        ? await api.exportTrack(item.value.id)
        : item.value.kind === "backup"
          ? await api.saveBackup(item.value.id, item.value.name)
          : await api.exportPlaylist(item.value.id);
    const problem = path ? await revealOrShare(path) : null;
    if (problem) ui.notify(problem);
  } catch (e) {
    ui.notify(`Partage impossible : ${e}`);
  } finally {
    fileBusy.value = false;
  }
}
</script>

<template>
  <Transition name="dialog">
    <div v-if="item" class="scrim" @click.self="share.close()">
      <section class="card" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <header>
          <div>
            <p class="kicker">{{ { track: "Partager ce morceau", playlist: "Partager cette playlist", backup: "Synchroniser avec un autre appareil" }[item.kind] }}</p>
            <h2 id="share-title">{{ item.name }}</h2>
          </div>
          <button type="button" class="icon-btn" aria-label="Fermer" @click="share.close()"><Icon name="close" :size="18" /></button>
        </header>

        <section class="block">
          <div class="block-head">
            <h3>À proximité</h3>
            <button type="button" class="link" :disabled="share.scanning" @click="share.scan()">
              {{ share.scanning ? "Recherche…" : "Actualiser" }}
            </button>
          </div>
          <p class="hint">Appareils avec Music Player ouvert sur le même Wi-Fi. La personne doit accepter l'envoi.</p>
          <div class="peers">
            <button v-for="peer in share.peers" :key="peer.id" type="button" class="peer" @click="share.sendNearby(peer)">
              <span class="avatar">{{ initial(peer.name) }}</span>
              <span class="peer-name">{{ peer.name }}</span>
              <Icon name="share" :size="15" />
            </button>
            <p v-if="share.scanning && !share.peers.length" class="empty"><span class="dots"><i /><i /><i /></span> Recherche des appareils…</p>
            <p v-else-if="share.scanError" class="empty">{{ share.scanError }}</p>
            <p v-else-if="!share.peers.length" class="empty">Aucun appareil trouvé. Ouvrez Music Player sur l'autre appareil, connecté au même Wi-Fi.</p>
          </div>
        </section>

        <section class="block">
          <h3>À distance, avec un code</h3>
          <p class="hint">Pour quelqu'un qui n'est pas sur le même réseau : donnez-lui le code, il le saisit dans Réglages → Partage. Le contenu est chiffré de bout en bout.</p>
          <p v-if="!share.relayInUse" class="hint warn">Aucun relais de partage n'est réglé : Réglages → Partage.</p>
          <template v-else>
            <div v-if="code" class="code-box">
              <span class="code" aria-label="Code de partage">{{ code }}</span>
              <button type="button" class="pill pill-ghost small" @click="giveCode">
                <Icon name="share" :size="14" /> {{ copied ? "Copié" : "Envoyer le code" }}
              </button>
            </div>
            <button v-else type="button" class="pill pill-accent" :disabled="codeBusy" @click="createCode">
              {{ codeBusy ? "Préparation…" : "Créer un code" }}
            </button>
          </template>
        </section>

        <section class="block">
          <h3>Autre application</h3>
          <p class="hint">Fichier {{ item.kind === "backup" ? ".mpsave" : ".mpshare" }} à envoyer par messagerie, e-mail, Bluetooth… puis à ouvrir avec Music Player.</p>
          <button type="button" class="pill pill-ghost" :disabled="fileBusy" @click="viaFile">
            <Icon name="share" :size="15" /> {{ fileBusy ? "Préparation…" : "Envoyer le fichier…" }}
          </button>
        </section>

        <section v-if="transfers.length" class="block transfers" aria-label="Envois en cours">
          <TransferRow v-for="t in transfers" :key="t.id" :transfer="t" />
        </section>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: calc(var(--safe-top) + 16px) calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 16px)
    calc(var(--safe-left) + 16px);
  background: rgba(2, 6, 20, 0.6);
}
.card {
  width: min(100%, 460px);
  max-height: 100%;
  overflow-y: auto;
  padding: 20px 20px 14px;
  border-radius: 18px;
  background: rgba(var(--surface-rgb), 0.98);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.12);
  color: var(--text);
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.kicker {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
h2 {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.block {
  padding: 14px 0;
  border-top: 1px solid var(--separator);
}
.block:first-of-type {
  border-top: 0;
}
.block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
.hint {
  margin: 4px 0 10px;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-2);
}
.hint.warn {
  color: #ffcf7a;
}
.link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
}
.link:disabled {
  color: var(--text-3);
}
.peers {
  display: grid;
  gap: 6px;
}
.peer {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 12px;
  background: rgba(var(--fg-rgb), 0.06);
  text-align: left;
  color: var(--accent);
}
.peer:hover {
  background: var(--bg-hover);
}
.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
}
.peer-name {
  flex: 1;
  min-width: 0;
  color: var(--text);
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0;
  font-size: 12.5px;
  color: var(--text-3);
}
.code-box {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.code {
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(var(--fg-rgb), 0.08);
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.02em;
  user-select: all;
}
.pill:disabled {
  opacity: 0.5;
}
.transfers {
  padding-top: 6px;
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
