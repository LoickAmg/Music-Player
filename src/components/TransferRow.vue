<script setup lang="ts">
import { computed } from "vue";
import { formatBytes } from "@/lib/format";
import { useShareStore, type Transfer } from "@/stores/share";
import Icon from "./Icon.vue";

const props = defineProps<{ transfer: Transfer }>();
const share = useShareStore();

const p = computed(() => props.transfer.progress);
const running = computed(() => ["attente", "envoi", "reception"].includes(p.value.stage));
const percent = computed(() => (p.value.total > 0 ? Math.min(100, Math.round((p.value.done / p.value.total) * 100)) : null));

const status = computed(() => {
  const t = props.transfer;
  switch (p.value.stage) {
    case "attente":
      if (t.direction === "reception") return "Connexion à l'expéditeur…";
      return t.peer ? `En attente de l'accord de ${t.peer}…` : "En attente de la personne qui a le code (15 minutes au plus)…";
    case "envoi":
      return `Envoi… ${percent.value ?? 0} % · ${formatBytes(p.value.done)} sur ${formatBytes(p.value.total)}`;
    case "reception":
      return `Réception… ${percent.value ?? 0} % · ${formatBytes(p.value.done)} sur ${formatBytes(p.value.total)}`;
    case "fini":
      return t.direction === "envoi" ? "Envoyé" : "Reçu et ajouté à la bibliothèque";
    case "refuse":
      return "Refusé";
    default:
      return p.value.message ?? "Échec du partage";
  }
});
</script>

<template>
  <div class="transfer" :class="p.stage">
    <span class="ico" aria-hidden="true">
      <Icon :name="transfer.direction === 'envoi' ? 'share' : 'import'" :size="16" />
    </span>
    <div class="body">
      <p class="what">
        {{ transfer.label || "Partage reçu" }}
        <span v-if="transfer.peer" class="who">· {{ transfer.direction === "envoi" ? "vers" : "de" }} {{ transfer.peer }}</span>
      </p>
      <p class="status" role="status">{{ status }}</p>
      <div v-if="running" class="bar" :class="{ indeterminate: percent === null || p.stage === 'attente' }">
        <span :style="percent === null || p.stage === 'attente' ? undefined : { transform: `scaleX(${percent / 100})` }" />
      </div>
    </div>
    <button
      type="button"
      class="icon-btn"
      :title="running ? 'Annuler' : 'Retirer'"
      :aria-label="running ? 'Annuler le partage' : 'Retirer de la liste'"
      @click="running ? share.cancel(transfer.id) : share.dismiss(transfer.id)"
    >
      <Icon name="close" :size="15" />
    </button>
  </div>
</template>

<style scoped>
.transfer {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 4px;
}
.transfer + .transfer {
  border-top: 1px solid var(--separator);
}
.ico {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent-soft, rgba(var(--fg-rgb), 0.1));
  color: var(--accent);
}
.fini .ico {
  background: rgba(60, 200, 120, 0.18);
  color: #3cc878;
}
.erreur .ico,
.refuse .ico {
  background: rgba(255, 107, 125, 0.16);
  color: #ff6b7d;
}
.body {
  flex: 1;
  min-width: 0;
}
.what {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who {
  font-weight: 400;
  color: var(--text-2);
}
.status {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.erreur .status {
  color: #ff8b98;
}
.bar {
  height: 4px;
  margin-top: 7px;
  border-radius: 2px;
  background: rgba(var(--fg-rgb), 0.12);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transform-origin: left;
  transition: transform 0.2s linear;
}
.bar.indeterminate span {
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
</style>
