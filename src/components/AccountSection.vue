<script setup lang="ts">
import { computed, ref } from "vue";
import { parseCode } from "@/lib/friendsApi";
import { useAccountStore } from "@/stores/account";
import { useFriendsStore } from "@/stores/friends";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// Réglages → Compte : sauvegarde en ligne chiffrée, retrouvée sur un autre appareil avec le
// code d'ami et le mot de passe.
const account = useAccountStore();
const friends = useFriendsStore();
const ui = useUiStore();

const mode = ref<"idle" | "create" | "login">("idle");
const password = ref("");
const confirm = ref("");
const loginCode = ref("");
const formError = ref<string | null>(null);

const last = computed(() => {
  const at = account.saved?.lastUpload;
  return at ? new Date(at).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "jamais";
});

async function create() {
  formError.value = null;
  if (password.value.length < 8) return void (formError.value = "8 caractères au moins.");
  if (password.value !== confirm.value) return void (formError.value = "Les deux mots de passe diffèrent.");
  if (await account.create(password.value)) {
    ui.notify("Compte prêt : sauvegarde envoyée");
    reset();
  }
}

async function login() {
  formError.value = null;
  const code = parseCode(loginCode.value);
  if (!code) return void (formError.value = "Un code a 8 caractères, par exemple K7QM-2D9X.");
  const json = await account.login(code, password.value);
  if (json) {
    // Restauration proposée dans « Sauvegarde », juste en dessous (rien n'est appliqué d'office).
    ui.backupToRestore = json;
    reset();
  }
}

function reset() {
  mode.value = "idle";
  password.value = "";
  confirm.value = "";
  loginCode.value = "";
}
</script>

<template>
  <section class="section-card">
    <h2><Icon name="user" :size="17" /> Compte</h2>
    <template v-if="account.connected">
      <p class="muted">
        Compte <strong class="code">{{ account.saved!.code }}</strong> · sauvegarde en ligne chiffrée, mise à jour chaque
        jour. Dernière : {{ last }}.
      </p>
      <div v-if="mode === 'idle'" class="actions">
        <button type="button" class="pill pill-accent" :disabled="account.busy" @click="account.uploadNow()">
          <Icon name="refresh" :size="15" /> {{ account.busy ? "Envoi…" : "Sauvegarder maintenant" }}
        </button>
        <button type="button" class="pill pill-ghost" @click="mode = 'create'">Changer le mot de passe</button>
        <button type="button" class="pill pill-ghost" @click="account.logout()">Se déconnecter de cet appareil</button>
      </div>
      <p v-if="mode === 'idle' && account.error" class="error">{{ account.error }}</p>
    </template>
    <template v-else>
      <p class="muted">
        Sans e-mail : votre code d'ami et un mot de passe. Avantages : vos playlists, titres aimés, écoute, réglages et
        proches sauvegardés en ligne chaque jour, chiffrés sur l'appareil, et retrouvés sur un nouveau téléphone ou PC.
      </p>
      <div v-if="mode === 'idle'" class="actions">
        <button type="button" class="pill pill-accent" @click="mode = 'create'">Créer mon compte</button>
        <button type="button" class="pill pill-ghost" @click="mode = 'login'">J'ai déjà un compte</button>
      </div>
    </template>

    <form v-if="mode !== 'idle'" class="form" @submit.prevent="mode === 'login' ? login() : create()">
      <label v-if="mode === 'login'" class="field">
        <span>Code d'ami du compte</span>
        <input v-model="loginCode" class="fieldbox" placeholder="K7QM-2D9X" autocapitalize="characters" spellcheck="false" />
      </label>
      <p v-else-if="friends.me" class="muted small">
        Code du compte : <strong class="code">{{ friends.me.code }}</strong> (votre code d'ami)
      </p>
      <label class="field">
        <span>{{ mode === "login" ? "Mot de passe" : "Mot de passe (8 caractères au moins)" }}</span>
        <input v-model="password" class="fieldbox" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" />
      </label>
      <label v-if="mode === 'create'" class="field">
        <span>Confirmer le mot de passe</span>
        <input v-model="confirm" class="fieldbox" type="password" autocomplete="new-password" />
      </label>
      <p v-if="mode === 'create'" class="muted small">
        Gardez-le bien : il chiffre votre sauvegarde, personne (pas même le relais) ne peut la lire ni la récupérer sans
        lui.
      </p>
      <p v-if="formError || account.error" class="error">{{ formError || account.error }}</p>
      <div class="actions">
        <button type="button" class="pill pill-ghost" @click="reset">Annuler</button>
        <button type="submit" class="pill pill-accent" :disabled="account.busy">
          {{ account.busy ? "Patientez…" : mode === "login" ? "Récupérer ma sauvegarde" : "Valider" }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.code {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 420px;
  margin-top: var(--space-3);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
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
  margin: 0;
  font-size: 12px;
}
.error {
  margin: 0;
  color: var(--danger-text);
  font-size: 13px;
}
</style>
