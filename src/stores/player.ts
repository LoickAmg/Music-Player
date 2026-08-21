import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { PlaybackStatus, QueueView, RepeatMode, Track } from "@/lib/types";

let pollHandle: ReturnType<typeof setInterval> | null = null;

export const usePlayerStore = defineStore("player", {
  state: () => ({
    currentTrack: null as Track | null,
    positionSecs: 0,
    isPaused: true,
    volume: 1,
    queueIds: [] as string[],
    queuePosition: null as number | null,
    shuffle: false,
    repeat: "off" as RepeatMode,
    error: null as string | null,
  }),
  actions: {
    setFromInitialState(init: {
      current_track: Track | null;
      position_secs: number;
      volume: number;
      queue: QueueView;
    }) {
      this.currentTrack = init.current_track;
      this.positionSecs = init.position_secs;
      this.volume = init.volume;
      this.isPaused = true;
      this.applyQueue(init.queue);
    },
    applyStatus(status: PlaybackStatus) {
      this.currentTrack = status.current_track;
      this.positionSecs = status.position_secs;
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
      this.positionSecs = 0;
      this.isPaused = track === null;
      await this.refreshQueue();
    },
    async playQueue(trackIds: string[], startId?: string | null) {
      this.error = null;
      try {
        const track = await api.playQueue(trackIds, startId ?? null);
        await this.afterTrackChange(track);
      } catch (e) {
        this.error = String(e);
      }
    },
    async playTrackNow(trackId: string) {
      this.error = null;
      try {
        const track = await api.playTrackNow(trackId);
        await this.afterTrackChange(track);
      } catch (e) {
        this.error = String(e);
      }
    },
    async togglePlayPause() {
      this.error = null;
      try {
        this.isPaused = await api.togglePlayPause();
      } catch (e) {
        this.error = String(e);
      }
    },
    async next() {
      this.error = null;
      try {
        const track = await api.nextTrack();
        await this.afterTrackChange(track);
      } catch (e) {
        this.error = String(e);
      }
    },
    async previous() {
      this.error = null;
      try {
        const track = await api.previousTrack();
        await this.afterTrackChange(track);
      } catch (e) {
        this.error = String(e);
      }
    },
    async seek(positionSecs: number) {
      this.error = null;
      try {
        await api.seek(positionSecs);
        this.positionSecs = positionSecs;
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
    // Appelé à chaque tick du sondage : détecte une fin de piste côté
    // Rust et avance automatiquement, sinon se contente de rafraîchir la
    // position de lecture (pour la barre de progression).
    async pollTick() {
      try {
        const advanced = await api.pollAutoAdvance();
        if (advanced !== null) {
          await this.afterTrackChange(advanced);
        } else {
          await this.refreshStatus();
        }
      } catch {
        // Le sondage est best-effort : une erreur ponctuelle (ex : device
        // audio momentanément indisponible) ne doit pas spammer l'UI.
      }
    },
    startPolling() {
      if (pollHandle) return;
      pollHandle = setInterval(() => {
        void this.pollTick();
      }, 1000);
    },
    stopPolling() {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    },
  },
});
