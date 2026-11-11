// Mes appareils : chaque appareil lié publie la liste de ses morceaux (chiffrée, dans l'état
// synchronisé), et peut demander à un autre de lui copier ceux qui lui manquent. La copie
// passe par le Wi-Fi quand les deux appareils s'y voient, sinon par le relais chiffré.

import { LibraryMatcher } from "./spotifyImport";
import type { Track } from "./types";

/** Morceau d'un appareil, décrit sans son chemin (qui ne veut rien dire ailleurs). */
export interface InvTrack {
  t: string;
  a: string;
  al: string;
  /** Durée (s, arrondie). */
  d: number;
  /** Taille du fichier (octets), quand elle est connue. */
  s?: number;
}

export interface DeviceInventory {
  /** Identifiant de l'appareil (celui annoncé aux voisins du Wi-Fi). */
  id: string;
  name: string;
  platform: "android" | "pc";
  /** Dernier changement de la liste (ms) : la plus récente gagne. */
  at: number;
  tracks: InvTrack[];
}

export type CopyState = "attente" | "envoi" | "fini" | "echec";

/** Demande de copie : `from` veut des morceaux que `to` possède. */
export interface CopyRequest {
  id: string;
  /** Jeton secret : l'envoi qui le porte est accepté sans question par `from`. */
  token: string;
  from: string;
  to: string;
  tracks: InvTrack[];
  at: number;
  state: CopyState;
  /** Copie demandée par l'option automatique : seulement sur le même Wi-Fi. */
  auto?: boolean;
  /** Code de partage (envoi par le relais), posé par `to`. */
  code?: string | null;
  message?: string | null;
  /** Dernier changement d'état (ms). */
  updated: number;
  /** Lot `part` sur `parts` d'une même demande (copie découpée pour le relais). */
  part?: number;
  parts?: number;
  /** Arrêtée par la personne (sur l'un ou l'autre appareil) : jamais relancée. */
  cancelled?: boolean;
}

/** Morceaux par demande : l'archive est préparée d'un bloc dans le cache de l'appareil. */
export const BATCH_TRACKS = 40;
/**
 * Offre gratuite du relais (Cloudflare) : par le relais, la copie part par lots d'environ
 * 150 Mo, un lot à la fois, avec une pause entre deux lots, et 2 Go par jour au plus (la suite
 * reprend le lendemain). Sur le même Wi-Fi, aucune de ces limites.
 */
export const RELAY_CYCLE_BYTES = 150 * 1024 * 1024;
export const RELAY_DAY_BYTES = 2 * 1024 * 1024 * 1024;
export const RELAY_PAUSE_MS = 30_000;
/** Débit retenu pour estimer la taille d'un morceau dont on ne connaît que la durée (320 kb/s). */
const BYTES_PER_SECOND = 40_000;

const RANK: Record<CopyState, number> = { attente: 0, envoi: 1, fini: 2, echec: 2 };
const DAY = 24 * 3600 * 1000;

export const invKey = (t: { t: string; a: string }) => `${t.a.trim().toLowerCase()}\u0000${t.t.trim().toLowerCase()}`;

export function describeTrack(t: Track): InvTrack {
  return { t: t.title, a: t.artist, al: t.album, d: Math.round(t.duration_secs) };
}

/** Liste des morceaux de cet appareil (sans les fichiers abîmés ni introuvables). */
export function inventoryOf(library: Track[]): InvTrack[] {
  const seen = new Set<string>();
  const out: InvTrack[] = [];
  for (const t of library) {
    if (t.damage || t.duration_secs <= 0) continue;
    const item = describeTrack(t);
    const k = invKey(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out.sort((x, y) => invKey(x).localeCompare(invKey(y)));
}

/** Empreinte d'une liste : la date de l'inventaire ne bouge que si la liste change. */
export function inventoryHash(tracks: InvTrack[]): string {
  let h = 2166136261;
  for (const t of tracks) {
    const s = `${invKey(t)}\u0001${t.d}\u0002`;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return `${tracks.length}-${(h >>> 0).toString(36)}`;
}

/** Fusion des inventaires : un par appareil, le plus récent gagne. */
export function mergeDevices(local: DeviceInventory[], remote: DeviceInventory[]): DeviceInventory[] {
  const out = new Map<string, DeviceInventory>();
  for (const d of [...remote, ...local]) {
    const known = out.get(d.id);
    if (!known || d.at >= known.at) out.set(d.id, d);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Fusion des demandes : l'état le plus avancé gagne ; les vieilles demandes s'effacent. */
export function mergeCopies(local: CopyRequest[], remote: CopyRequest[], now = Date.now()): CopyRequest[] {
  const out = new Map<string, CopyRequest>();
  for (const c of [...remote, ...local]) {
    const known = out.get(c.id);
    if (!known || RANK[c.state] > RANK[known.state] || (RANK[c.state] === RANK[known.state] && c.updated > known.updated)) {
      out.set(c.id, known ? { ...c, code: c.code ?? known.code ?? null } : c);
    }
  }
  return [...out.values()]
    .filter((c) => (RANK[c.state] === 2 ? now - c.updated < 2 * DAY : now - c.at < 7 * DAY))
    .sort((a, b) => a.at - b.at);
}

/** Morceaux de `source` absents de `here` (même rapprochement que la synchronisation : titre,
 *  artiste, album ; les étiquettes d'un appareil à l'autre ne sont pas toujours identiques). */
export function missingFrom(source: InvTrack[], here: InvTrack[]): InvTrack[] {
  const matcher = new LibraryMatcher(here.map(asTrack));
  return source.filter((t) => !matcher.find({ title: t.t, artist: t.a, album: t.al }));
}

function asTrack(t: InvTrack, i: number): Track {
  return { id: String(i), path: "", title: t.t, artist: t.a, album: t.al, album_artist: t.a, track_no: null, disc_no: null, year: null, genre: null, duration_secs: t.d, has_cover: false, added_secs: 0 };
}

/** Morceaux déjà demandés à un appareil et pas encore arrivés. */
export function alreadyAsked(copies: CopyRequest[], from: string, to: string): Set<string> {
  const keys = new Set<string>();
  for (const c of copies) {
    if (c.from === from && c.to === to && (c.state === "attente" || c.state === "envoi")) c.tracks.forEach((t) => keys.add(invKey(t)));
  }
  return keys;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Taille estimée d'un morceau (octets) : la vraie si on la connaît, sinon d'après sa durée. */
export function estimateBytes(t: InvTrack): number {
  return t.s ?? Math.max(1, t.d) * BYTES_PER_SECOND;
}

/** Découpe en lots : 40 morceaux et environ 150 Mo au plus chacun. */
export function batches(tracks: InvTrack[]): InvTrack[][] {
  const out: InvTrack[][] = [];
  let current: InvTrack[] = [];
  let bytes = 0;
  for (const t of tracks) {
    const size = estimateBytes(t);
    if (current.length && (current.length >= BATCH_TRACKS || bytes + size > RELAY_CYCLE_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(t);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

/** Demandes de copie pour ces morceaux, par lots numérotés. */
export function newRequests(from: string, to: string, tracks: InvTrack[], auto = false, now = Date.now()): CopyRequest[] {
  const parts = batches(tracks);
  return parts.map((part, i) => ({
    id: randomHex(8),
    token: `copie-${randomHex(12)}`,
    from,
    to,
    tracks: part,
    at: now,
    updated: now,
    state: "attente" as const,
    auto,
    code: null,
    message: null,
    part: i + 1,
    parts: parts.length,
  }));
}

/** Taille estimée d'une demande (octets). */
export function requestBytes(c: CopyRequest): number {
  return c.tracks.reduce((s, t) => s + estimateBytes(t), 0);
}

/** Morceaux de cette bibliothèque correspondant à une demande (ceux qui y sont encore). */
export function localIds(request: CopyRequest, library: Track[]): string[] {
  const matcher = new LibraryMatcher(library);
  const ids: string[] = [];
  for (const t of request.tracks) {
    const found = matcher.find({ title: t.t, artist: t.a, album: t.al });
    if (found && !ids.includes(found.id)) ids.push(found.id);
  }
  return ids;
}
