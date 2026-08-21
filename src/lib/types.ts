// Miroir TypeScript des structures Rust (serde) de src-tauri/src/*.rs.
// Garder ces types synchronisés à la main avec les `#[derive(Serialize)]`
// côté Rust — pas de génération automatique pour un projet de cette taille.

export interface Track {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  track_no: number | null;
  duration_secs: number;
  has_cover: boolean;
}

export type RepeatMode = "off" | "one" | "all";

export interface QueueView {
  track_ids: string[];
  position: number | null;
  shuffle: boolean;
  repeat: RepeatMode;
}

export interface PlaybackStatus {
  current_track: Track | null;
  position_secs: number;
  is_paused: boolean;
  volume: number;
}

export interface Playlist {
  id: string;
  name: string;
  track_ids: string[];
}

export interface InitialState {
  library_root: string | null;
  library: Track[];
  queue: QueueView;
  current_track: Track | null;
  position_secs: number;
  volume: number;
  eq_gains: [number, number, number];
  playlists: Playlist[];
}
