<script setup lang="ts">
import { ref } from "vue";
import { useAvisStore } from "@/stores/avis";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// Réglages, tout en bas : accès administrateur (avis reçus), discret pour les utilisateurs.
const avis = useAvisStore();
const ui = useUiStore();
const open = ref(false);
const code = ref("");

async function login() {
  if (await avis.login(code.value)) {
    code.value = "";
    open.value = false;
    ui.go({ name: "avis" });
  }
}
</script>

<template>
  <div class="admin">
    <template v-if="avis.isAdmin">
      <button type="button" class="pill pill-ghost" @click="ui.go({ name: 'avis' })">
        <Icon name="lyrics" :size="15" /> Avis reçus<template v-if="avis.fresh"> · {{ avis.fresh }} nouveau{{ avis.fresh > 1 ? "x" : "" }}</template>
      </button>
      <button type="button" class="link" @click="avis.logout()">Quitter l'accès administrateur</button>
    </template>
    <template v-else>
      <button v-if="!open" type="button" class="link" @click="open = true">Accès administrateur</button>
      <form v-else class="form" @submit.prevent="login">
        <input v-model="code" class="fieldbox" type="password" placeholder="Code administrateur" aria-label="Code administrateur" autocomplete="off" />
        <button type="submit" class="pill pill-accent">Valider</button>
        <button type="button" class="link" @click="open = false">Annuler</button>
      </form>
      <p v-if="avis.error" class="error">{{ avis.error }}</p>
    </template>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-5) 0 var(--space-4);
}
.form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.form input {
  height: 34px;
  padding: 0 11px;
  border: 0;
  border-radius: var(--radius-sm);
  background: rgba(var(--fg-rgb), 0.07);
}
.link {
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: 12px;
}
.error {
  width: 100%;
  margin: 0;
  color: var(--danger-text);
  font-size: 12.5px;
}
</style>
