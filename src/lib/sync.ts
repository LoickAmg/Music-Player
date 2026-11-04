// Appareils liés : playlists, titres aimés et écoute gardés identiques d'un appareil à l'autre,
// sans compte. L'état commun est chiffré ici avec une clé que seuls les appareils liés
// possèdent, et gardé par le relais, qui n'en voit rien.
//
// Fusion à trois : l'état de cet appareil, celui du relais, et le dernier état synchronisé (la
// base). Ce qui était dans la base et manque d'un côté a été supprimé ; ce qui n'y était pas a
// été ajouté. Les suppressions suivent donc d'un appareil à l'autre, sans date ni horloge.

import { LibraryMatcher } from "./spotifyImport";
import type { BackupTrack } from "./backup";
import { relay } from "./friendsApi";
import type { Listen } from "./recap";
import type { Playlist, PlaylistStyle, Track } from "./types";

const CHUNK = 900_000;

export interface SyncPlaylist {
  name: string;
  theme: string;
  style: PlaylistStyle | null;
  tracks: BackupTrack[];
}

export interface SyncDoc {
  format: "music-player-synchro";
  version: 1;
  playlists: SyncPlaylist[];
  favorites: BackupTrack[];
  listens: Listen[];
}

/** Ce que la base retient : pas l'écoute, qui ne fait que s'additionner. */
export type SyncBase = Pick<SyncDoc, "playlists" | "favorites">;

export const EMPTY_BASE: SyncBase = { playlists: [], favorites: [] };

export function emptyDoc(): SyncDoc {
  return { format: "music-player-synchro", version: 1, playlists: [], favorites: [], listens: [] };
}

export function parseDoc(text: string): SyncDoc {
  const data = JSON.parse(text) as Partial<SyncDoc>;
  if (data.format !== "music-player-synchro" || !Array.isArray(data.playlists)) throw new Error("État de synchronisation illisible.");
  return { ...emptyDoc(), ...data } as SyncDoc;
}

const trackKey = (t: BackupTrack) => `${t.artist.toLowerCase()}\u0000${t.title.toLowerCase()}`;
const playlistKey = (name: string) => name.trim().toLowerCase();
const listenKey = (l: Listen) => `${l.started}\u0000${l.title}`;

function describe(t: Track): BackupTrack {
  return { title: t.title, artist: t.artist, album: t.album, duration: Math.round(t.duration_secs) };
}

/** Fusion à trois d'un ensemble : l'ordre de cet appareil, puis ce qui arrive de l'autre côté. */
function mergeSet<T>(base: T[], local: T[], remote: T[], key: (item: T) => string): T[] {
  const inBase = new Set(base.map(key));
  const inLocal = new Set(local.map(key));
  const inRemote = new Set(remote.map(key));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of local) {
    const k = key(item);
    if (!seen.has(k) && (inRemote.has(k) || !inBase.has(k))) {
      seen.add(k);
      out.push(item);
    }
  }
  for (const item of remote) {
    const k = key(item);
    if (!seen.has(k) && !inLocal.has(k) && !inBase.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/** Valeur simple modifiée d'un seul côté : ce côté gagne ; des deux côtés : cet appareil. */
function mergeValue<T>(base: T | undefined, local: T, remote: T): T {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return base !== undefined && same(base, local) ? remote : local;
}

export function mergeDocs(base: SyncBase, local: SyncDoc, remote: SyncDoc): SyncDoc {
  const find = (list: SyncPlaylist[], name: string) => list.find((p) => playlistKey(p.name) === playlistKey(name));
  const playlists = mergeSet(base.playlists, local.playlists, remote.playlists, (p) => playlistKey(p.name)).map((p) => {
    const b = find(base.playlists, p.name);
    const l = find(local.playlists, p.name);
    const r = find(remote.playlists, p.name);
    if (!l || !r) return p;
    return {
      name: l.name,
      theme: mergeValue(b?.theme, l.theme, r.theme),
      style: mergeValue(b?.style, l.style, r.style),
      tracks: mergeSet(b?.tracks ?? [], l.tracks, r.tracks, trackKey),
    };
  });
  const known = new Set(local.listens.map(listenKey));
  return {
    ...emptyDoc(),
    playlists,
    favorites: mergeSet(base.favorites, local.favorites, remote.favorites, trackKey),
    listens: [...local.listens, ...remote.listens.filter((l) => !known.has(listenKey(l)))],
  };
}

/**
 * Morceaux de cet appareil vus par la synchronisation. Chaque appareil a ses propres fichiers
 * et ses étiquettes : un morceau de la base absent de sa bibliothèque n'a pas été supprimé (il
 * est gardé tel quel), et celui retrouvé sous d'autres étiquettes garde sa description commune.
 */
function localTracks(known: BackupTrack[], ids: string[], matcher: LibraryMatcher, byId: (id: string) => Track | null): BackupTrack[] {
  const wanted = new Set(ids);
  const used = new Set<string>();
  const out: BackupTrack[] = [];
  for (const t of known) {
    const found = matcher.find(t);
    if (!found) out.push(t);
    else if (wanted.has(found.id)) {
      used.add(found.id);
      out.push(t);
    }
  }
  for (const id of ids) {
    if (used.has(id)) continue;
    const track = byId(id);
    if (track) out.push(describe(track));
  }
  return out;
}

export interface DeviceState {
  playlists: Playlist[];
  favoriteIds: string[];
  library: Track[];
  listens: Listen[];
}

/** État de cet appareil, décrit par rapport à la base. */
export function localDoc(base: SyncBase, device: DeviceState): SyncDoc {
  const matcher = new LibraryMatcher(device.library);
  const byIdMap = new Map(device.library.map((t) => [t.id, t]));
  const byId = (id: string) => byIdMap.get(id) ?? null;
  return {
    ...emptyDoc(),
    playlists: device.playlists.map((p) => {
      const known = base.playlists.find((b) => playlistKey(b.name) === playlistKey(p.name))?.tracks ?? [];
      return {
        name: p.name,
        theme: p.theme,
        // Image importée : propre à l'appareil, elle ne voyage pas.
        style: p.style ? { ...p.style, image: null } : null,
        tracks: localTracks(known, p.track_ids, matcher, byId),
      };
    }),
    favorites: localTracks(base.favorites, device.favoriteIds, matcher, byId),
    listens: device.listens,
  };
}

export interface SyncPlan {
  createPlaylists: { name: string; theme: string; style: PlaylistStyle | null; ids: string[] }[];
  deletePlaylists: string[];
  addTracks: { id: string; ids: string[] }[];
  removeTracks: { id: string; ids: string[] }[];
  restyle: { id: string; theme: string; style: PlaylistStyle | null }[];
  addFavorites: string[];
  removeFavorites: string[];
  listens: Listen[];
}

/** Ce qu'il faut changer sur cet appareil pour qu'il corresponde à l'état fusionné. */
export function planApply(merged: SyncDoc, device: DeviceState): SyncPlan {
  const matcher = new LibraryMatcher(device.library);
  const byId = new Map(device.library.map((t) => [t.id, t]));
  /** Ajouts et retraits pour passer de `ids` à `tracks`. Deux fichiers aux mêmes étiquettes
   *  valent le même morceau : aucun n'est échangé contre l'autre. */
  const diff = (tracks: BackupTrack[], ids: string[]) => {
    const wanted = new Set(tracks.map(trackKey));
    const found = new Set<string>();
    for (const t of tracks) {
      const id = matcher.find(t)?.id;
      if (id) found.add(id);
    }
    const haveKeys = new Set<string>();
    for (const id of ids) {
      const t = byId.get(id);
      if (t) haveKeys.add(trackKey(describe(t)));
    }
    const add: string[] = [];
    for (const t of tracks) {
      const id = matcher.find(t)?.id;
      if (id && !haveKeys.has(trackKey(t)) && !ids.includes(id) && !add.includes(id)) add.push(id);
    }
    // Morceau absent du disque (« introuvable ») : son sort n'est pas celui de la synchronisation.
    const remove = ids.filter((id) => {
      const t = byId.get(id);
      return !!t && !found.has(id) && !wanted.has(trackKey(describe(t)));
    });
    return { add, remove };
  };
  const plan: SyncPlan = { createPlaylists: [], deletePlaylists: [], addTracks: [], removeTracks: [], restyle: [], addFavorites: [], removeFavorites: [], listens: [] };
  for (const m of merged.playlists) {
    const mine = device.playlists.find((p) => playlistKey(p.name) === playlistKey(m.name));
    if (!mine) {
      plan.createPlaylists.push({ name: m.name, theme: m.theme, style: m.style, ids: diff(m.tracks, []).add });
      continue;
    }
    const { add, remove } = diff(m.tracks, mine.track_ids);
    if (add.length) plan.addTracks.push({ id: mine.id, ids: add });
    if (remove.length) plan.removeTracks.push({ id: mine.id, ids: remove });
    const style = mine.style ? { ...mine.style, image: null } : null;
    if (mine.theme !== m.theme || JSON.stringify(style) !== JSON.stringify(m.style)) {
      plan.restyle.push({ id: mine.id, theme: m.theme, style: m.style ? { ...m.style, image: mine.style?.image ?? null } : mine.style?.image ? { image: mine.style.image } : null });
    }
  }
  for (const p of device.playlists) {
    if (!merged.playlists.some((m) => playlistKey(m.name) === playlistKey(p.name))) plan.deletePlaylists.push(p.id);
  }
  const favorites = diff(merged.favorites, device.favoriteIds);
  plan.addFavorites = favorites.add;
  plan.removeFavorites = favorites.remove;
  const known = new Set(device.listens.map(listenKey));
  plan.listens = merged.listens
    .filter((l) => !known.has(listenKey(l)))
    .map((l) => {
      const found = matcher.find({ title: l.title, artist: l.artist, album: l.album });
      return found ? { ...l, track_id: found.id } : l;
    });
  return plan;
}

/** Suppressions prévues : au-delà d'un seuil, la personne confirme (voir `suspicious`). */
export function deletions(plan: SyncPlan): number {
  return plan.deletePlaylists.length + plan.removeFavorites.length + plan.removeTracks.reduce((s, r) => s + r.ids.length, 0);
}

/** Beaucoup de suppressions d'un coup ressemblent plus à un incident qu'à une décision. */
export function suspicious(plan: SyncPlan, device: DeviceState): boolean {
  const total = device.favoriteIds.length + device.playlists.reduce((s, p) => s + p.track_ids.length + 1, 0);
  return deletions(plan) > Math.max(10, total * 0.3);
}

export function asBase(doc: SyncDoc): SyncBase {
  return { playlists: doc.playlists, favorites: doc.favorites };
}

/** Comparaison de deux états, sans tenir compte de l'ordre des écoutes. */
export function sameDoc(a: SyncDoc, b: SyncDoc): boolean {
  const norm = (d: SyncDoc) =>
    JSON.stringify({
      p: [...d.playlists].map((p) => ({ ...p, tracks: p.tracks.map(trackKey).sort() })).sort((x, y) => x.name.localeCompare(y.name)),
      f: d.favorites.map(trackKey).sort(),
      l: d.listens.map(listenKey).sort(),
    });
  return norm(a) === norm(b);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Nouvelle clé de synchronisation (base64), donnée aux appareils liés et à eux seuls. */
export function newSyncKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

async function aesKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(key) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(key: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(key), new TextEncoder().encode(text)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64(out);
}

export async function decrypt(key: string, data: string): Promise<string> {
  const bytes = fromBase64(data);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, await aesKey(key), bytes.subarray(12));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("État de synchronisation illisible : liez de nouveau cet appareil.");
  }
}

export interface SyncIdentity {
  base: string;
  code: string;
  secret: string;
  key: string;
}

/** État du relais et sa version ; null s'il n'y en a pas encore. */
export async function downloadDoc(id: SyncIdentity): Promise<{ doc: SyncDoc; version: string } | null> {
  const first = await relay.syncRead(id.base, id.code, id.secret, 0).catch((e: { status?: number }) => {
    if (e.status === 404) return null;
    throw e;
  });
  if (!first) return null;
  const parts = [first.data];
  for (let n = 1; n < first.total; n++) {
    const next = await relay.syncRead(id.base, id.code, id.secret, n);
    if (next.version !== first.version) throw new Error("Un autre appareil vient de publier.");
    parts.push(next.data);
  }
  return { doc: parseDoc(await decrypt(id.key, parts.join(""))), version: first.version };
}

/** Publie un état, seulement si le relais en est toujours à la version `attendu`. */
export async function uploadDoc(id: SyncIdentity, doc: SyncDoc, attendu: string | null): Promise<void> {
  const data = await encrypt(id.key, JSON.stringify(doc));
  const total = Math.max(1, Math.ceil(data.length / CHUNK));
  const envoi = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  for (let n = 0; n < total; n++) {
    await relay.syncWrite(id.base, id.code, id.secret, { envoi, attendu, n, total, data: data.slice(n * CHUNK, (n + 1) * CHUNK) });
  }
}
