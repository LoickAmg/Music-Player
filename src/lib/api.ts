// Fine couche typée par-dessus `invoke()` : un point d'entrée unique par
// commande Rust, pour ne jamais avoir à retaper une chaîne de commande ou
// une forme de payload à la main dans les stores/composants.

import { invoke } from "@tauri-apps/api/core";
import type { InitialState, Playlist, PlaybackStatus, QueueView, RepeatMode, Track } from "./types";

export const api = {
  pickLibraryFolder: () => invoke<string | null>("pick_library_folder"),
  scanLibrary: (root: string) => invoke<Track[]>("scan_library", { root }),
  getLibrary: () => invoke<Track[]>("get_library"),
  getCover: (path: string) => invoke<string | null>("get_cover", { path }),

  playQueue: (trackIds: string[], startId?: string | null) =>
    invoke<Track | null>("play_queue", { trackIds, startId: startId ?? null }),
  playTrackNow: (trackId: string) => invoke<Track | null>("play_track_now", { trackId }),
  togglePlayPause: () => invoke<boolean>("toggle_play_pause"),
  nextTrack: () => invoke<Track | null>("next_track"),
  previousTrack: () => invoke<Track | null>("previous_track"),
  seek: (positionSecs: number) => invoke<void>("seek", { positionSecs }),
  setVolume: (volume: number) => invoke<void>("set_volume", { volume }),
  setShuffle: (on: boolean) => invoke<void>("set_shuffle", { on }),
  setRepeat: (mode: RepeatMode) => invoke<void>("set_repeat", { mode }),
  removeFromQueue: (index: number) => invoke<void>("remove_from_queue", { index }),
  getQueue: () => invoke<QueueView>("get_queue"),
  getPlaybackStatus: () => invoke<PlaybackStatus>("get_playback_status"),
  pollAutoAdvance: () => invoke<Track | null>("poll_auto_advance"),

  listPlaylists: () => invoke<Playlist[]>("list_playlists"),
  createPlaylist: (name: string) => invoke<string>("create_playlist", { name }),
  deletePlaylist: (id: string) => invoke<void>("delete_playlist", { id }),
  renamePlaylist: (id: string, name: string) => invoke<void>("rename_playlist", { id, name }),
  addToPlaylist: (playlistId: string, trackId: string) =>
    invoke<void>("add_to_playlist", { playlistId, trackId }),
  removeFromPlaylist: (playlistId: string, trackId: string) =>
    invoke<void>("remove_from_playlist", { playlistId, trackId }),
  moveTrackInPlaylist: (playlistId: string, from: number, to: number) =>
    invoke<void>("move_track_in_playlist", { playlistId, from, to }),

  setEqGains: (gains: [number, number, number]) => invoke<void>("set_eq_gains", { gains }),
  getEqGains: () => invoke<[number, number, number]>("get_eq_gains"),

  getInitialState: () => invoke<InitialState>("get_initial_state"),
  saveSession: () => invoke<void>("save_session"),
};
