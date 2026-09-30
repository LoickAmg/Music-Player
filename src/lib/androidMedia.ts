// Pont avec la notification de lecture Android (écran verrouillé, volet de notifications,
// casque Bluetooth). L'activité Android expose `window.AndroidMedia` ; ses commandes
// reviennent par `window.__mpMedia`. Sans effet ailleurs (ordinateur, navigateur).

import { watch } from "vue";
import { api } from "./api";
import type { usePlayerStore } from "@/stores/player";

interface AndroidMediaBridge {
  update(json: string): void;
  clear(): void;
}

declare global {
  interface Window {
    AndroidMedia?: AndroidMediaBridge;
    __mpMedia?: (command: string, arg: number) => void;
  }
}

type Player = ReturnType<typeof usePlayerStore>;

export function installAndroidMedia(player: Player) {
  const bridge = window.AndroidMedia;
  if (!bridge) return;

  window.__mpMedia = (command, arg) => {
    if (!player.currentTrack) return;
    switch (command) {
      case "play":
        if (player.isPaused) void player.togglePlayPause();
        break;
      case "pause":
        if (!player.isPaused) void player.togglePlayPause();
        break;
      case "toggle":
        void player.togglePlayPause();
        break;
      case "next":
        void player.next();
        break;
      case "previous":
        void player.previous();
        break;
      case "seek":
        void player.seek(arg / 1000);
        break;
    }
  };

  let coverFor = "";
  let coverPath = "";
  async function publish() {
    const track = player.currentTrack;
    if (!track) {
      bridge!.clear();
      return;
    }
    if (coverFor !== track.id) {
      coverFor = track.id;
      coverPath = "";
      if (track.has_cover) {
        try {
          coverPath = (await api.getCover(track.path, track.id)) ?? "";
        } catch {
          // pas de pochette : la notification s'en passe
        }
      }
    }
    bridge!.update(
      JSON.stringify({
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: Math.round(track.duration_secs * 1000),
        positionMs: Math.round(player.positionAt(performance.now()) * 1000),
        playing: !player.isPaused,
        cover: coverPath,
      }),
    );
  }

  watch(() => [player.currentTrack?.id, player.isPaused], () => void publish(), { immediate: true });
  // Position de la barre de progression de l'écran verrouillé après un saut.
  player.$onAction(({ name, after }) => {
    if (name === "seek") after(() => void publish());
  });
}
