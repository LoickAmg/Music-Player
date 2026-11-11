<script setup lang="ts">
import { computed, ref } from "vue";
import { type CopyRequest, type DeviceInventory, invKey, type InvTrack } from "@/lib/devices";
import { useDevicesStore } from "@/stores/devices";
import { useShareStore } from "@/stores/share";
import { useSyncStore } from "@/stores/sync";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";

// Mes appareils : ce que chaque appareil lié a de plus que celui-ci, et la copie ici.
const devices = useDevicesStore();
const share = useShareStore();
const sync = useSyncStore();
const ui = useUiStore();
const onAndroid = /Android/i.test(navigator.userAgent);

const receivedPlace = "Musique › Music Player › Reçus";
const others = computed(() => devices.others);

const since = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
function ago(at: number): string {
  const minutes = Math.round((at - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return since.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return since.format(hours, "hour");
  return since.format(Math.round(hours / 24), "day");
}
const tracksWord = (n: number) => `${n} morceau${n > 1 ? "x" : ""}`;

/** Liste dépliée (appareil) et sélection. */
const open = ref<string | null>(null);
const query = ref("");
const picked = ref<Set<string>>(new Set());
const shown = ref(150);

function toggleList(id: string) {
  open.value = open.value === id ? null : id;
  picked.value = new Set();
  query.value = "";
  shown.value = 150;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function visible(d: DeviceInventory): InvTrack[] {
  const q = norm(query.value.trim());
  const asked = devices.pending(d.id);
  const list = devices.missingHere(d.id).filter((t) => !asked.has(invKey(t)));
  return q ? list.filter((t) => norm(`${t.t} ${t.a} ${t.al}`).includes(q)) : list;
}
function toggle(t: InvTrack) {
  const k = invKey(t);
  const next = new Set(picked.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  picked.value = next;
}
function pickAll(d: DeviceInventory) {
  const list = visible(d);
  picked.value = picked.value.size === list.length ? new Set() : new Set(list.map(invKey));
}

async function copyAll(d: DeviceInventory) {
  const asked = devices.pending(d.id);
  await devices.request(d.id, devices.missingHere(d.id).filter((t) => !asked.has(invKey(t))));
  ui.notify(`Copie demandée à ${d.name} : elle commence dès qu'il est ouvert.`);
}
async function copyPicked(d: DeviceInventory) {
  const list = visible(d).filter((t) => picked.value.has(invKey(t)));
  await devices.request(d.id, list);
  picked.value = new Set();
  ui.notify(`${tracksWord(list.length)} demandé${list.length > 1 ? "s" : ""} à ${d.name}.`);
}

/** Demandes de cet appareil vers `d`, en cours. */
function running(d: DeviceInventory): CopyRequest[] {
  return devices.copies.filter((c) => c.from === devices.myId && c.to === d.id && (c.state === "attente" || c.state === "envoi"));
}
/** Avancement de la copie en cours (octets), quand un transfert est suivi ici. */
function progress(d: DeviceInventory): { percent: number; label: string } | null {
  for (const c of running(d)) {
    const tid = devices.working[c.id];
    const t = tid ? share.byId(tid) : null;
    if (t && t.progress.total > 0) return { percent: Math.round((t.progress.done / t.progress.total) * 100), label: t.progress.stage === "reprise" ? "reprise après une coupure" : "réception" };
  }
  return null;
}
function status(d: DeviceInventory): string {
  const list = running(d);
  const count = list.reduce((s, c) => s + c.tracks.length, 0);
  const moving = list.find((c) => c.state === "envoi");
  if (moving) {
    const lot = moving.parts && moving.parts > 1 ? ` · lot ${moving.part} sur ${moving.parts}` : "";
    return `${tracksWord(count)} en route depuis ${d.name}${lot}`;
  }
  if (list.every((c) => c.auto)) return `${tracksWord(count)} à copier dès que ${d.name} sera sur le même Wi-Fi, appli ouverte`;
  return `${tracksWord(count)} en attente : ouvrez Music Player sur ${d.name}`;
}
/** Pourquoi la copie attend (pause entre deux lots, limite du jour…), dite par l'appareil qui envoie. */
function reason(d: DeviceInventory): string | null {
  return running(d).find((c) => c.state === "attente" && c.message)?.message ?? null;
}
/** Copie découpée en lots (par le relais) : on le dit. */
function split(d: DeviceInventory): number {
  return Math.max(0, ...running(d).map((c) => c.parts ?? 1));
}
/** Dernières copies terminées depuis `d`. */
function history(d: DeviceInventory): CopyRequest[] {
  return devices.copies
    .filter((c) => c.from === devices.myId && c.to === d.id && (c.state === "fini" || c.state === "echec"))
    .slice(-3)
    .reverse();
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Mes appareils</h1>
    <p class="intro muted">Ce que vos autres appareils ont de plus que celui-ci, et la copie ici en un geste. Les morceaux copiés arrivent dans {{ receivedPlace }}, visibles aussi hors de l'appli.</p>
    <p class="intro muted small-note">
      <Icon name="refresh" :size="13" /> Sur le même Wi-Fi, la copie est directe et sans limite. Sinon elle passe par le relais chiffré, par lots d'environ 150 Mo
      (2 Go par jour au plus), pour rester dans son offre gratuite : une grosse copie se fait donc en plusieurs étapes, toute seule.
    </p>

    <section v-if="!sync.linked" class="section-card empty">
      <Icon :name="onAndroid ? 'desktop' : 'phone'" :size="36" />
      <h2>Reliez d'abord vos appareils</h2>
      <p class="muted">Une fois votre téléphone et votre PC reliés, chacun voit ici les morceaux de l'autre et peut se les copier, sans câble.</p>
      <button type="button" class="pill pill-accent" @click="ui.go({ name: 'settings' })">Relier un appareil</button>
    </section>

    <template v-else>
      <section class="section-card me">
        <span class="device-icon"><Icon :name="onAndroid ? 'phone' : 'desktop'" :size="22" /></span>
        <div class="who">
          <strong>Cet appareil</strong>
          <small class="muted">{{ devices.mine ? tracksWord(devices.mine.tracks.length) : "Liste en préparation…" }}</small>
        </div>
      </section>

      <section v-if="!others.length" class="section-card empty">
        <p class="muted">Vos autres appareils apparaîtront ici après leur prochaine synchronisation (appli ouverte dessus, en 0.5.16 ou plus).</p>
      </section>

      <section v-for="d in others" :key="d.id" class="section-card device">
        <header>
          <span class="device-icon"><Icon :name="d.platform === 'android' ? 'phone' : 'desktop'" :size="22" /></span>
          <div class="who">
            <strong>{{ d.name }}</strong>
            <small class="muted">{{ tracksWord(d.tracks.length) }} · liste mise à jour {{ ago(d.at) }}</small>
          </div>
        </header>

        <div class="tiles">
          <div class="tile">
            <strong class="big">{{ devices.missingHere(d.id).length }}</strong>
            <span>sur {{ d.name }}, pas ici</span>
            <div class="tile-actions">
              <button type="button" class="pill pill-accent small" :disabled="!visible(d).length" @click="copyAll(d)"><Icon name="import" :size="14" /> Tout copier ici</button>
              <button type="button" class="pill pill-ghost small" :disabled="!devices.missingHere(d.id).length" @click="toggleList(d.id)">{{ open === d.id ? "Masquer" : "Choisir" }}</button>
            </div>
          </div>
          <div class="tile">
            <strong class="big">{{ devices.missingThere(d.id).length }}</strong>
            <span>ici, pas sur {{ d.name }}</span>
            <small class="muted">Pour les y copier : « Mes appareils » sur {{ d.name }}.</small>
          </div>
        </div>

        <div v-if="running(d).length" class="progress" role="status">
          <div class="progress-text">
            <Icon name="refresh" :size="15" class="spin" />
            <span>
              {{ status(d) }}
              <small v-if="reason(d)" class="reason">{{ reason(d) }}</small>
              <small v-else-if="split(d) > 1" class="reason">Sans Wi-Fi commun, la copie passe par le relais en {{ split(d) }} lots d'environ 150 Mo, l'un après l'autre.</small>
            </span>
            <button type="button" class="link" @click="devices.cancel(d.id)">Annuler</button>
          </div>
          <div v-if="progress(d)" class="bar"><span :style="{ width: `${progress(d)!.percent}%` }" /></div>
        </div>

        <ul v-if="history(d).length" class="history">
          <li v-for="c in history(d)" :key="c.id" :class="c.state">
            <Icon :name="c.state === 'fini' ? 'check' : 'close'" :size="13" />
            {{ tracksWord(c.tracks.length) }} {{ c.state === "fini" ? "copiés" : `non copiés${c.message ? ` : ${c.message}` : ""}` }} · {{ ago(c.updated) }}
          </li>
        </ul>

        <label class="toggle auto">
          <input type="checkbox" :checked="devices.autoFrom.includes(d.id)" @change="devices.setAuto(d.id, ($event.target as HTMLInputElement).checked)" />
          <span>
            <strong>Copie automatique depuis {{ d.name }}</strong>
            <small class="muted">Ses nouveaux morceaux arrivent ici seuls, quand les deux appareils sont sur le même Wi-Fi, appli ouverte.</small>
          </span>
        </label>

        <div v-if="open === d.id" class="picker">
          <div class="picker-head">
            <input v-model="query" class="fieldbox" type="search" placeholder="Rechercher un titre, un artiste…" aria-label="Rechercher dans les morceaux manquants" />
            <button type="button" class="link" @click="pickAll(d)">{{ picked.size && picked.size === visible(d).length ? "Tout désélectionner" : "Tout sélectionner" }}</button>
          </div>
          <ul class="tracks">
            <li v-for="t in visible(d).slice(0, shown)" :key="invKey(t)">
              <label>
                <input type="checkbox" :checked="picked.has(invKey(t))" @change="toggle(t)" />
                <span class="t-text">
                  <strong>{{ t.t }}</strong>
                  <small class="muted">{{ t.a }}{{ t.al ? ` · ${t.al}` : "" }}</small>
                </span>
              </label>
            </li>
          </ul>
          <button v-if="visible(d).length > shown" type="button" class="pill pill-ghost small more" @click="shown += 300">Afficher plus ({{ visible(d).length - shown }})</button>
          <p v-if="!visible(d).length" class="muted">Aucun morceau ne correspond.</p>
          <div class="picker-foot">
            <span class="muted">{{ tracksWord(picked.size) }} sélectionné{{ picked.size > 1 ? "s" : "" }}</span>
            <button type="button" class="pill pill-accent" :disabled="!picked.size" @click="copyPicked(d)"><Icon name="import" :size="15" /> Copier ici</button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.intro {
  margin: -6px 0 18px;
  max-width: 68ch;
  line-height: 1.5;
}
.small-note {
  display: flex;
  gap: 6px;
  margin-top: -10px;
  font-size: 12.5px;
}
.small-note :deep(svg) {
  flex: none;
  margin-top: 3px;
}
.reason {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-2);
}
.empty {
  display: grid;
  justify-items: start;
  gap: 10px;
}
.empty h2 {
  margin: 0;
}
.me,
.device header {
  display: flex;
  align-items: center;
  gap: 12px;
}
.device-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}
.who {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.who small {
  font-size: 12.5px;
}
.device {
  display: grid;
  gap: 16px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.tile {
  display: grid;
  align-content: start;
  gap: 4px;
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--bg-hover);
}
.big {
  font-size: 28px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.tile small {
  font-size: 12px;
  margin-top: 4px;
}
.tile-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.small {
  padding: 6px 12px;
  font-size: 12.5px;
}
.progress {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
}
.progress-text {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
}
.progress-text span {
  flex: 1;
  min-width: 0;
}
.bar {
  height: 4px;
  border-radius: 2px;
  background: var(--bg-hover);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}
.spin {
  animation: spin 1.4s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
.history {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12.5px;
  color: var(--text-2);
}
.history li {
  display: flex;
  align-items: center;
  gap: 6px;
}
.history .fini :deep(svg) {
  color: var(--accent);
}
.auto {
  align-items: flex-start;
}
.auto span {
  display: grid;
  gap: 2px;
}
.auto small {
  font-size: 12px;
}
.link {
  border: 0;
  background: none;
  padding: 0;
  color: var(--accent);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.picker {
  display: grid;
  gap: 10px;
}
.picker-head,
.picker-foot {
  display: flex;
  align-items: center;
  gap: 12px;
}
.picker-head .fieldbox {
  flex: 1;
  min-width: 0;
}
.picker-foot {
  justify-content: space-between;
  position: sticky;
  bottom: 0;
  padding: 10px 0 2px;
  background: linear-gradient(to top, var(--surface, var(--bg)) 70%, transparent);
}
.tracks {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 420px;
  overflow-y: auto;
  border-radius: 12px;
  background: var(--bg-hover);
}
.tracks li + li {
  border-top: 1px solid color-mix(in srgb, var(--text) 7%, transparent);
}
.tracks label {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  min-height: 44px;
  cursor: pointer;
}
.tracks input {
  flex: none;
  width: 17px;
  height: 17px;
  accent-color: var(--accent);
}
.t-text {
  display: grid;
  min-width: 0;
}
.t-text strong,
.t-text small {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.t-text strong {
  font-weight: 600;
  font-size: 14px;
}
.t-text small {
  font-size: 12px;
}
.more {
  justify-self: center;
}
</style>
