import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { PlaybackStatus, QueueView, RepeatMode, Track } from "@/lib/types";

// Sondage du moteur audio : une fois par seconde en lecture (la position affichée est
// extrapolée entre deux), toutes les 2 s en pause, jamais quand l'appli est cachée
// (l'enchaînement des morceaux se fait côté Rust et prévient l'interface).
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;

export const usePlayerStore = defineStore("player", {
  state: () => ({
    currentTrack: null as Track | null,
    positionSecs: 0,
    /** Instant (performance.now) où `positionSecs` a été mesurée : sert à l'interpoler. */
    positionStamp: 0,
    isPaused: true,
    volume: 1,
    queueIds: [] as string[],
    queuePosition: null as number | null,
    shuffle: false,
    repeat: "off" as RepeatMode,
    error: null as string | null,
    busy: false,
  }),
  getters: {
    /** Position estimée entre deux sondages (utile pour synchroniser les paroles). */
    positionAt:
      (state) =>
      (now: number): number => {
        if (state.isPaused || !state.currentTrack) return state.positionSecs;
        const elapsed = (now - state.positionStamp) / 1000;
        return Math.min(state.positionSecs + Math.max(0, elapsed), state.currentTrack.duration_secs || Infinity);
      },
    upNextIds: (state): string[] =>
      state.queuePosition === null ? state.queueIds : state.queueIds.slice(state.queuePosition + 1),
  },
  actions: {
    setPosition(secs: number) {
      this.positionSecs = secs;
      this.positionStamp = performance.now();
    },
    setFromInitialState(init: {
      current_track: Track | null;
      position_secs: number;
      volume: number;
      queue: QueueView;
    }) {
      this.currentTrack = init.current_track;
      this.setPosition(init.position_secs);
      this.volume = init.volume;
      this.isPaused = true;
      this.applyQueue(init.queue);
    },
    applyStatus(status: PlaybackStatus) {
      const sameTrack = status.current_track?.id === this.currentTrack?.id;
      if (!sameTrack) this.currentTrack = status.current_track;
      if (sameTrack && !status.is_paused && !this.isPaused) {
        // Lecture en cours : la position affichée avance toute seule. Le moteur n'est
        // suivi que s'il s'en écarte vraiment, et sans jamais reculer pour quelques
        // centièmes (la ligne des paroles « repasserait » sur des mots).
        const shown = this.positionAt(performance.now());
        const drift = status.position_secs - shown;
        if (drift > 0.6 || drift < -0.35) this.setPosition(status.position_secs);
        else if (drift > 0.04) this.setPosition(shown + drift / 2);
      } else {
        this.setPosition(status.position_secs);
      }
      this.isPaused = status.is_paused;
      this.volume = status.volume;
    },
    applyQueue(q: QueueView) {
      this.queueIds = q.track_ids;
      this.queuePosition = q.position;
      this.shuffle = q.shuffle;
      this.repeat = q.repeat;
    },
    async afterTrackChange(track: Track | null) {
      this.currentTrack = track;
      this.setPosition(0);
      this.isPaused = track === null;
      await this.refreshQueue();
    },
    async run(action: () => Promise<Track | null>) {
      this.error = null;
      this.busy = true;
      try {
        await this.afterTrackChange(await action());
      } catch (e) {
        this.error = String(e);
      } finally {
        this.busy = false;
      }
    },
    playQueue(trackIds: string[], startId?: string | null) {
      return this.run(() => api.playQueue(trackIds, startId ?? null));
    },
    playShuffled(trackIds: string[]) {
      const shuffled = [...trackIds];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return this.playQueue(shuffled, shuffled[0]);
    },
    playTrackNow(trackId: string) {
      return this.run(() => api.playTrackNow(trackId));
    },
    next() {
      return this.run(() => api.nextTrack());
    },
    async previous() {
      // Comme sur tous les lecteurs : au-delà de 3 s, « précédent » revient au début.
      if (this.positionAt(performance.now()) > 3 && this.currentTrack) {
        await this.seek(0);
        return;
      }
      await this.run(() => api.previousTrack());
    },
    async togglePlayPause() {
      this.error = null;
      try {
        const paused = await api.togglePlayPause();
        this.setPosition(this.positionAt(performance.now()));
        this.isPaused = paused;
        // Reprise : on se recale tout de suite sur la position exacte du moteur.
        if (!paused) await this.refreshStatus();
      } catch (e) {
        this.error = String(e);
      }
    },
    async seek(positionSecs: number) {
      this.error = null;
      try {
        await api.seek(positionSecs);
        this.setPosition(positionSecs);
      } catch (e) {
        this.error = String(e);
      }
    },
    async setVolume(volume: number) {
      this.volume = volume;
      try {
        await api.setVolume(volume);
      } catch (e) {
        this.error = String(e);
      }
    },
    async setShuffle(on: boolean) {
      this.shuffle = on;
      try {
        await api.setShuffle(on);
        await this.refreshQueue();
      } catch (e) {
        this.error = String(e);
      }
    },
    async cycleRepeat() {
      const next: RepeatMode = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
      await this.setRepeat(next);
    },
    async setRepeat(mode: RepeatMode) {
      this.repeat = mode;
      try {
        await api.setRepeat(mode);
      } catch (e) {
        this.error = String(e);
      }
    },
    async removeFromQueue(index: number) {
      try {
        await api.removeFromQueue(index);
        await this.refreshQueue();
      } catch (e) {
        this.error = String(e);
      }
    },
    async refreshQueue() {
      this.applyQueue(await api.getQueue());
    },
    async refreshStatus() {
      this.applyStatus(await api.getPlaybackStatus());
    },
    async pollTick() {
      if (this.busy) return;
      try {
        const advanced = await api.pollAutoAdvance();
        if (advanced !== null) {
          await this.afterTrackChange(advanced);
        } else {
          await this.refreshStatus();
        }
      } catch {
        // Sondage « au mieux » : une erreur ponctuelle ne doit pas inonder l'interface.
      }
    },
    startPolling() {
      if (polling) return;
      polling = true;
      const loop = async () => {
        pollTimer = null;
        if (!polling) return;
        if (!document.hidden) await this.pollTick();
        if (polling) pollTimer = setTimeout(loop, this.isPaused ? 2000 : 1000);
      };
      void loop();
      document.addEventListener("visibilitychange", onVisible);
    },
    stopPolling() {
      polling = false;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      document.removeEventListener("visibilitychange", onVisible);
    },
  },
});

// Retour au premier plan : état du moteur relu tout de suite.
function onVisible() {
  if (!document.hidden) void usePlayerStore().pollTick();
}
