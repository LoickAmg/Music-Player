<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Piece } from "@/lib/friendsApi";
import { LibraryMatcher, matchPlaylist } from "@/lib/spotifyImport";
import { useFriendsStore } from "@/stores/friends";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { usePlaylistsStore } from "@/stores/playlists";
import { useUiStore } from "@/stores/ui";
import FriendAvatar from "./FriendAvatar.vue";
import Icon from "./Icon.vue";

// Discussion avec un proche : texte, morceau ou playlist (décrits ; chacun les retrouve dans
// sa propre bibliothèque). Passe par le relais des Proches, gardée sur l'appareil.
const friends = useFriendsStore();
const library = useLibraryStore();
const player = usePlayerStore();
const playlists = usePlaylistsStore();
const ui = useUiStore();

const friend = computed(() => friends.friends.find((f) => f.code === friends.chatWith) ?? null);
const lines = computed(() => (friend.value ? (friends.conversations[friend.value.code] ?? []) : []));
const draft = ref("");
const piece = ref<Piece | null>(null);
const sending = ref(false);
const list = ref<HTMLElement | null>(null);
const matcher = computed(() => new LibraryMatcher(library.tracks));

watch(
  () => [friends.chatWith, lines.value.length],
  async () => {
    await nextTick();
    list.value?.scrollTo({ top: list.value.scrollHeight });
  },
  { immediate: true },
);

const timeFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
function when(at: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? timeFormat.format(d) : `${dayFormat.format(d)} ${timeFormat.format(d)}`;
}

function attachCurrent() {
  const t = player.currentTrack;
  if (!t) return;
  piece.value = { type: "morceau", titre: t.title, artiste: t.artist, album: t.album };
}
function attachPlaylist(id: string) {
  const p = playlists.byId(id);
  if (!p) return;
  const morceaux = p.track_ids
    .map((tid) => library.byId(tid))
    .filter((t) => !!t)
    .slice(0, 300)
    .map((t) => ({ titre: t!.title, artiste: t!.artist, album: t!.album }));
  if (morceaux.length) piece.value = { type: "playlist", nom: p.name, morceaux };
}

async function send() {
  if (!friend.value || sending.value || (!draft.value.trim() && !piece.value)) return;
  sending.value = true;
  const ok = await friends.sendWord(friend.value.code, draft.value, piece.value);
  sending.value = false;
  if (ok) {
    draft.value = "";
    piece.value = null;
  } else if (friends.error) ui.notify(friends.error);
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

/** Morceau reçu présent dans ma bibliothèque. */
function localTrack(p: Piece) {
  return p.type === "morceau" ? matcher.value.find({ title: p.titre, artist: p.artiste, album: p.album }) : null;
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
</script>

<template>
  <Transition name="chat">
    <div v-if="friend" class="scrim" @click.self="friends.openChat(null)">
      <section class="chat" role="dialog" aria-modal="true" :aria-label="`Discussion avec ${friend.name}`">
        <header>
          <button type="button" class="icon-btn" aria-label="Fermer la discussion" @click="friends.openChat(null)"><Icon name="back" :size="18" /></button>
          <FriendAvatar :name="friend.name" :src="friend.avatar" :size="34" />
          <div class="who">
            <strong>{{ friend.name }}</strong>
            <small v-if="friends.live[friend.code]?.status?.playing">♪ {{ friends.live[friend.code]!.status!.title }} · {{ friends.live[friend.code]!.status!.artist }}</small>
          </div>
        </header>

        <div ref="list" class="lines">
          <p v-if="!lines.length" class="empty">Écrivez à {{ friend.name }}, ou envoyez-lui le morceau que vous écoutez.</p>
          <div v-for="(l, i) in lines" :key="i" class="line" :class="{ mine: l.mine }">
            <div class="bubble">
              <p v-if="l.texte" class="text">{{ l.texte }}</p>
              <div v-if="l.piece?.type === 'morceau'" class="piece">
                <Icon name="note" :size="18" />
                <span class="piece-text">
                  <strong>{{ l.piece.titre }}</strong>
                  <small>{{ l.piece.artiste }}</small>
                </span>
                <button v-if="localTrack(l.piece)" type="button" class="pill pill-ghost small" @click="player.playTrackNow(localTrack(l.piece)!.id)">
                  <Icon name="play" :size="13" /> Écouter
                </button>
                <small v-else-if="!l.mine" class="absent">Pas dans votre bibliothèque</small>
              </div>
              <div v-else-if="l.piece?.type === 'playlist'" class="piece">
                <Icon name="playlist" :size="18" />
                <span class="piece-text">
                  <strong>{{ l.piece.nom }}</strong>
                  <small>
                    {{ l.piece.morceaux.length }} morceau{{ l.piece.morceaux.length > 1 ? "x" : "" }}
                    <template v-if="!l.mine"> · {{ playlistMatch(l.piece)!.found.length }} chez vous</template>
                  </small>
                </span>
                <button v-if="!l.mine && playlistMatch(l.piece)!.found.length" type="button" class="pill pill-ghost small" @click="createPlaylist(l.piece)">
                  <Icon name="plus" :size="13" /> Créer
                </button>
              </div>
              <time>{{ when(l.at) }}</time>
            </div>
          </div>
        </div>

        <footer>
          <div v-if="piece" class="attached">
            <Icon :name="piece.type === 'morceau' ? 'note' : 'playlist'" :size="15" />
            <span>{{ piece.type === "morceau" ? `${piece.titre} · ${piece.artiste}` : `${piece.nom} (${piece.morceaux.length} morceaux)` }}</span>
            <button type="button" class="icon-btn" aria-label="Retirer la pièce jointe" @click="piece = null"><Icon name="close" :size="14" /></button>
          </div>
          <div class="compose">
            <button type="button" class="icon-btn" title="Joindre le morceau en cours" aria-label="Joindre le morceau en cours" :disabled="!player.currentTrack" @click="attachCurrent">
              <Icon name="note" :size="18" />
            </button>
            <label class="icon-btn pick" title="Joindre une playlist" aria-label="Joindre une playlist">
              <Icon name="playlist" :size="18" />
              <select @change="attachPlaylist(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
                <option value="">Joindre une playlist…</option>
                <option v-for="p in playlists.items" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </label>
            <textarea v-model="draft" rows="1" placeholder="Votre message" aria-label="Votre message" maxlength="1000" @keydown="onKey" />
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
  display: flex;
  flex-direction: column;
  width: min(100%, 420px);
  height: 100%;
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
  background: rgba(var(--surface-rgb), 0.98);
  box-shadow: var(--shadow-lg);
  color: var(--text);
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--separator);
}
.who {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.who small {
  color: var(--accent);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lines {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.empty {
  margin: auto;
  max-width: 260px;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
}
.line {
  display: flex;
}
.line.mine {
  justify-content: flex-end;
}
.bubble {
  max-width: 82%;
  padding: 8px 10px 4px;
  border-radius: 14px 14px 14px 4px;
  background: rgba(var(--fg-rgb), 0.08);
  user-select: text;
}
.mine .bubble {
  border-radius: 14px 14px 4px 14px;
  background: var(--accent-soft);
}
.text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.45;
}
.piece {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding: 8px;
  border-radius: 10px;
  background: rgba(var(--fg-rgb), 0.06);
  color: var(--accent);
}
.piece-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  color: var(--text);
}
.piece-text strong,
.piece-text small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.piece-text small,
.absent {
  font-size: 11.5px;
  color: var(--text-2);
}
.pill.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
time {
  display: block;
  margin-top: 2px;
  text-align: right;
  font-size: 10.5px;
  color: var(--text-3);
}
footer {
  padding: 8px 10px 10px;
  border-top: 1px solid var(--separator);
}
.attached {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  padding: 4px 4px 4px 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12.5px;
}
.attached span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.compose {
  display: flex;
  align-items: flex-end;
  gap: 4px;
}
.pick {
  position: relative;
  cursor: pointer;
}
.pick select {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
textarea {
  flex: 1;
  min-height: 36px;
  max-height: 120px;
  padding: 8px 12px;
  border: 0;
  border-radius: 18px;
  background: rgba(var(--fg-rgb), 0.08);
  resize: none;
  font-size: 14px;
  user-select: text;
}
.send {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
}
.send:disabled {
  opacity: 0.4;
}
.chat-enter-active,
.chat-leave-active {
  transition: opacity 0.2s ease;
}
.chat-enter-active .chat,
.chat-leave-active .chat {
  transition: transform 0.25s var(--ease);
}
.chat-enter-from,
.chat-leave-to {
  opacity: 0;
}
.chat-enter-from .chat,
.chat-leave-to .chat {
  transform: translateX(40px);
}
@media (prefers-reduced-motion: reduce) {
  .chat-enter-active .chat,
  .chat-leave-active .chat {
    transition: none;
  }
}
</style>
