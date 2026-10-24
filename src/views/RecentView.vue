<script setup lang="ts">
import RecapBanner from "@/components/RecapBanner.vue";
import { computed } from "vue";
import { useLibraryStore } from "@/stores/library";
import { usePlayerStore } from "@/stores/player";
import { useUiStore } from "@/stores/ui";
import Icon from "@/components/Icon.vue";
import FriendAvatar from "@/components/FriendAvatar.vue";
import { useFriendsStore } from "@/stores/friends";
import TrackRow from "@/components/TrackRow.vue";

const library = useLibraryStore();
const player = usePlayerStore();
const ui = useUiStore();
const friends = useFriendsStore();

// Les vrais ajouts récents, piste par piste : un album bucketé par sa piste la plus
// récente montrait tout un album ancien dès qu'un seul morceau y était ajouté ou retouché.
const recentTracks = computed(() => [...library.tracks].sort((a, b) => b.added_secs - a.added_secs).slice(0, 60));

function play(index: number) {
  const ids = recentTracks.value.map((t) => t.id);
  void player.playQueue(ids, ids[index]);
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">Ajouts récents</h1>
    <RecapBanner />
    <div v-if="friends.listening.length" class="friends-strip">
      <button v-for="x in friends.listening.slice(0, 8)" :key="x.friend.code" type="button" class="friend-chip" @click="ui.go({ name: 'friends' })">
        <FriendAvatar :name="x.friend.name" :src="x.friend.avatar" :size="34" :live="x.status.playing" />
        <span>
          <strong>{{ x.friend.name }}</strong>
          <small>{{ x.status.playing ? "♪" : "En pause ·" }} {{ x.status.title }} · {{ x.status.artist }}</small>
        </span>
      </button>
    </div>
    <button v-else-if="ui.isMobile" type="button" class="voices-link" @click="ui.go({ name: 'friends' })">
      <Icon name="user" :size="18" />
      <span>
        <strong>Proches</strong>
        <small>{{
          friends.enabled ? (friends.incoming.length ? `${friends.incoming.length} demande(s) reçue(s)` : "Voir ce qu'écoutent vos proches") : "Ajoutez-vous avec vos codes d'ami"
        }}</small>
      </span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button v-if="library.voices.length" type="button" class="voices-link" @click="ui.go({ name: 'voices' })">
      <Icon name="mic" :size="18" />
      <span>
        <strong>Vocaux et enregistrements</strong>
        <small>{{ library.voices.length }} fichier{{ library.voices.length > 1 ? "s" : "" }} rangé{{ library.voices.length > 1 ? "s" : "" }} à part de la musique</small>
      </span>
      <span class="chev" aria-hidden="true">›</span>
    </button>

    <section>
      <div class="head">
        <h2>Morceaux</h2>
        <button type="button" class="more" @click="ui.go({ name: 'songs' })">Tout afficher</button>
      </div>
      <div class="list">
        <div v-for="(track, i) in recentTracks" :key="track.id" class="row">
          <TrackRow :track="track" :index="i" striped @play="play(i)" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
section {
  margin-bottom: 34px;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 700;
}
.more {
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
}
.row {
  height: 52px;
}
.friends-strip {
  display: flex;
  gap: 10px;
  margin: 0 0 14px;
  overflow-x: auto;
  scrollbar-width: none;
}
.friend-chip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 280px;
  padding: 8px 14px 8px 8px;
  border: 0;
  border-radius: 999px;
  background: rgba(var(--fg-rgb), 0.06);
  color: var(--text);
  text-align: left;
}
.friend-chip span {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.friend-chip strong {
  font-size: 13px;
}
.friend-chip small {
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.voices-link {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin: 0 0 24px;
  padding: 12px 14px;
  border: 0;
  border-radius: 12px;
  background: rgba(var(--fg-rgb), 0.06);
  color: var(--text);
  text-align: left;
}
.voices-link:hover {
  background: rgba(var(--fg-rgb), 0.1);
}
.voices-link > :first-child {
  color: var(--accent);
}
.voices-link span:not(.chev) {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.voices-link strong {
  font-size: 14px;
}
.voices-link small {
  font-size: 12px;
  color: var(--text-2);
}
.chev {
  font-size: 20px;
  color: var(--text-2);
}
</style>
