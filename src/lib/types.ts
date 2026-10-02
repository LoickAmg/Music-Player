// Miroir TypeScript des structures Rust (serde) de src-tauri/src/*.rs, à garder
// synchronisé à la main avec les `#[derive(Serialize)]` côté Rust.

export interface Track {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  track_no: number | null;
  disc_no: number | null;
  year: number | null;
  genre: string | null;
  duration_secs: number;
  has_cover: boolean;
  added_secs: number;
  /** Fichier illisible (abîmé, téléchargement inachevé) : la raison. */
  damage?: string | null;
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
  /** Thème de la jaquette générée (voir lib/playlistThemes.ts). */
  theme: string;
}

export interface LyricLine {
  time_ms: number;
  text: string;
}

export interface Lyrics {
  synced: LyricLine[] | null;
  plain: string | null;
  instrumental: boolean;
  source: string;
}

/** Proposition de la recherche manuelle de paroles (LRCLIB). */
export interface LyricsCandidate {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  duration: number | null;
  synced: boolean;
  instrumental: boolean;
  preview: string | null;
}

export interface ScanProgress {
  done: number;
  total: number;
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
  scanning: boolean;
}

/** Album reconstitué côté interface à partir des pistes. */
export interface Album {
  key: string;
  title: string;
  artist: string;
  year: number | null;
  tracks: Track[];
  /** Piste dont on affiche la pochette (la première qui en a une). */
  coverTrack: Track | null;
  addedSecs: number;
  durationSecs: number;
}

export interface Artist {
  name: string;
  albums: Album[];
  tracks: Track[];
}

/** Nouvelle version proposée par la mise à jour automatique (ordinateur). */
export interface UpdateInfo {
  version: string;
  current: string;
  notes: string | null;
  /** Android : adresse de l'APK à télécharger. */
  url: string | null;
  /** Android : taille de l'APK (octets). */
  size: number | null;
}
