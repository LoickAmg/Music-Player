<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{
  (e: "close"): void;
}>();

type SectionId = "mentions" | "confidentialite" | "contact";

const contactEmail = "mahounaamg@gmail.com";

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
          <p class="lead">Cette application est éditée par :</p>
          <ul>
            <li><strong>Éditeur :</strong> Mahouna (particulier, projet non commercial)</li>
            <li><strong>Directeur de la publication :</strong> Mahouna</li>
            <li><strong>Contact :</strong> {{ contactEmail }}</li>
          </ul>
          <h3>Hébergement</h3>
          <p>Application installée et exécutée sur votre appareil. Le relais qui sert au partage à distance, aux Proches, à la synchronisation et aux avis est hébergé par Cloudflare, Inc. (San Francisco, États-Unis). Le code source est publié sur GitHub (GitHub, Inc., San Francisco, États-Unis).</p>
          <h3>Propriété intellectuelle</h3>
          <p>Le code source est distribué sous licence MIT.</p>
        </div>

        <div v-else-if="active === 'confidentialite'" class="section">
          <h3>En résumé</h3>
          <p>Aucun cookie de suivi, aucun outil d’analyse, aucune publicité. Votre musique reste sur votre appareil, sauf quand vous choisissez de la partager. Sans Proches ni appareils liés, rien de personnel n’est envoyé.</p>
          <h3>Recherche de paroles</h3>
          <p>Envoie au service LRCLIB (lrclib.net) le titre, l’artiste, l’album et la durée du morceau écouté, et, si LRCLIB ne trouve rien, le titre et l’artiste au service de secours lyrics.ovh. Vous pouvez la couper dans Réglages → Paroles.</p>
          <h3>Partage</h3>
          <p>À proximité : envoi direct sur votre réseau Wi-Fi, non chiffré, après accord de la personne qui reçoit ; votre nom de profil y est visible des autres appareils (vous pouvez le masquer dans Réglages → Partage). À distance, avec un code : le contenu passe par le relais, chiffré de bout en bout, sans y être conservé.</p>
          <h3>Proches</h3>
          <p>Sur option. Le relais garde votre code d’ami, votre nom, votre photo, votre clé publique, les empreintes des jetons de vos proches et, le temps de les transmettre, vos demandes d’ajout. Ce que vous écoutez (titre, artiste, album) y reste une heure au plus et n’est lisible que par vos proches, si vous le partagez. Les messages sont chiffrés de bout en bout quand les deux appareils sont à jour, et gardés 60 jours pour vos autres appareils. Sur option aussi, votre nom et votre code peuvent être visibles des personnes de votre ville, d’après votre adresse IP (jamais votre position GPS), 10 minutes par annonce.</p>
          <h3>Appareils liés</h3>
          <p>Sur option. Playlists, titres aimés et historique d’écoute sont chiffrés sur vos appareils avant d’être gardés par le relais, qui ne peut pas les lire.</p>
          <h3>« Un avis ? »</h3>
          <p>Votre message, vos captures, et si vous les donnez votre nom et votre e-mail, avec la version de l’appli, le modèle de l’appareil et la version de son navigateur intégré. Une empreinte de votre adresse IP limite les envois abusifs pendant une heure. Les avis sont gardés jusqu’à leur traitement (les 500 plus récents au plus) et lus uniquement par l’éditeur.</p>
          <h3>Base légale et conservation</h3>
          <p>Votre consentement pour les options ci-dessus, que vous pouvez retirer à tout moment. Un profil inactif pendant un an est effacé. Les pochettes et paroles trouvées restent dans le dossier de l’application, sur votre appareil.</p>
          <h3>Vos droits</h3>
          <p>Réglages → Appareils liés → « Effacer mes données du relais » supprime aussitôt votre profil et tout ce qui s’y rattache. Pour un avis, ou pour exercer vos droits d’accès, de rectification ou d’effacement, écrivez à l’adresse ci-dessous. Vous pouvez aussi saisir la CNIL (cnil.fr). Cloudflare et les services de paroles peuvent traiter ces données hors de l’Union européenne.</p>
          <h3>Responsable de traitement</h3>
          <p>Mahouna — {{ contactEmail }}.</p>
        </div>

        <div v-else class="section">
          <p>Une question, une remarque ou une suggestion ? Écrivez à :</p>
          <p class="email"><a :href="`mailto:${contactEmail}`">{{ contactEmail }}</a></p>
          <p>Réponse généralement sous quelques jours.</p>
        </div>
      </div>

      <footer class="dialog-footer">
        <span>© {{ new Date().getFullYear() }} Music Player</span>
        <span class="dim">Licence MIT</span>
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
