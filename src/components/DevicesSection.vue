<script setup lang="ts">
import { computed, ref } from "vue";
import { useFriendsStore } from "@/stores/friends";
import { useShareStore } from "@/stores/share";
import { useSyncStore } from "@/stores/sync";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// Réglages → Appareils liés : playlists, titres aimés et écoute identiques d'un appareil à
// l'autre, sans compte. On relie les appareils une fois, avec un code de partage.
const sync = useSyncStore();
const friends = useFriendsStore();
const share = useShareStore();
const ui = useUiStore();

const mode = ref<"idle" | "give" | "enter" | "leave" | "erase">("idle");
const code = ref("");

const last = computed(() => {
  const at = sync.saved?.lastSync;
  return at ? new Date(at).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "pas encore";
});
/** Avancement de la liaison en cours (l'autre appareil a-t-il saisi le code ?). */
const linking = computed(() => share.transfers.find((t) => t.direction === "envoi" && t.code === sync.linkCode && !!sync.linkCode) ?? null);
const linkDone = computed(() => linking.value?.progress.stage === "fini");
/** Cet appareil a déjà un autre profil Proches, qu'accepter le lien remplacerait. */
const replaces = computed(() => {
  const link = sync.pendingLink;
  return !!link && !!friends.me && friends.me.code !== link.proches.me.code && (friends.friends.length > 0 || friends.enabled);
});

async function give() {
  mode.value = "give";
  await sync.startLink();
}
async function enter() {
  if (!code.value.trim()) return;
  await sync.receiveLink(code.value);
  code.value = "";
  mode.value = "idle";
}
async function copy() {
  if (!sync.linkCode) return;
  try {
    await navigator.clipboard.writeText(sync.linkCode);
    ui.notify("Code copié");
  } catch {
    ui.notify("Copie impossible : notez le code à la main.");
  }
}
async function erase() {
  if (await sync.eraseEverything()) {
    mode.value = "idle";
    ui.notify("Vos données ont été effacées du relais");
  }
}
function leave() {
  sync.unlink();
  mode.value = "idle";
  ui.notify("Cet appareil n'est plus lié");
}
</script>

<template>
  <section class="section-card">
    <h2><Icon name="refresh" :size="17" /> Appareils liés</h2>
    <p v-if="sync.linked" class="muted">
      Vos playlists, titres aimés et écoute restent identiques sur vos appareils liés, suppressions comprises. Dernière synchronisation :
      {{ last }}.
    </p>
    <p v-else class="muted">
      Reliez votre PC et votre téléphone une fois : playlists, titres aimés et écoute se synchronisent ensuite tout seuls, sans compte ni mot de
      passe. Vos proches et vos conversations vous suivent aussi. Tout est chiffré sur vos appareils : le relais n'y a pas accès.
    </p>

    <p v-if="sync.relinkFrom && !sync.linked" class="notice">
      Cet appareil était connecté au compte <strong>{{ sync.relinkFrom }}</strong>. Pour le garder synchronisé, sur l'appareil qui a ce code d'ami :
      Réglages → Appareils liés → « Lier un autre appareil », puis ici « Relier cet appareil ».
    </p>

    <div v-if="sync.pendingLink" class="ask">
      <p>
        <strong>Lier cet appareil à « {{ sync.pendingLink.from }} » ?</strong> Vos playlists et titres aimés seront réunis avec les siens.
      </p>
      <p v-if="replaces" class="warn">
        Cet appareil a déjà un profil Proches ({{ friends.friends.length }} proche{{ friends.friends.length > 1 ? "s" : "" }}) : il sera remplacé
        définitivement par celui de « {{ sync.pendingLink.from }} ».
      </p>
      <div class="actions">
        <button type="button" class="pill pill-accent" @click="sync.confirmLink()">Lier cet appareil</button>
        <button type="button" class="pill pill-ghost" @click="sync.cancelLink()">Annuler</button>
      </div>
    </div>

    <div v-else-if="sync.held !== null" class="ask">
      <p>
        <strong>{{ sync.held }} éléments seraient retirés de cet appareil.</strong> Cela ressemble à une suppression faite sur un autre appareil, mais
        c'est beaucoup d'un coup : rien n'a été retiré pour l'instant.
      </p>
      <div class="actions">
        <button type="button" class="pill pill-accent" :disabled="sync.running" @click="sync.run('garder')">Tout garder</button>
        <button type="button" class="pill pill-danger" :disabled="sync.running" @click="sync.run('appliquer')">Les retirer</button>
      </div>
    </div>

    <div v-else-if="mode === 'give'" class="ask">
      <p v-if="sync.linkBusy" class="muted">Préparation du code…</p>
      <template v-else-if="linkDone">
        <p><strong>L'autre appareil a bien reçu le lien.</strong> Il reste à le confirmer dessus.</p>
        <div class="actions"><button type="button" class="pill pill-ghost" @click="mode = 'idle'">Terminé</button></div>
      </template>
      <template v-else-if="sync.linkCode">
        <p>Sur l'autre appareil : Réglages → Appareils liés → « Relier cet appareil », puis saisissez ce code.</p>
        <div class="code-row">
          <strong class="code" aria-label="Code de liaison">{{ sync.linkCode }}</strong>
          <button type="button" class="pill pill-ghost" @click="copy">Copier</button>
        </div>
        <p class="muted small">Il donne accès à vos données : ne le transmettez à personne d'autre. Il expire au bout de 15 minutes.</p>
        <div class="actions"><button type="button" class="pill pill-ghost" @click="mode = 'idle'">Fermer</button></div>
      </template>
      <div v-else class="actions"><button type="button" class="pill pill-ghost" @click="mode = 'idle'">Fermer</button></div>
    </div>

    <form v-else-if="mode === 'enter'" class="ask" @submit.prevent="enter">
      <label class="field">
        <span>Code affiché sur l'autre appareil</span>
        <input v-model="code" class="fieldbox" placeholder="4821-soleil-guitare" autocapitalize="off" spellcheck="false" />
      </label>
      <div class="actions">
        <button type="submit" class="pill pill-accent" :disabled="sync.linkBusy">{{ sync.linkBusy ? "Réception…" : "Relier" }}</button>
        <button type="button" class="pill pill-ghost" @click="mode = 'idle'">Annuler</button>
      </div>
    </form>

    <div v-else-if="mode === 'leave'" class="ask">
      <p>
        <strong>Délier cet appareil ?</strong> Il cesse de se synchroniser et oublie votre profil Proches et vos conversations. Vos autres appareils les
        gardent ; s'il n'y en a pas, ils sont perdus. Vos playlists et titres aimés restent ici.
      </p>
      <div class="actions">
        <button type="button" class="pill pill-danger" @click="leave">Délier cet appareil</button>
        <button type="button" class="pill pill-ghost" @click="mode = 'idle'">Annuler</button>
      </div>
    </div>

    <div v-else-if="mode === 'erase'" class="ask">
      <p>
        <strong>Effacer vos données du relais ?</strong> Votre profil, votre code d'ami, vos conversations et l'état synchronisé sont supprimés
        définitivement, pour tous vos appareils liés. Vos proches sont prévenus. Vos playlists et titres aimés restent sur vos appareils.
      </p>
      <div class="actions">
        <button type="button" class="pill pill-danger" @click="erase">Tout effacer</button>
        <button type="button" class="pill pill-ghost" @click="mode = 'idle'">Annuler</button>
      </div>
    </div>

    <div v-else class="actions">
      <button v-if="sync.linked" type="button" class="pill pill-accent" :disabled="sync.running" @click="sync.run()">
        <Icon name="refresh" :size="15" /> {{ sync.running ? "Synchronisation…" : "Synchroniser maintenant" }}
      </button>
      <button type="button" class="pill" :class="sync.linked ? 'pill-ghost' : 'pill-accent'" :disabled="sync.linkBusy || !share.relayInUse" @click="give">Lier un autre appareil</button>
      <button v-if="!sync.linked" type="button" class="pill pill-ghost" :disabled="!share.relayInUse" @click="mode = 'enter'">Relier cet appareil</button>
      <button v-if="sync.linked" type="button" class="pill pill-ghost" @click="mode = 'leave'">Délier cet appareil</button>
      <button v-if="friends.me" type="button" class="pill pill-ghost" @click="mode = 'erase'">Effacer mes données du relais</button>
    </div>
    <p v-if="sync.error" class="error">{{ sync.error }}</p>
  </section>
</template>

<style scoped>
.ask {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}
.ask p {
  margin: 0;
}
.notice {
  margin: var(--space-3) 0 0;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  font-size: 13px;
}
.warn {
  color: var(--danger-text);
  font-size: 13px;
}
.code-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.code {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  overflow-wrap: anywhere;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 420px;
  font-size: 13px;
  font-weight: 600;
}
.field input {
  height: 36px;
  padding: 0 11px;
  border: 0;
  border-radius: var(--radius-sm);
  background: rgba(var(--fg-rgb), 0.07);
  font-size: 14px;
  font-weight: 400;
}
.small {
  font-size: 12px;
}
.error {
  margin: var(--space-3) 0 0;
  color: var(--danger-text);
  font-size: 13px;
}
</style>
