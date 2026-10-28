// Sauvegarde des données de l'utilisateur dans un fichier .mpsave (JSON) : playlists, titres
// aimés, historique d'écoute, apparence, réglages. Les morceaux y sont décrits (titre,
// artiste, album, durée) et non désignés par leur identifiant, propre à chaque appareil : à
// la restauration, ils sont retrouvés dans la bibliothèque comme pour l'import Spotify.

import { LibraryMatcher, type SpotifyTrack } from "./spotifyImport";
import type { Listen } from "./recap";
import type { Playlist, PlaylistStyle, Track } from "./types";

export const BACKUP_FORMAT = "music-player-sauvegarde";

export interface BackupTrack extends SpotifyTrack {
  duration: number;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  /** Date de création (ISO) et appareil d'origine. */
  created: string;
  device: string;
  playlists: { name: string; theme: string; style: PlaylistStyle | null; tracks: BackupTrack[] }[];
  favorites: BackupTrack[];
  listens: Listen[];
  appearance: unknown;
  /** Réglages de l'appareil gardés dans le navigateur (clés « mp:… »). */
  prefs: Record<string, string>;
}

/** Réglages recopiés d'un appareil à l'autre (les autres dépendent de l'appareil). */
const PREF_KEYS = ["mp:visuels", "mp:lyrics-online-auto", "mp:lyrics-align", "mp:separate-voices", "mp:proches", "mp:proches-mots"];

function describe(t: Track): BackupTrack {
  return { title: t.title, artist: t.artist, album: t.album, duration: Math.round(t.duration_secs) };
}

export function buildBackup(input: {
  device: string;
  playlists: Playlist[];
  favoriteIds: string[];
  byId: (id: string) => Track | null;
  listens: Listen[];
  appearance: unknown;
}): Backup {
  const tracks = (ids: string[]) => ids.map(input.byId).filter((t): t is Track => !!t).map(describe);
  const prefs: Record<string, string> = {};
  for (const key of PREF_KEYS) {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) prefs[key] = value;
    } catch {
      // stockage indisponible : réglages non sauvegardés
    }
  }
  return {
    format: BACKUP_FORMAT,
    version: 1,
    created: new Date().toISOString(),
    device: input.device,
    playlists: input.playlists.map((p) => ({
      name: p.name,
      theme: p.theme,
      // Image importée (fichier propre à l'appareil) : la jaquette repart sur son dégradé.
      style: p.style ? { ...p.style, image: null } : null,
      tracks: tracks(p.track_ids),
    })),
    favorites: tracks(input.favoriteIds),
    listens: input.listens,
    appearance: input.appearance,
    prefs,
  };
}

export function parseBackup(text: string): Backup {
  let data: Partial<Backup>;
  try {
    data = JSON.parse(text) as Partial<Backup>;
  } catch {
    throw new Error("Ce fichier n'est pas une sauvegarde Music Player.");
  }
  if (data.format !== BACKUP_FORMAT || !Array.isArray(data.playlists)) {
    throw new Error("Ce fichier n'est pas une sauvegarde Music Player.");
  }
  return {
    format: BACKUP_FORMAT,
    version: 1,
    created: String(data.created ?? ""),
    device: String(data.device ?? ""),
    playlists: data.playlists,
    favorites: Array.isArray(data.favorites) ? data.favorites : [],
    listens: Array.isArray(data.listens) ? data.listens : [],
    appearance: data.appearance ?? null,
    prefs: data.prefs && typeof data.prefs === "object" ? data.prefs : {},
  };
}

/** Correspondances d'une sauvegarde avec la bibliothèque de cet appareil. */
export interface RestorePlan {
  playlists: { name: string; theme: string; style: PlaylistStyle | null; found: Track[]; missing: BackupTrack[] }[];
  favorites: Track[];
  favoritesMissing: number;
  /** Écoutes, rattachées aux morceaux de cet appareil quand ils sont retrouvés. */
  listens: Listen[];
}

export function planRestore(backup: Backup, library: Track[]): RestorePlan {
  const matcher = new LibraryMatcher(library);
  const find = (t: SpotifyTrack) => matcher.find(t);
  const playlists = backup.playlists.map((p) => {
    const found: Track[] = [];
    const missing: BackupTrack[] = [];
    for (const t of p.tracks) {
      const local = find(t);
      if (local && !found.includes(local)) found.push(local);
      else if (!local) missing.push(t);
    }
    return { name: p.name, theme: p.theme, style: p.style, found, missing };
  });
  const favorites: Track[] = [];
  let favoritesMissing = 0;
  for (const t of backup.favorites) {
    const local = find(t);
    if (local) favorites.push(local);
    else favoritesMissing += 1;
  }
  const listens = backup.listens.map((l) => {
    const local = find({ title: l.title, artist: l.artist, album: l.album });
    return local ? { ...l, track_id: local.id } : l;
  });
  return { playlists, favorites, favoritesMissing, listens };
}

/** Réglages de l'appareil restaurés (clés connues seulement). */
export function restorePrefs(prefs: Record<string, string>) {
  for (const key of PREF_KEYS) {
    if (typeof prefs[key] !== "string") continue;
    try {
      localStorage.setItem(key, prefs[key]);
    } catch {
      // stockage indisponible
    }
  }
}

/** Même morceau d'une sauvegarde à l'autre (titre et artiste, sans tenir compte de la casse). */
function trackKey(t: BackupTrack): string {
  return `${t.artist.toLowerCase()}\u0000${t.title.toLowerCase()}`;
}

function unionTracks(a: BackupTrack[], b: BackupTrack[]): BackupTrack[] {
  const seen = new Set(a.map(trackKey));
  return [...a, ...b.filter((t) => !seen.has(trackKey(t)))];
}

/**
 * Sauvegarde du compte partagée par plusieurs appareils : celle de cet appareil (`mine`) est
 * fusionnée avec celle déjà en ligne (`online`) au lieu de la remplacer. Playlists réunies par
 * nom, titres aimés et écoutes additionnés ; apparence et réglages de cet appareil, identité
 * des Proches gardée si cet appareil n'en a pas.
 */
export function mergeBackups(mine: Backup, online: Backup): Backup {
  const playlists = mine.playlists.map((p) => {
    const other = online.playlists.find((o) => o.name.toLowerCase() === p.name.toLowerCase());
    return other ? { ...p, tracks: unionTracks(p.tracks, other.tracks) } : p;
  });
  for (const o of online.playlists) {
    if (!playlists.some((p) => p.name.toLowerCase() === o.name.toLowerCase())) playlists.push(o);
  }
  const listenKey = (l: Listen) => `${l.started}\u0000${l.title}`;
  const known = new Set(mine.listens.map(listenKey));
  const prefs = { ...online.prefs, ...mine.prefs };
  if (!mine.prefs["mp:proches"] && online.prefs["mp:proches"]) prefs["mp:proches"] = online.prefs["mp:proches"];
  return {
    ...mine,
    playlists,
    favorites: unionTracks(mine.favorites, online.favorites),
    listens: [...mine.listens, ...online.listens.filter((l) => !known.has(listenKey(l)))],
    prefs,
  };
}
