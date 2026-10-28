<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { shareText } from "@/lib/androidMedia";
import { normalize } from "@/lib/duplicates";
import { type Card, parseCode, type Presence } from "@/lib/friendsApi";
import { formatDuration } from "@/lib/format";
import type { Track } from "@/lib/types";
import { type Friend, isFresh, useFriendsStore } from "@/stores/friends";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useShareStore } from "@/stores/share";
import { useUiStore } from "@/stores/ui";
import FriendAvatar from "@/components/FriendAvatar.vue";
import Icon from "@/components/Icon.vue";

const friends = useFriendsStore();
const library = useLibraryStore();
const player = usePlayerStore();
const share = useShareStore();
const ui = useUiStore();

const codeInput = ref("");
const found = ref<Card | null>(null);
const searching = ref(false);
const searchError = ref<string | null>(null);
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  friends.setWatching(true);
  clock = setInterval(() => (now.value = Date.now()), 15_000);
  if (friends.enabled && friends.zoneVisible) void friends.loadZone();
});
onBeforeUnmount(() => {
  friends.setWatching(false);
  if (clock) clearInterval(clock);
});

const ordered = computed(() => {
  const rank = (f: Friend) => {
    const s = friends.live[f.code]?.status;
    if (!s || !isFresh(s, now.value)) return 0;
    return s.playing ? 2 : 1;
  };
  return [...friends.friends].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, "fr"));
});

/** Proches trouvés sur le même Wi-Fi (appareils qui ont activé les Proches). */
const nearbyProfiles = computed(() =>
  share.peers.filter((p) => p.code && p.code !== friends.me?.code).map((p) => ({ code: p.code!, nom: p.name, avatar: null })),
);

function ago(ms: number): string {
  const min = Math.round((now.value - ms) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
}

function statusLine(f: Friend): { text: string; status: Presence | null; live: boolean } {
  const live = friends.live[f.code];
  if (live?.refused) return { text: "Ne partage plus son écoute avec vous", status: null, live: false };
  const s = live?.status;
  if (!s) return { text: live ? "Rien en ce moment" : "…", status: null, live: false };
  const what = `${s.title} · ${s.artist}`;
  if (s.playing && isFresh(s, now.value)) return { text: what, status: s, live: true };
  if (!s.playing && isFresh(s, now.value)) return { text: `En pause · ${what}`, status: s, live: false };
  return { text: `A écouté ${what} ${ago(s.at)}`, status: s, live: false };
}

/** Le morceau de l'ami, s'il est aussi dans ma bibliothèque. */
function inMyLibrary(s: Presence | null): Track | null {
  if (!s) return null;
  const title = normalize(s.title);
  const artist = normalize(s.artist);
  return library.tracks.find((t) => normalize(t.title) === title && normalize(t.artist) === artist) ?? null;
}

async function search() {
  searchError.value = null;
  found.value = null;
  const code = parseCode(codeInput.value);
  if (!code) {
    searchError.value = "Un code d'ami a 8 caractères, par exemple K7QM-2D9X.";
    return;
  }
  if (code === friends.me?.code) {
    searchError.value = "C'est votre propre code.";
    return;
  }
  searching.value = true;
  found.value = await friends.findProfile(code);
  if (!found.value) searchError.value = friends.error ?? "Aucun profil avec ce code.";
  searching.value = false;
}

async function add(card: Card) {
  await friends.request(card);
  if (!friends.error) {
    ui.notify(friends.isFriend(card.code) ? `${card.nom} fait partie de vos proches` : `Demande envoyée à ${card.nom}`);
    found.value = null;
    codeInput.value = "";
  } else ui.notify(friends.error);
}

async function copyCode() {
  if (!friends.me) return;
  const text = `Ajoute-moi dans Music Player (Proches) : ${friends.me.code}`;
  if (shareText(text)) return;
  try {
    await navigator.clipboard.writeText(friends.me.code);
    ui.notify("Code copié");
  } catch {
    ui.notify(friends.me.code);
  }
}

function relation(code: string): "ami" | "attente" | null {
  if (friends.isFriend(code)) return "ami";
  if (friends.isPending(code)) return "attente";
  return null;
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Proches</h1>

    <!-- Pas encore activé -->
    <section v-if="!friends.enabled" class="card intro">
      <Icon name="user" :size="28" />
      <h2>Voyez ce qu'écoutent vos proches</h2>
      <p class="muted">
        Activez les Proches pour recevoir un code d'ami. Ajoutez-vous avec vos codes, ou depuis la liste des appareils du
        même Wi-Fi : une fois la demande acceptée, chacun voit en direct ce que l'autre écoute. Pas de compte, pas d'adresse
        e-mail ; vos vocaux et enregistrements ne sont jamais partagés.
      </p>
      <button type="button" class="pill pill-accent" :disabled="friends.busy || !friends.base" @click="friends.enable()">
        {{ friends.busy ? "Activation…" : "Activer les Proches" }}
      </button>
      <p v-if="!friends.base" class="muted small">Un relais est nécessaire : Réglages → Partage.</p>
      <p v-if="friends.error" class="error">{{ friends.error }}</p>
    </section>

    <template v-else>
      <!-- Mon code et mes réglages -->
      <section class="card me">
        <div class="me-head">
          <div>
            <p class="label">Mon code d'ami</p>
            <p class="code">{{ friends.me?.code }}</p>
          </div>
          <button type="button" class="pill pill-ghost" @click="copyCode"><Icon name="share" :size="15" /> Envoyer mon code</button>
        </div>
        <label class="toggle">
          <input type="checkbox" :checked="friends.shareListening" @change="friends.setShareListening(($event.target as HTMLInputElement).checked)" />
          <span>Montrer à mes proches ce que j'écoute</span>
        </label>
        <label class="toggle">
          <input type="checkbox" :checked="friends.zoneVisible" @change="friends.setZoneVisible(($event.target as HTMLInputElement).checked)" />
          <span>Visible des personnes de ma ville <span class="muted">(nom et code seulement, d'après la connexion)</span></span>
        </label>
        <p v-if="friends.error" class="error">{{ friends.error }}</p>
      </section>

      <!-- Demandes reçues -->
      <section v-if="friends.incoming.length" class="block">
        <h2>Demandes reçues</h2>
        <div v-for="r in friends.incoming" :key="r.code" class="person">
          <FriendAvatar :name="r.name" :src="r.avatar" />
          <div class="who">
            <strong>{{ r.name }}</strong>
            <span class="muted">{{ r.code }} · {{ ago(r.at) }}</span>
          </div>
          <button type="button" class="pill pill-ghost" @click="friends.refuse(r)">Refuser</button>
          <button type="button" class="pill pill-accent" @click="friends.accept(r)">Accepter</button>
        </div>
      </section>

      <!-- Amis et ce qu'ils écoutent -->
      <section class="block">
        <h2>Mes proches <span class="count">{{ friends.friends.length || "" }}</span></h2>
        <p v-if="!friends.friends.length" class="muted">
          Personne pour l'instant : envoyez votre code, ou ajoutez quelqu'un ci-dessous.
        </p>
        <div v-for="f in ordered" :key="f.code" class="person">
          <FriendAvatar :name="f.name" :src="f.avatar" :live="statusLine(f).live" />
          <div class="who">
            <strong>{{ f.name }}</strong>
            <span class="status" :class="{ on: statusLine(f).live }">
              <span v-if="statusLine(f).live" class="bars" aria-label="En écoute"><i /><i /><i /></span>
              {{ statusLine(f).text }}
            </span>
            <span v-if="statusLine(f).live && statusLine(f).status" class="muted small">
              {{ statusLine(f).status!.album }} · {{ formatDuration(statusLine(f).status!.duration) }}
            </span>
          </div>
          <button
            v-if="inMyLibrary(statusLine(f).status)"
            type="button"
            class="pill pill-ghost"
            title="Ce morceau est aussi dans votre bibliothèque"
            @click="player.playTrackNow(inMyLibrary(statusLine(f).status)!.id)"
          >
            <Icon name="play" :size="14" /> Écouter aussi
          </button>
          <button type="button" class="icon-btn chat-btn" :aria-label="`Discuter avec ${f.name}`" title="Discuter" @click="friends.openChat(f.code)">
            <Icon name="lyrics" :size="17" />
            <span v-if="friends.unread[f.code]" class="unread">{{ friends.unread[f.code] }}</span>
          </button>
          <button type="button" class="icon-btn" :aria-label="`Retirer ${f.name} de mes proches`" title="Retirer" @click="friends.remove(f.code)">
            <Icon name="close" :size="15" />
          </button>
        </div>
      </section>

      <!-- Ajouter -->
      <section class="block">
        <h2>Ajouter un proche</h2>
        <form class="search" @submit.prevent="search">
          <input v-model="codeInput" class="fieldbox" placeholder="Code d'ami, ex. K7QM-2D9X" aria-label="Code d'ami" autocapitalize="characters" spellcheck="false" />
          <button type="submit" class="pill pill-accent" :disabled="searching">{{ searching ? "Recherche…" : "Chercher" }}</button>
        </form>
        <p v-if="searchError" class="error">{{ searchError }}</p>
        <div v-if="found" class="person found">
          <FriendAvatar :name="found.nom" :src="found.avatar" />
          <div class="who">
            <strong>{{ found.nom }}</strong>
            <span class="muted">{{ found.code }}</span>
          </div>
          <span v-if="relation(found.code) === 'ami'" class="muted">Déjà parmi vos proches</span>
          <span v-else-if="relation(found.code) === 'attente'" class="muted">Demande envoyée</span>
          <button v-else type="button" class="pill pill-accent" @click="add(found)">Envoyer une demande</button>
        </div>

        <div v-if="friends.outgoing.length" class="sub">
          <p class="label">En attente de réponse</p>
          <div v-for="o in friends.outgoing" :key="o.code" class="person small-row">
            <FriendAvatar :name="o.name" :src="o.avatar" :size="32" />
            <div class="who">
              <strong>{{ o.name }}</strong>
              <span class="muted">{{ o.code }} · {{ ago(o.at) }}</span>
            </div>
            <button type="button" class="pill pill-ghost" @click="friends.cancelRequest(o.code)">Annuler</button>
          </div>
        </div>

        <div class="sub">
          <div class="sub-head">
            <p class="label">Sur le même Wi-Fi</p>
            <button type="button" class="link" :disabled="share.scanning" @click="share.scan()">
              {{ share.scanning ? "Recherche…" : "Chercher" }}
            </button>
          </div>
          <p v-if="!nearbyProfiles.length" class="muted small">
            Les appareils proches qui ont activé les Proches (et la visibilité, Réglages → Partage) apparaissent ici.
          </p>
          <div v-for="p in nearbyProfiles" :key="p.code" class="person small-row">
            <FriendAvatar :name="p.nom" :size="32" />
            <div class="who">
              <strong>{{ p.nom }}</strong>
              <span class="muted">{{ p.code }}</span>
            </div>
            <span v-if="relation(p.code)" class="muted">{{ relation(p.code) === "ami" ? "Proche" : "Demande envoyée" }}</span>
            <button v-else type="button" class="pill pill-ghost" @click="add(p)">Ajouter</button>
          </div>
        </div>

        <div class="sub">
          <div class="sub-head">
            <p class="label">Dans ma ville{{ friends.zone?.label ? ` (${friends.zone.label})` : "" }}</p>
            <button type="button" class="link" @click="friends.loadZone()">Actualiser</button>
          </div>
          <p v-if="!friends.zone" class="muted small">
            Personnes qui ont choisi d'être visibles dans votre ville. Touchez « Actualiser » pour voir la liste.
          </p>
          <p v-else-if="!friends.zone.profiles.length" class="muted small">Personne de visible pour l'instant.</p>
          <div v-for="p in friends.zone?.profiles ?? []" :key="p.code" class="person small-row">
            <FriendAvatar :name="p.nom" :src="p.avatar" :size="32" />
            <div class="who">
              <strong>{{ p.nom }}</strong>
              <span class="muted">{{ p.code }}</span>
            </div>
            <span v-if="relation(p.code)" class="muted">{{ relation(p.code) === "ami" ? "Proche" : "Demande envoyée" }}</span>
            <button v-else type="button" class="pill pill-ghost" @click="add(p)">Ajouter</button>
          </div>
        </div>
      </section>

      <p class="footer">
        <button type="button" class="link danger" @click="friends.disable()">Désactiver les Proches</button>
        <span class="muted small">Vos proches ne verront plus votre écoute ; ils restent dans la liste si vous réactivez.</span>
      </p>
    </template>
  </div>
</template>

<style scoped>
.chat-btn {
  position: relative;
  color: var(--accent);
}
.unread {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--danger-strong);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
}
.card {
  padding: 18px;
  border-radius: 14px;
  background: rgba(var(--fg-rgb), 0.05);
}
.intro {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  max-width: 620px;
  color: var(--accent);
}
.intro h2 {
  margin: 0;
  color: var(--text);
  font-size: 18px;
}
.intro p {
  margin: 0;
  line-height: 1.5;
}
.me {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 26px;
}
.me-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.label {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.code {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
}
.block {
  margin-bottom: 28px;
}
.block h2 {
  margin: 0 0 10px;
  font-family: var(--font-display);
  font-size: 19px;
}
.count {
  color: var(--text-2);
  font-size: 14px;
  font-weight: 500;
}
.person {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  border-radius: 10px;
}
.person + .person {
  border-top: 1px solid var(--separator);
}
.small-row {
  padding: 6px 8px;
}
.who {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.who strong {
  font-size: 14px;
}
.who > span {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  color: var(--text-2);
}
.status.on {
  color: var(--accent);
  font-weight: 600;
}
.bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 10px;
  margin-right: 4px;
}
.bars i {
  width: 2px;
  height: 100%;
  background: currentColor;
  animation: bar 0.9s ease-in-out infinite;
}
.bars i:nth-child(2) {
  animation-delay: -0.3s;
}
.bars i:nth-child(3) {
  animation-delay: -0.6s;
}
@keyframes bar {
  0%,
  100% {
    transform: scaleY(0.3);
  }
  50% {
    transform: scaleY(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bars i {
    animation: none;
  }
}
.search {
  display: flex;
  gap: 8px;
  max-width: 480px;
}
.search input {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 12px;
  border-radius: 10px;
  font-size: 14px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.found {
  max-width: 560px;
  margin-top: 10px;
  background: rgba(var(--fg-rgb), 0.05);
}
.sub {
  margin-top: 18px;
}
.sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 560px;
}
.link {
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
}
.link.danger {
  color: var(--danger);
}
.small {
  font-size: 12px;
}
.error {
  color: var(--danger-text);
  font-size: 13px;
}
.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
</style>
