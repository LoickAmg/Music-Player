<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{
  (e: "close"): void;
}>();

type SectionId = "mentions" | "confidentialite" | "contact";

const contactEmail = "contact@exemple.fr";

const sections: { id: SectionId; label: string; title: string }[] = [
  { id: "mentions", label: "Mentions légales", title: "Mentions légales" },
  { id: "confidentialite", label: "Confidentialité", title: "Politique de confidentialité (RGPD)" },
  { id: "contact", label: "Contact", title: "Contact" },
];

const active = ref<SectionId>("mentions");
</script>

<template>
  <div class="overlay" role="presentation" @click.self="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="Informations légales">
      <header class="dialog-header">
        <h2>Informations légales</h2>
        <button class="icon" type="button" title="Fermer" aria-label="Fermer" @click="emit('close')">✕</button>
      </header>

      <nav class="tabs" aria-label="Sections légales">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          class="tab"
          :class="{ 'tab-active': active === section.id }"
          @click="active = section.id"
        >
          {{ section.label }}
        </button>
      </nav>

      <div class="dialog-body">
        <div v-if="active === 'mentions'" class="section">
          <p class="lead">Ce logiciel de bureau est édité par :</p>
          <ul>
            <li><strong>Éditeur :</strong> [À compléter]</li>
            <li><strong>Adresse postale :</strong> [À compléter]</li>
            <li><strong>Directeur de la publication :</strong> [À compléter]</li>
          </ul>
          <h3>Hébergement</h3>
          <p>Application de bureau Tauri diffusée librement ; aucune donnée d’utilisation n’est transmise à un tiers.</p>
          <h3>Propriété intellectuelle</h3>
          <p>Le code source est distribué sous licence MIT. Toute reproduction, même partielle, sans autorisation préalable est interdite pour les éléments non couverts par cette licence.</p>
        </div>

        <div v-else-if="active === 'confidentialite'" class="section">
          <h3>Données traitées</h3>
          <p>Le logiciel fonctionne entièrement en local : aucune donnée personnelle n’est collectée, aucun compte n’est requis, aucun cookie de suivi ni outil d’analyse tiers n’est utilisé.</p>
          <h3>Base légale</h3>
          <p>Aucun traitement de données personnelles n’est réalisé. Les fichiers audio scannés restent sur votre machine et ne sont jamais transmis.</p>
          <h3>Conservation</h3>
          <p>Sans collecte de données personnelles, aucune durée de conservation ne s’applique.</p>
          <h3>Responsable de traitement</h3>
          <p>[À compléter] — nom et coordonnées du responsable de traitement.</p>
        </div>

        <div v-else class="section">
          <p>Une question, une remarque ou une suggestion ? Écrivez-nous à l’adresse suivante :</p>
          <p class="email"><a :href="`mailto:${contactEmail}`">{{ contactEmail }}</a></p>
          <p>Nous répondons généralement sous quelques jours ouvrés.</p>
        </div>
      </div>

      <footer class="dialog-footer">
        <span>© {{ new Date().getFullYear() }} Music Player</span>
        <span class="dim">[À compléter] avant distribution.</span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 1.5em;
}

.dialog {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(640px, 100%);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1em 1.25em;
  border-bottom: 1px solid var(--border);
}

.dialog-header h2 {
  font-size: 1em;
  margin: 0;
  font-weight: 600;
}

.tabs {
  display: flex;
  gap: 0.4em;
  padding: 0.75em 1.25em 0;
}

.tab {
  font-size: 0.82em;
  padding: 0.45em 0.8em;
  border-bottom: none;
  border-radius: var(--radius) var(--radius) 0 0;
  background: transparent;
  color: var(--text-dim);
}

.tab:hover {
  color: var(--text);
  border-color: var(--border);
}

.tab-active {
  background: var(--bg);
  color: var(--accent);
  border-color: var(--border);
}

.dialog-body {
  padding: 1.1em 1.25em;
  overflow-y: auto;
  font-size: 0.85em;
  line-height: 1.6;
}

.section .lead {
  margin-top: 0;
}

.section ul {
  margin: 0.5em 0;
  padding-left: 1.1em;
}

.section h3 {
  font-size: 0.92em;
  margin: 1em 0 0.35em;
  color: var(--text);
}

.section p {
  color: var(--text);
}

.section .email {
  font-weight: 600;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75em 1.25em;
  border-top: 1px solid var(--border);
  font-size: 0.75em;
  color: var(--text-dim);
}
</style>
