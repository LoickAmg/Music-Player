<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Piece } from "@/lib/friendsApi";
import type { Track } from "@/lib/types";
import { LibraryMatcher, matchPlaylist } from "@/lib/spotifyImport";
import { type ChatLine, useFriendsStore } from "@/stores/friends";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import Artwork from "./Artwork.vue";
import FriendAvatar from "./FriendAvatar.vue";
import Icon from "./Icon.vue";

// Discussion avec un proche : texte, morceau (fichier compris) ou playlist. Passe par le relais
// des Proches, chiffrée de bout en bout, gardée sur l'appareil. Plein écran sur téléphone (la
// zone de saisie reste au-dessus du clavier), panneau sur ordinateur.
const friends = useFriendsStore();
const library = useLibraryStore();
const player = usePlayerStore();
const playlists = usePlaylistsStore();
const ui = useUiStore();

const friend = computed(() => friends.friends.find((f) => f.code === friends.chatWith) ?? null);
const lines = computed(() => (friend.value ? (friends.conversations[friend.value.code] ?? []) : []));
const live = computed(() => (friend.value ? (friends.live[friend.value.code]?.status ?? null) : null));
const draft = ref("");
const piece = ref<Piece | null>(null);
/** Morceau joint : son fichier part avec le message. */
const pieceTrack = ref<Track | null>(null);
const sending = ref(false);
const list = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
const matcher = computed(() => new LibraryMatcher(library.tracks));

/** Menu « Joindre » ouvert. */
const attachOpen = ref(false);

// ---- Défilement : collé en bas, sauf si l'on remonte lire ----
const atBottom = ref(true);
const unseen = ref(0);
function onScroll() {
  const el = list.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (atBottom.value) unseen.value = 0;
}
async function toBottom(smooth = false) {
  await nextTick();
  list.value?.scrollTo({ top: list.value.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  unseen.value = 0;
}
watch(
  () => friends.chatWith,
  () => {
    attachOpen.value = false;
    void toBottom();
  },
  { immediate: true },
);
watch(
  () => lines.value.length,
  (n, before) => {
    const last = lines.value[n - 1];
    if (atBottom.value || last?.mine) void toBottom(true);
    else if (n > (before ?? 0)) unseen.value += n - (before ?? 0);
  },
);

// ---- Jours et groupes de bulles ----
const timeFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
function dayLabel(at: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return "Aujourd'hui";
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return "Hier";
  const s = dayFormat.format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
interface Row {
  line: ChatLine;
  day: string | null;
  first: boolean;
  last: boolean;
}
const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  const all = lines.value;
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    const prev = all[i - 1];
    const next = all[i + 1];
    const day = !prev || dayLabel(prev.at) !== dayLabel(l.at) ? dayLabel(l.at) : null;
    const close = (a?: ChatLine, b?: ChatLine) => !!a && !!b && a.mine === b.mine && Math.abs(a.at - b.at) < 5 * 60_000 && dayLabel(a.at) === dayLabel(b.at);
    out.push({ line: l, day, first: !close(prev, l), last: !close(l, next) });
  }
  return out;
});
const lastMine = computed(() => [...lines.value].reverse().find((l) => l.mine) ?? null);

// ---- Pièces jointes ----
const query = ref("");
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const results = computed(() => {
  const q = norm(query.value.trim());
  if (!q) return [];
  return library.tracks.filter((t) => norm(`${t.title} ${t.artist}`).includes(q)).slice(0, 40);
});
function attachTrack(t: Track) {
  piece.value = { type: "morceau", titre: t.title, artiste: t.artist, album: t.album };
  pieceTrack.value = t;
  closeAttach();
}
function attachPlaylist(id: string) {
  const p = playlists.byId(id);
  if (!p) return;
  const morceaux = p.track_ids
    .map((tid) => library.byId(tid))
    .filter((t) => !!t)
    .slice(0, 300)
    .map((t) => ({ titre: t!.title, artiste: t!.artist, album: t!.album }));
  if (morceaux.length) {
    piece.value = { type: "playlist", nom: p.name, morceaux };
    pieceTrack.value = null;
  }
  closeAttach();
}
function closeAttach() {
  attachOpen.value = false;
  query.value = "";
  void nextTick(() => input.value?.focus());
}
function clearPiece() {
  piece.value = null;
  pieceTrack.value = null;
}

// ---- Saisie ----
function grow() {
  const el = input.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}
watch(draft, () => void nextTick(grow));
async function send() {
  if (!friend.value || sending.value || (!draft.value.trim() && !piece.value)) return;
  sending.value = true;
  const track = piece.value?.type === "morceau" ? pieceTrack.value : null;
  const ok = track ? await friends.sendTrack(friend.value.code, track, draft.value) : await friends.sendWord(friend.value.code, draft.value, piece.value);
  sending.value = false;
  if (ok) {
    draft.value = "";
    clearPiece();
  }
  if (friends.error) {
    ui.notify(friends.error);
    friends.error = null;
  }
}
function onKey(e: KeyboardEvent) {
  // Ordinateur : Entrée envoie (Maj+Entrée : à la ligne). Téléphone : Entrée va à la ligne.
  if (e.key === "Enter" && !e.shiftKey && !ui.isTouch) {
    e.preventDefault();
    void send();
  }
}
function onEscape(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (attachOpen.value) attachOpen.value = false;
  else friends.openChat(null);
}
window.addEventListener("keydown", onEscape);
onBeforeUnmount(() => window.removeEventListener("keydown", onEscape));

// ---- Morceaux et playlists reçus ----
function localTrack(p: Piece, line?: ChatLine) {
  if (p.type !== "morceau") return null;
  const received = line?.recu?.map((id) => library.byId(id)).find((t) => !!t);
  return received ?? matcher.value.find({ title: p.titre, artist: p.artiste, album: p.album });
}
const sizeLabel = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(bytes / 1e3))} Ko`);
function incoming(p: Piece) {
  return p.type === "morceau" && p.colis ? (friends.parcels[`in:${p.colis.id}`] ?? null) : null;
}
const percent = (p: { done: number; total: number } | null) => (p && p.total ? Math.round((p.done / p.total) * 100) : 0);
const outgoing = computed(() => (friend.value ? (friends.parcels[`out:${friend.value.code}`] ?? null) : null));
async function receive(l: ChatLine) {
  if (!friend.value) return;
  const id = await friends.receivePiece(friend.value.code, l.at);
  if (id) ui.notify("Son reçu : rangé dans Musique › Music Player › Reçus.");
}
function playlistMatch(p: Piece) {
  if (p.type !== "playlist") return null;
  return matchPlaylist(matcher.value, { name: p.nom, tracks: p.morceaux.map((m) => ({ title: m.titre, artist: m.artiste, album: m.album })) });
}
async function createPlaylist(p: Piece) {
  const m = playlistMatch(p);
  if (!m || !m.found.length) return;
  const id = await playlists.create(m.name);
  if (!id) return;
  await playlists.addTracks(id, m.found.map((t) => t.id));
  ui.notify(`Playlist « ${m.name} » créée (${m.found.length} morceau${m.found.length > 1 ? "x" : ""})`);
}
/** Écouter ce que le proche écoute, si le morceau est ici. */
const liveTrack = computed(() => (live.value ? matcher.value.find({ title: live.value.title, artist: live.value.artist, album: live.value.album }) : null));
</script>

<template>
  <Transition name="chat">
    <div v-if="friend" class="scrim" @click.self="friends.openChat(null)">
      <section class="chat" role="dialog" aria-modal="true" :aria-label="`Discussion avec ${friend.name}`" data-keyboard-aware>
        <header>
          <button type="button" class="icon-btn" aria-label="Fermer la discussion" @click="friends.openChat(null)"><Icon name="back" :size="20" /></button>
          <FriendAvatar :name="friend.name" :src="friend.avatar" :size="38" :live="!!live?.playing" />
          <div class="who">
            <strong>{{ friend.name }}</strong>
            <small v-if="live" :class="{ playing: live.playing }">{{ live.playing ? "♪ Écoute" : "En pause ·" }} {{ live.title }} · {{ live.artist }}</small>
            <small v-else class="muted">{{ friend.pubKey ? "Chiffré de bout en bout" : "Messages non chiffrés" }}</small>
          </div>
          <button v-if="liveTrack" type="button" class="icon-btn" :title="`Écouter aussi « ${live?.title} »`" :aria-label="`Écouter aussi ${live?.title}`" @click="player.playTrackNow(liveTrack!.id)">
            <Icon name="play" :size="18" />
          </button>
        </header>

        <div ref="list" class="lines" @scroll.passive="onScroll">
          <div v-if="!lines.length" class="empty">
            <FriendAvatar :name="friend.name" :src="friend.avatar" :size="64" />
            <p><strong>Écrivez à {{ friend.name }}</strong></p>
            <p class="muted">Un mot, le son que vous écoutez (le fichier part avec), ou une playlist.</p>
            <button v-if="player.currentTrack" type="button" class="pill pill-accent" @click="attachTrack(player.currentTrack!)">
              <Icon name="note" :size="15" /> Joindre « {{ player.currentTrack!.title }} »
            </button>
          </div>

          <template v-for="(r, i) in rows" :key="r.line.id ?? `${r.line.at}-${i}`">
            <div v-if="r.day" class="day"><span>{{ r.day }}</span></div>
            <div class="line" :class="{ mine: r.line.mine, first: r.first, last: r.last }">
              <div class="bubble" :class="{ 'has-piece': !!r.line.piece }">
                <!-- Morceau -->
                <template v-if="r.line.piece?.type === 'morceau'">
                <div class="card">
                  <div class="cover">
                    <Artwork :track="localTrack(r.line.piece, r.line) ?? null" :label="r.line.piece.titre" :radius="8" />
                  </div>
                  <div class="card-text">
                    <strong>{{ r.line.piece.titre }}</strong>
                    <small>{{ r.line.piece.artiste }}</small>
                    <small v-if="r.line.piece.colis" class="file">
                      <Icon name="note" :size="11" /> Fichier · {{ sizeLabel(r.line.piece.colis.taille) }}
                    </small>
                  </div>
                  <div class="card-action">
                    <button v-if="localTrack(r.line.piece, r.line)" type="button" class="round" :aria-label="`Écouter ${r.line.piece.titre}`" @click="player.playTrackNow(localTrack(r.line.piece, r.line)!.id)">
                      <Icon name="play" :size="16" />
                    </button>
                    <template v-else-if="!r.line.mine && r.line.piece.colis">
                      <span v-if="incoming(r.line.piece) && !incoming(r.line.piece)!.error" class="ring" role="status" :aria-label="`Réception : ${percent(incoming(r.line.piece))} %`" :style="{ '--p': percent(incoming(r.line.piece)) }">
                        <span>{{ percent(incoming(r.line.piece)) }}</span>
                      </span>
                      <button v-else type="button" class="round accent" :title="incoming(r.line.piece)?.error ?? `Recevoir (${sizeLabel(r.line.piece.colis.taille)})`" :aria-label="incoming(r.line.piece)?.error ? 'Réessayer de recevoir le son' : 'Recevoir le son'" @click="receive(r.line)">
                        <Icon :name="incoming(r.line.piece)?.error ? 'refresh' : 'import'" :size="16" />
                      </button>
                    </template>
                  </div>
                </div>
                <p v-if="!r.line.mine && !r.line.piece.colis && !localTrack(r.line.piece, r.line)" class="hint">
                  Pas dans votre bibliothèque (envoyé sans le fichier).
                </p>
                <p v-if="incoming(r.line.piece)?.error" class="hint error">{{ incoming(r.line.piece)!.error }}</p>
                </template>

                <!-- Playlist -->
                <div v-else-if="r.line.piece?.type === 'playlist'" class="card">
                  <div class="cover pl"><Icon name="playlist" :size="22" /></div>
                  <div class="card-text">
                    <strong>{{ r.line.piece.nom }}</strong>
                    <small>
                      {{ r.line.piece.morceaux.length }} morceau{{ r.line.piece.morceaux.length > 1 ? "x" : "" }}<template v-if="!r.line.mine"> · {{ playlistMatch(r.line.piece)!.found.length }} chez vous</template>
                    </small>
                  </div>
                  <div class="card-action">
                    <button v-if="!r.line.mine && playlistMatch(r.line.piece)!.found.length" type="button" class="round" aria-label="Créer cette playlist ici" title="Créer cette playlist ici" @click="createPlaylist(r.line.piece)">
                      <Icon name="plus" :size="16" />
                    </button>
                  </div>
                </div>

                <p v-if="r.line.texte" class="text">{{ r.line.texte }}</p>
                <span class="meta">
                  {{ timeFormat.format(new Date(r.line.at)) }}
                  <Icon v-if="r.line.mine && r.line === lastMine" name="check" :size="12" />
                </span>
              </div>
            </div>
          </template>
        </div>

        <button v-if="unseen" type="button" class="new-pill" @click="toBottom(true)">
          {{ unseen }} nouveau{{ unseen > 1 ? "x" : "" }} message{{ unseen > 1 ? "s" : "" }} <Icon name="expand" :size="14" />
        </button>

        <footer>
          <div v-if="attachOpen" class="attach" role="dialog" aria-label="Joindre à votre message">
            <div class="attach-head">
              <strong>Joindre</strong>
              <button type="button" class="icon-btn" aria-label="Fermer" @click="attachOpen = false"><Icon name="close" :size="16" /></button>
            </div>
            <button v-if="player.currentTrack" type="button" class="option" @click="attachTrack(player.currentTrack!)">
              <span class="option-cover"><Artwork :track="player.currentTrack" :radius="6" eager /></span>
              <span class="option-text"><strong>Ce que j'écoute</strong><small>{{ player.currentTrack.title }} · {{ player.currentTrack.artist }}</small></span>
            </button>
            <input v-model="query" class="fieldbox search" type="search" placeholder="Chercher un morceau à envoyer…" aria-label="Chercher un morceau à envoyer" />
            <div v-if="results.length" class="results">
              <button v-for="t in results" :key="t.id" type="button" class="option" @click="attachTrack(t)">
                <span class="option-cover"><Artwork :track="t" :radius="6" /></span>
                <span class="option-text"><strong>{{ t.title }}</strong><small>{{ t.artist }}</small></span>
              </button>
            </div>
            <p v-else-if="query.trim()" class="muted none">Aucun morceau trouvé.</p>
            <template v-else-if="playlists.items.length">
              <span class="label">Une playlist</span>
              <div class="chips">
                <button v-for="p in playlists.items" :key="p.id" type="button" class="chip" @click="attachPlaylist(p.id)"><Icon name="playlist" :size="13" /> {{ p.name }}</button>
              </div>
            </template>
          </div>

          <div v-if="piece" class="attached">
            <span class="attached-cover">
              <Artwork v-if="pieceTrack" :track="pieceTrack" :radius="5" eager />
              <Icon v-else name="playlist" :size="16" />
            </span>
            <span class="attached-text">
              <strong>{{ piece.type === "morceau" ? piece.titre : piece.nom }}</strong>
              <small>{{ piece.type === "morceau" ? (friend.pubKey ? "Le fichier part avec le message" : "Titre seulement (proche pas à jour)") : `${piece.morceaux.length} morceaux` }}</small>
            </span>
            <button type="button" class="icon-btn" aria-label="Retirer la pièce jointe" @click="clearPiece"><Icon name="close" :size="15" /></button>
          </div>
          <div v-if="outgoing" class="sending" role="status">
            <span>Envoi du son… {{ percent(outgoing) }} %</span>
            <span class="bar"><span :style="{ width: `${percent(outgoing)}%` }" /></span>
          </div>

          <div class="compose">
            <button type="button" class="icon-btn attach-btn" :class="{ on: attachOpen }" aria-label="Joindre un morceau ou une playlist" :aria-expanded="attachOpen" @click="attachOpen = !attachOpen">
              <Icon name="plus" :size="20" />
            </button>
            <textarea ref="input" v-model="draft" rows="1" placeholder="Votre message" aria-label="Votre message" maxlength="1000" @keydown="onKey" />
            <button type="button" class="send" :disabled="sending || (!draft.trim() && !piece)" aria-label="Envoyer" @click="send">
              <Icon name="share" :size="18" />
            </button>
          </div>
        </footer>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  justify-content: flex-end;
  background: rgba(2, 6, 20, 0.45);
}
.chat {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(100%, 440px);
  height: 100%;
  padding-top: var(--safe-top);
  /* Clavier ouvert : la zone de saisie remonte juste au-dessus. */
  padding-bottom: max(var(--safe-bottom), var(--sa-ime, 0px));
  background: rgb(var(--surface-rgb));
  box-shadow: var(--shadow-lg);
  color: var(--text);
  transition: padding-bottom 0.18s var(--ease);
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--separator);
}
.who {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.who strong {
  font-size: 15.5px;
}
.who small {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}
.who small.playing {
  color: var(--accent);
}

.lines {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 12px 14px;
  display: flex;
  flex-direction: column;
}
.empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  margin: auto;
  max-width: 280px;
  text-align: center;
  color: var(--text-2);
  font-size: 13.5px;
}
.empty p {
  margin: 0;
}
.empty strong {
  color: var(--text);
  font-size: 15px;
}
.empty .pill {
  margin-top: 8px;
}
.day {
  display: flex;
  justify-content: center;
  margin: 14px 0 8px;
}
.day span {
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.07);
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 600;
}

.line {
  display: flex;
  margin-top: 2px;
}
.line.first {
  margin-top: 8px;
}
.line.mine {
  justify-content: flex-end;
}
.bubble {
  position: relative;
  max-width: min(82%, 340px);
  padding: 7px 10px 6px;
  border-radius: 18px;
  background: rgba(var(--fg-rgb), 0.08);
  overflow-wrap: anywhere;
}
.bubble.has-piece {
  width: min(82%, 300px);
  padding: 6px;
}
/* Bulles d'un même groupe : coins resserrés du côté de l'expéditeur. */
.line:not(.mine):not(.first) .bubble {
  border-top-left-radius: 6px;
}
.line:not(.mine):not(.last) .bubble {
  border-bottom-left-radius: 6px;
}
.line.mine .bubble {
  background: var(--accent-soft);
}
.line.mine:not(.first) .bubble {
  border-top-right-radius: 6px;
}
.line.mine:not(.last) .bubble {
  border-bottom-right-radius: 6px;
}
.text {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.4;
  white-space: pre-wrap;
}
.has-piece .text {
  padding: 6px 4px 0;
}
.meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.has-piece .meta {
  padding: 0 4px;
}
.line.mine .meta :deep(svg) {
  color: var(--accent);
}

.card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px;
  border-radius: 12px;
  background: rgba(var(--fg-rgb), 0.06);
}
.cover {
  flex: none;
  width: 48px;
  height: 48px;
  border-radius: 8px;
  overflow: hidden;
}
.cover.pl {
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
}
.card-text {
  display: grid;
  flex: 1;
  min-width: 0;
}
.card-text strong,
.card-text small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-text strong {
  font-size: 14px;
}
.card-text small {
  font-size: 12px;
  color: var(--text-2);
}
.card-text .file {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-3);
  font-size: 11px;
}
.card-action {
  flex: none;
}
.round {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 50%;
  background: rgba(var(--fg-rgb), 0.12);
  color: var(--text);
  cursor: pointer;
}
.round.accent {
  background: var(--accent);
  color: var(--on-accent);
}
.ring {
  --p: 0;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: conic-gradient(var(--accent) calc(var(--p) * 1%), rgba(var(--fg-rgb), 0.12) 0);
  font-size: 10.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.ring span {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(var(--surface-rgb), 1);
}
.hint {
  margin: 4px 4px 0;
  font-size: 11.5px;
  color: var(--text-2);
}
.hint.error {
  color: #ff8a8a;
}

.new-pill {
  position: absolute;
  left: 50%;
  bottom: calc(max(var(--safe-bottom), var(--sa-ime, 0px)) + 78px);
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: var(--shadow-lg);
  cursor: pointer;
}

footer {
  position: relative;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--separator);
}
.compose {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.compose textarea {
  flex: 1;
  min-height: 42px;
  max-height: 132px;
  padding: 10px 14px;
  border: 1px solid rgba(var(--fg-rgb), 0.12);
  border-radius: 21px;
  background: rgba(var(--fg-rgb), 0.06);
  color: var(--text);
  font: inherit;
  font-size: 15px;
  line-height: 1.35;
  resize: none;
  outline: none;
  transition: border-color 0.15s;
}
.compose textarea:focus {
  border-color: var(--accent);
}
.attach-btn {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  transition: transform 0.2s var(--ease), color 0.15s, background 0.15s;
}
.attach-btn.on {
  transform: rotate(45deg);
  color: var(--accent);
}
.send {
  display: grid;
  flex: none;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  cursor: pointer;
  transition: transform 0.12s, opacity 0.15s;
}
.send:active:not(:disabled) {
  transform: scale(0.92);
}
.send:disabled {
  opacity: 0.35;
  cursor: default;
}
.attached {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  padding: 6px 6px 6px 8px;
  border-radius: 14px;
  background: rgba(var(--fg-rgb), 0.06);
  border-left: 3px solid var(--accent);
}
.attached-cover {
  display: grid;
  flex: none;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  overflow: hidden;
  color: var(--accent);
}
.attached-text {
  display: grid;
  flex: 1;
  min-width: 0;
}
.attached-text strong,
.attached-text small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attached-text strong {
  font-size: 13.5px;
}
.attached-text small {
  font-size: 11.5px;
  color: var(--text-2);
}
.sending {
  display: grid;
  gap: 4px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--accent);
}
.bar {
  height: 3px;
  border-radius: 2px;
  background: rgba(var(--fg-rgb), 0.1);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.25s;
}

.attach {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% + 6px);
  display: grid;
  gap: 8px;
  max-height: min(60vh, 440px);
  padding: 10px;
  border-radius: 18px;
  background: rgba(var(--surface-rgb), 1);
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--separator);
  overflow-y: auto;
}
.attach-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-left: 4px;
}
.option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px;
  border: 0;
  border-radius: 10px;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .option:hover {
    background: rgba(var(--fg-rgb), 0.07);
  }
}
.option-cover {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 6px;
  overflow: hidden;
}
.option-text {
  display: grid;
  min-width: 0;
}
.option-text strong,
.option-text small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.option-text strong {
  font-size: 14px;
}
.option-text small {
  font-size: 12px;
  color: var(--text-2);
}
.search {
  width: 100%;
}
.results {
  display: grid;
}
.none {
  margin: 4px;
  font-size: 13px;
}
.label {
  padding-left: 4px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.08);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.chat-enter-active,
.chat-leave-active {
  transition: opacity 0.22s var(--ease);
}
.chat-enter-active .chat,
.chat-leave-active .chat {
  transition: transform 0.26s var(--ease);
}
.chat-enter-from,
.chat-leave-to {
  opacity: 0;
}
.chat-enter-from .chat,
.chat-leave-to .chat {
  transform: translateX(24px);
}
@media (max-width: 640px) {
  .chat {
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chat,
  .attach-btn,
  .chat-enter-active .chat,
  .chat-leave-active .chat {
    transition: none;
  }
}
</style>
