<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { AvisItem } from "@/lib/friendsApi";
import { AVIS_KINDS, useAvisStore } from "@/stores/avis";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";

// Avis reçus (administrateur) : lus, classés, captures affichées à la demande.
const avis = useAvisStore();
const ui = useUiStore();
const filter = ref<"nouveau" | "tous">("nouveau");
const shots = reactive<Record<string, (string | null)[]>>({});
const zoomed = ref<string | null>(null);

onMounted(() => void avis.load());

const shown = computed(() => (filter.value === "tous" ? avis.items : avis.items.filter((a) => a.statut === "nouveau")));
const when = (at: number) => new Date(at).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const STATUS: Record<AvisItem["statut"], string> = { nouveau: "Nouveau", lu: "Lu", traite: "Traité" };

async function showShots(a: AvisItem) {
  shots[a.id] = await Promise.all(Array.from({ length: a.images }, (_, n) => avis.image(a.id, n)));
}
async function remove(a: AvisItem) {
  await avis.remove(a);
  ui.notify("Avis supprimé");
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Avis reçus</h1>
    <p class="page-sub">{{ avis.fresh }} nouveau{{ avis.fresh > 1 ? "x" : "" }} · {{ avis.items.length }} en tout</p>

    <div class="top">
      <div class="chips" role="tablist">
        <button type="button" role="tab" :aria-selected="filter === 'nouveau'" :class="{ on: filter === 'nouveau' }" @click="filter = 'nouveau'">Nouveaux</button>
        <button type="button" role="tab" :aria-selected="filter === 'tous'" :class="{ on: filter === 'tous' }" @click="filter = 'tous'">Tous</button>
      </div>
      <button type="button" class="pill pill-ghost" :disabled="avis.loading" @click="avis.load()">
        <Icon name="refresh" :size="15" /> {{ avis.loading ? "Chargement…" : "Actualiser" }}
      </button>
    </div>
    <p v-if="avis.error" class="error">{{ avis.error }}</p>
    <p v-if="!shown.length && !avis.loading" class="muted">{{ filter === "nouveau" ? "Aucun nouvel avis." : "Aucun avis pour l'instant." }}</p>

    <article v-for="a in shown" :key="a.id" class="avis" :class="a.statut">
      <header>
        <span class="kind">{{ AVIS_KINDS[a.kind] }}</span>
        <span class="status">{{ STATUS[a.statut] }}</span>
        <time>{{ when(a.at) }}</time>
      </header>
      <p class="message">{{ a.message }}</p>
      <p class="meta">
        <template v-if="a.name">{{ a.name }}</template>
        <template v-else>Anonyme</template>
        <template v-if="a.contact"> · <a :href="`mailto:${a.contact}`">{{ a.contact }}</a></template>
        <template v-if="a.screen"> · écran « {{ a.screen }} »</template>
        <template v-if="a.version"> · v{{ a.version }}</template>
        <template v-if="a.platform"> · {{ a.platform }}</template>
      </p>
      <div v-if="a.images" class="shots">
        <button v-if="!shots[a.id]" type="button" class="link" @click="showShots(a)">
          <Icon name="image" :size="14" /> Voir {{ a.images > 1 ? `les ${a.images} captures` : "la capture" }}
        </button>
        <template v-else>
          <button v-for="(src, n) in shots[a.id]" :key="n" type="button" class="shot" :disabled="!src" aria-label="Voir la capture en grand" @click="zoomed = src">
            <img v-if="src" :src="src" :alt="`Capture ${n + 1}`" />
            <span v-else class="muted">Capture illisible</span>
          </button>
        </template>
      </div>
      <div class="actions">
        <button v-if="a.statut !== 'lu'" type="button" class="pill pill-ghost" @click="avis.setStatus(a, 'lu')">Marquer lu</button>
        <button v-if="a.statut !== 'traite'" type="button" class="pill pill-ghost" @click="avis.setStatus(a, 'traite')">
          <Icon name="check" :size="14" /> Traité
        </button>
        <button v-if="a.statut !== 'nouveau'" type="button" class="pill pill-ghost" @click="avis.setStatus(a, 'nouveau')">Remettre en nouveau</button>
        <button type="button" class="pill pill-ghost danger" @click="remove(a)"><Icon name="trash" :size="14" /> Supprimer</button>
      </div>
    </article>

    <Teleport to="body">
      <div v-if="zoomed" class="zoom" role="dialog" aria-modal="true" aria-label="Capture en grand" @click="zoomed = null">
        <button type="button" class="zoom-close" aria-label="Fermer"><Icon name="close" :size="18" /></button>
        <img :src="zoomed" alt="Capture envoyée avec l'avis" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.chips {
  display: flex;
  gap: var(--space-2);
}
.chips button {
  padding: 6px 13px;
  border: 0;
  border-radius: var(--radius-pill);
  background: rgba(var(--fg-rgb), 0.08);
  color: var(--text-2);
  font-size: 13px;
}
.chips button.on {
  background: var(--accent);
  color: var(--on-accent);
}
.avis {
  margin-bottom: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background: rgba(var(--fg-rgb), 0.05);
  box-shadow: inset 0 0 0 0.5px var(--separator);
}
.avis.nouveau {
  box-shadow: inset 3px 0 0 var(--accent), inset 0 0 0 0.5px var(--separator);
}
.avis header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
}
.kind {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}
.status {
  color: var(--text-2);
}
time {
  margin-left: auto;
  color: var(--text-3);
}
.message {
  margin: var(--space-3) 0 var(--space-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
  user-select: text;
}
.meta {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
}
.meta a {
  color: var(--accent);
}
.shots {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.shot {
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
}
.shot img {
  display: block;
  max-width: 220px;
  max-height: 240px;
  border-radius: var(--radius-sm);
}
.zoom {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: calc(var(--safe-top) + 16px) 16px calc(var(--safe-bottom) + 16px);
  background: rgba(2, 6, 20, 0.88);
  cursor: zoom-out;
}
.zoom img {
  max-width: 100%;
  max-height: calc(100vh - 32px - var(--safe-top) - var(--safe-bottom));
  border-radius: var(--radius-sm);
}
.zoom-close {
  position: absolute;
  top: calc(var(--safe-top) + 12px);
  right: 12px;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.actions .pill {
  height: 30px;
  padding: 0 12px;
  font-size: 12.5px;
}
.danger {
  color: var(--danger);
}
.error {
  color: var(--danger-text);
}
</style>
