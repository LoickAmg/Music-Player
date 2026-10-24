<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Icon from "@/components/Icon.vue";
import RecapStory from "@/components/RecapStory.vue";
import { buildRecap, formatListening, monthName, type Period } from "@/lib/recap";
import { useListeningStore } from "@/stores/listening";
import { useUiStore } from "@/stores/ui";

/**
 * Accueil : en décembre (et jusqu'au 10 janvier), « Ton année en musique est prête » ; les dix
 * premiers jours d'un mois, le récit du mois écoulé ; le reste du temps, un raccourci discret
 * vers « Mon écoute » (seul accès sur téléphone).
 */
const listening = useListeningStore();
const ui = useUiStore();
const story = ref<Period | null>(null);
const DISMISS_KEY = "mp:recap-vu:";

onMounted(() => void listening.load());

const today = new Date();
const offer = computed<{ period: Period; title: string; text: string } | null>(() => {
  const y = today.getFullYear();
  const yearPeriod: Period | null = today.getMonth() === 11 ? { kind: "year", year: y } : today.getMonth() === 0 && today.getDate() <= 10 ? { kind: "year", year: y - 1 } : null;
  if (yearPeriod) {
    const r = buildRecap(listening.music, yearPeriod);
    if (r.totalSecs >= 3600) return { period: yearPeriod, title: `Ton année ${yearPeriod.year} en musique est prête`, text: `${formatListening(r.totalSecs)} d'écoute, ton artiste n°1, ton morceau de l'année… À découvrir en story.` };
  }
  if (today.getDate() <= 10) {
    const last: Period = today.getMonth() === 0 ? { kind: "month", year: y - 1, month: 11 } : { kind: "month", year: y, month: today.getMonth() - 1 };
    const r = buildRecap(listening.music, last);
    if (r.totalSecs >= 1800) return { period: last, title: `Ton mois de ${monthName(last.month)} en musique`, text: `${formatListening(r.totalSecs)} d'écoute et ${r.topArtists[0]?.label ?? "tes artistes"} en tête. Revis-le en quelques secondes.` };
  }
  return null;
});
const key = computed(() => (offer.value ? DISMISS_KEY + JSON.stringify(offer.value.period) : ""));
const dismissed = ref(false);
const hidden = computed(() => {
  if (dismissed.value) return true;
  try {
    return Boolean(key.value && localStorage.getItem(key.value));
  } catch {
    return false;
  }
});
function dismiss() {
  dismissed.value = true;
  try {
    localStorage.setItem(key.value, "1");
  } catch {
    // retiré pour la session
  }
}
const thisMonth = computed(() => buildRecap(listening.music, { kind: "month", year: today.getFullYear(), month: today.getMonth() }));
const storyRecap = computed(() => (story.value ? buildRecap(listening.music, story.value) : null));
</script>

<template>
  <div v-if="listening.loaded">
    <section v-if="offer && !hidden" class="banner">
      <div class="glow" aria-hidden="true" />
      <div class="text">
        <p class="eyebrow"><Icon name="sparkle" :size="14" /> Rétrospective</p>
        <p class="title">{{ offer.title }}</p>
        <p class="sub">{{ offer.text }}</p>
      </div>
      <div class="buttons">
        <button type="button" class="go" @click="story = offer.period">Voir ma story</button>
        <button type="button" class="later" @click="dismiss">Plus tard</button>
      </div>
    </section>
    <button v-else-if="thisMonth.totalSecs >= 60" type="button" class="shortcut" @click="ui.go({ name: 'stats' })">
      <Icon name="stats" :size="16" />
      <span><b>Mon écoute</b> · {{ formatListening(thisMonth.totalSecs) }} en {{ monthName(today.getMonth()) }}</span>
      <Icon name="next" :size="12" />
    </button>
    <RecapStory v-if="storyRecap" :recap="storyRecap" @close="story = null" />
  </div>
</template>

<style scoped>
.banner {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
  padding: 20px 22px;
  border-radius: 18px;
  color: #fff;
  background: linear-gradient(120deg, #6d3cff, #ff4fa3 60%, #ffb04f);
  box-shadow: 0 16px 40px rgba(109, 60, 255, 0.3);
}
.glow {
  position: absolute;
  inset: -40%;
  background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.35), transparent 40%);
  animation: sweep 9s ease-in-out infinite alternate;
}
@keyframes sweep {
  to {
    transform: translate(30%, 10%);
  }
}
.text {
  position: relative;
  min-width: 0;
  flex: 1 1 260px;
}
.eyebrow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.9;
}
.title {
  margin: 6px 0 4px;
  font-size: 22px;
  font-weight: 900;
  line-height: 1.15;
}
.sub {
  margin: 0;
  opacity: 0.9;
  font-size: 14px;
}
.buttons {
  position: relative;
  display: flex;
  gap: 8px;
}
.go {
  border: 0;
  border-radius: 999px;
  padding: 10px 18px;
  background: #fff;
  color: #2a1250;
  font-weight: 800;
}
.later {
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 999px;
  padding: 10px 14px;
  background: none;
  color: #fff;
  font-weight: 700;
}
.shortcut {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  padding: 8px 14px;
  border: 0;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.07);
  color: inherit;
  font-size: 13px;
}
.shortcut:hover {
  background: rgba(var(--fg-rgb), 0.12);
}
@media (prefers-reduced-motion: reduce) {
  .glow {
    animation: none;
  }
}
</style>
