// Fine couche typée par-dessus `invoke()` : un point d'entrée unique par commande Rust.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AlignModelStatus,
  DuplicateOutcome,
  InitialState,
  Lyrics,
  LyricsCandidate,
  LyricsUpgrade,
  Playlist,
  PlaylistStyle,
  PlaybackStatus,
  QueueView,
  RepeatMode,
  NearbyPeer,
  ScanProgress,
  ShareImportResult,
  ShareItem,
  ShareOffer,
  TransferProgress,
  Track,
  UpdateInfo,
} from "./types";

// Android : la vue web ne transmet pas d'octets bruts à l'appli (seulement du texte) ; les
// fichiers importés y partent donc en base64.
const ON_ANDROID = /Android/i.test(navigator.userAgent);

function toBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes as BlobPart]));
  });
}

export const api = {
  pickLibraryFolder: () => invoke<string | null>("pick_library_folder"),
  scanLibrary: (root: string) => invoke<Track[]>("scan_library", { root }),
  getLibrary: () => invoke<Track[]>("get_library"),
  openAudioFile: (path: string) => invoke<Track | null>("open_audio_file", { path }),
  getCover: (path: string, trackId: string) => invoke<string | null>("get_cover", { path, trackId }),
  getLyrics: (trackId: string, allowOnline: boolean, refresh = false) =>
    invoke<Lyrics | null>("get_lyrics", { trackId, allowOnline, refresh }),
  /** Recherche en arrière-plan d'une version synchronisée (paroles affichées sans minutage). */
  upgradeLyrics: (trackId: string, force = false) => invoke<LyricsUpgrade>("upgrade_lyrics", { trackId, force }),
  alignmentModelStatus: () => invoke<AlignModelStatus>("alignment_model_status"),
  installAlignmentModel: () => invoke<void>("install_alignment_model"),
  removeAlignmentModel: () => invoke<void>("remove_alignment_model"),
  /** Synchronisation automatique (reconnaissance vocale locale) des paroles sans minutage. */
  alignLyrics: (trackId: string) => invoke<Lyrics | null>("align_lyrics", { trackId }),
  lyricsQuery: (trackId: string) => invoke<string>("lyrics_query", { trackId }),
  searchLyrics: (trackId: string, query: string) =>
    invoke<LyricsCandidate[]>("search_lyrics", { trackId, query }),
  chooseLyrics: (trackId: string, lyricsId: number) => invoke<Lyrics>("choose_lyrics", { trackId, lyricsId }),
  dismissLyrics: (trackId: string) => invoke<void>("dismiss_lyrics", { trackId }),

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
  /** Journal d'écoute complet (rétrospective). */
  getListens: () => invoke<import("./recap").Listen[]>("get_listens"),
  /** Enregistre une image (carte de la rétrospective) dans Images ; renvoie son chemin. */
  saveImage: async (png: Uint8Array, name: string) => invoke<string>("save_image", { png: await toBase64(png), name }),
  /** Icône des raccourcis Windows (menu Démarrer, Bureau, barre des tâches) ; PNG absent = d'origine. */
  syncAppIcon: async (png: Uint8Array | null, force = false) =>
    invoke<number | null>("sync_app_icon", { png: png ? await toBase64(png) : null, force }),
  /** Renvoie la piste lancée si rien ne jouait, sinon null. */
  queuePlayNext: (trackIds: string[]) => invoke<Track | null>("queue_play_next", { trackIds }),
  queueAppend: (trackIds: string[]) => invoke<Track | null>("queue_append", { trackIds }),
  getQueue: () => invoke<QueueView>("get_queue"),
  getPlaybackStatus: () => invoke<PlaybackStatus>("get_playback_status"),
  pollAutoAdvance: () => invoke<Track | null>("poll_auto_advance"),

  listPlaylists: () => invoke<Playlist[]>("list_playlists"),
  createPlaylist: (name: string, theme?: string) => invoke<string>("create_playlist", { name, theme: theme ?? null }),
  setPlaylistTheme: (id: string, theme: string) => invoke<void>("set_playlist_theme", { id, theme }),
  setPlaylistStyle: (id: string, style: PlaylistStyle | null) => invoke<void>("set_playlist_style", { id, style }),
  setAppearance: (value: unknown) => invoke<void>("set_appearance", { value }),
  /** Envoie un fichier importé tel quel (sans passer par du JSON) ; renvoie son nom. */
  importAsset: async (kind: "font" | "image", ext: string, bytes: Uint8Array) =>
    ON_ANDROID
      ? invoke<string>("import_asset", { kind, ext, data: await toBase64(bytes) })
      : invoke<string>("import_asset", bytes, { headers: { "x-kind": kind, "x-ext": ext } }),
  deleteAsset: (name: string) => invoke<void>("delete_asset", { name }),
  deletePlaylist: (id: string) => invoke<void>("delete_playlist", { id }),
  renamePlaylist: (id: string, name: string) => invoke<void>("rename_playlist", { id, name }),
  addToPlaylist: (playlistId: string, trackId: string) =>
    invoke<void>("add_to_playlist", { playlistId, trackId }),
  addTracksToPlaylist: (playlistId: string, trackIds: string[]) =>
    invoke<number>("add_tracks_to_playlist", { playlistId, trackIds }),
  removeFromPlaylist: (playlistId: string, trackId: string) =>
    invoke<void>("remove_from_playlist", { playlistId, trackId }),
  moveTrackInPlaylist: (playlistId: string, from: number, to: number) =>
    invoke<void>("move_track_in_playlist", { playlistId, from, to }),

  setEqGains: (gains: [number, number, number]) => invoke<void>("set_eq_gains", { gains }),
  getEqGains: () => invoke<[number, number, number]>("get_eq_gains"),

  /** Inverse l'état « aimé » d'un morceau ; renvoie le nouvel état. */
  toggleFavorite: (trackId: string) => invoke<boolean>("toggle_favorite", { trackId }),
  listFavorites: () => invoke<string[]>("list_favorites"),
  /** Aime plusieurs morceaux d'un coup ; renvoie le nombre ajouté. */
  addFavorites: (trackIds: string[]) => invoke<number>("add_favorites", { trackIds }),
  /** Visualiseur : spectre du son joué (32 bandes, 0 à 255 ; vide en pause). */
  getSpectrum: () => invoke<number[]>("get_spectrum"),
  /** Fichier audio reçu au lancement (« Ouvrir avec »), une seule fois. */
  takeOpenedFile: () => invoke<string | null>("take_opened_file"),
  /** Windows : inscrit l'appli comme lecteur possible et ouvre « Applications par défaut ». */
  makeDefaultPlayer: () => invoke<void>("make_default_player"),
  /** Retire les doublons choisis (corbeille sur ordinateur) ; playlists et favoris suivent la copie gardée. */
  removeDuplicates: (groups: { keep: string; remove: string[] }[]) =>
    invoke<DuplicateOutcome>("remove_duplicates", { groups }),

  /** Chemin créé, ou `null` si la boîte de dialogue a été annulée (ordinateur). */
  exportTrack: (trackId: string) => invoke<string | null>("export_track", { trackId }),
  exportPlaylist: (playlistId: string) => invoke<string | null>("export_playlist", { playlistId }),
  pickShareFile: () => invoke<string | null>("pick_share_file"),
  importShareBundle: (path: string) => invoke<ShareImportResult>("import_share_bundle", { path }),

  /** Visible des appareils voisins (même réseau) sous ce nom, prêt à recevoir. */
  nearbyStart: (name: string, code: string | null) => invoke<void>("nearby_start", { name, code }),
  nearbyStop: () => invoke<void>("nearby_stop"),
  nearbyScan: () => invoke<NearbyPeer[]>("nearby_scan"),
  nearbyAnswer: (id: string, accept: boolean) => invoke<void>("nearby_answer", { id, accept }),
  nearbySend: (peer: NearbyPeer, item: ShareItem, from: string, transferId: string) =>
    invoke<void>("nearby_send", { peer, item, from, transferId }),
  defaultRelay: () => invoke<string | null>("default_relay"),
  /** Réserve une salle sur le relais ; renvoie le code à transmettre au destinataire. */
  remoteSendStart: (item: ShareItem, from: string, relay: string | null, transferId: string) =>
    invoke<{ code: string }>("remote_send_start", { item, from, relay, transferId }),
  remoteReceive: (code: string, relay: string | null, transferId: string) =>
    invoke<ShareImportResult>("remote_receive", { code, relay, transferId }),
  transferCancel: (id: string) => invoke<void>("transfer_cancel", { id }),

  getInitialState: () => invoke<InitialState>("get_initial_state"),
  saveSession: () => invoke<void>("save_session"),

  checkUpdate: () => invoke<UpdateInfo | null>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
};

/** Partage : avancement des transferts, envois proposés par un voisin, archives importées. */
export async function onShareEvents(handlers: {
  progress: (p: TransferProgress) => void;
  offer: (id: string, offer: ShareOffer) => void;
  received: (result: ShareImportResult) => void;
}): Promise<UnlistenFn> {
  try {
    const offs = await Promise.all([
      listen<TransferProgress>("share-progress", (e) => handlers.progress(e.payload)),
      listen<{ id: string; offer: ShareOffer }>("nearby-offer", (e) => handlers.offer(e.payload.id, e.payload.offer)),
      listen<ShareImportResult>("share-received", (e) => handlers.received(e.payload)),
    ]);
    return () => offs.forEach((off) => off());
  } catch {
    return () => {};
  }
}

/** Avancement de la synchronisation automatique et du téléchargement de son modèle. */
export async function onAlignEvents(handlers: {
  progress: (trackId: string, fraction: number) => void;
  model: (done: number, total: number) => void;
}): Promise<UnlistenFn> {
  try {
    const off1 = await listen<{ track_id: string; fraction: number }>("align-progress", (e) =>
      handlers.progress(e.payload.track_id, e.payload.fraction),
    );
    const off2 = await listen<{ done: number; total: number }>("align-model-progress", (e) =>
      handlers.model(e.payload.done, e.payload.total),
    );
    return () => {
      off1();
      off2();
    };
  } catch {
    return () => {};
  }
}

/** Abonnements aux événements du scan (sans effet dans le mode démo du navigateur). */
export async function onScanEvents(handlers: {
  progress: (p: ScanProgress) => void;
  updated: (tracks: Track[]) => void;
}): Promise<UnlistenFn> {
  try {
    const off1 = await listen<ScanProgress>("scan-progress", (e) => handlers.progress(e.payload));
    const off2 = await listen<Track[]>("library-updated", (e) => handlers.updated(e.payload));
    return () => {
      off1();
      off2();
    };
  } catch {
    return () => {};
  }
}
