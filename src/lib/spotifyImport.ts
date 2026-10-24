// Import depuis Spotify, sans rien télécharger : on lit l'export de données du compte
// (Spotify → Confidentialité → « Télécharger vos données », archive my_spotify_data.zip) ou un
// fichier CSV d'Exportify, puis on retrouve chaque morceau dans la bibliothèque locale. Les
// playlists sont recréées avec les morceaux présents ; les absents sont listés.

import { strFromU8, unzipSync } from "fflate";
import { normalize } from "./duplicates";
import type { Track } from "./types";

export interface SpotifyTrack {
  title: string;
  artist: string;
  album: string;
}

export interface SpotifyPlaylist {
  name: string;
  tracks: SpotifyTrack[];
}

export interface SpotifyExport {
  playlists: SpotifyPlaylist[];
  /** Titres likés (« Titres likés » de Spotify), s'ils sont dans l'export. */
  liked: SpotifyTrack[];
}

interface PlaylistJson {
  playlists?: {
    name?: string;
    items?: { track?: { trackName?: string; artistName?: string; albumName?: string } | null }[];
  }[];
}

interface LibraryJson {
  tracks?: { artist?: string; album?: string; track?: string }[];
}

/** Retire la marque d'ordre des octets (BOM) en tête des fichiers enregistrés par Excel. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function clean(t: SpotifyTrack): SpotifyTrack | null {
  const title = (t.title ?? "").trim();
  if (!title) return null;
  return { title, artist: (t.artist ?? "").trim(), album: (t.album ?? "").trim() };
}

/** Playlists d'un fichier PlaylistN.json de l'export. */
export function parsePlaylistJson(data: PlaylistJson): SpotifyPlaylist[] {
  return (data.playlists ?? [])
    .map((p) => ({
      name: (p.name ?? "").trim() || "Playlist Spotify",
      tracks: (p.items ?? [])
        .map((i) => i.track && clean({ title: i.track.trackName ?? "", artist: i.track.artistName ?? "", album: i.track.albumName ?? "" }))
        .filter((t): t is SpotifyTrack => !!t),
    }))
    .filter((p) => p.tracks.length > 0);
}

/** Titres likés du fichier YourLibrary.json de l'export. */
export function parseLibraryJson(data: LibraryJson): SpotifyTrack[] {
  return (data.tracks ?? [])
    .map((t) => clean({ title: t.track ?? "", artist: t.artist ?? "", album: t.album ?? "" }))
    .filter((t): t is SpotifyTrack => !!t);
}

/** Découpe une ligne CSV (guillemets doublés, virgules dans les champs). */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** CSV d'Exportify (ou similaire) : colonnes « Track Name », « Artist Name(s) », « Album Name ». */
export function parseCsv(text: string, name: string): SpotifyPlaylist | null {
  const rows = csvRows(stripBom(text));
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const ti = col("track name", "track", "title", "titre", "name");
  const ai = col("artist name(s)", "artist name", "artist", "artists", "artiste");
  const al = col("album name", "album");
  if (ti < 0) return null;
  const tracks = rows
    .slice(1)
    .map((r) =>
      clean({
        title: r[ti] ?? "",
        // Exportify sépare les artistes par des virgules : le premier suffit pour retrouver le morceau.
        artist: ai >= 0 ? (r[ai] ?? "").split(/,|;/)[0] : "",
        album: al >= 0 ? (r[al] ?? "") : "",
      }),
    )
    .filter((t): t is SpotifyTrack => !!t);
  return tracks.length ? { name: name.replace(/\.csv$/i, "").replace(/_/g, " ").trim() || "Playlist Spotify", tracks } : null;
}

/** Lit un fichier choisi : archive de l'export, PlaylistN.json, YourLibrary.json ou CSV. */
export function readExportFile(name: string, bytes: Uint8Array): SpotifyExport {
  const out: SpotifyExport = { playlists: [], liked: [] };
  const take = (fileName: string, content: Uint8Array) => {
    const base = fileName.split("/").pop() ?? fileName;
    if (/\.csv$/i.test(base)) {
      const p = parseCsv(strFromU8(content), base);
      if (p) out.playlists.push(p);
      return;
    }
    if (!/\.json$/i.test(base)) return;
    let data: unknown;
    try {
      data = JSON.parse(stripBom(strFromU8(content)));
    } catch {
      return;
    }
    if (/^playlist\d*\.json$/i.test(base) || (data as PlaylistJson)?.playlists) {
      out.playlists.push(...parsePlaylistJson(data as PlaylistJson));
    } else if (/^yourlibrary\.json$/i.test(base) || (data as LibraryJson)?.tracks) {
      out.liked.push(...parseLibraryJson(data as LibraryJson));
    }
  };
  if (/\.zip$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const files = unzipSync(bytes, {
      filter: (f) => /(playlist\d*|yourlibrary)\.json$/i.test(f.name) || /\.csv$/i.test(f.name),
    });
    for (const [fileName, content] of Object.entries(files)) take(fileName, content);
  } else take(name, bytes);
  return out;
}

/** Index de la bibliothèque pour retrouver un morceau par son titre et son artiste. */
export class LibraryMatcher {
  private byTitle = new Map<string, Track[]>();

  constructor(tracks: Track[]) {
    for (const t of tracks) {
      const key = normalize(t.title);
      if (!key) continue;
      const list = this.byTitle.get(key);
      if (list) list.push(t);
      else this.byTitle.set(key, [t]);
    }
  }

  /** Morceau local correspondant, ou null. */
  find(s: SpotifyTrack): Track | null {
    const candidates = this.byTitle.get(normalize(s.title)) ?? [];
    if (!candidates.length) return null;
    const artist = words(s.artist);
    const album = normalize(s.album);
    let best: Track | null = null;
    let bestScore = 0;
    for (const t of candidates) {
      const local = words(`${t.artist} ${t.album_artist}`);
      const shared = [...artist].filter((w) => local.has(w)).length;
      let score = artist.size ? shared / artist.size : 0.5;
      if (album && normalize(t.album) === album) score += 0.3;
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }
    // Artiste inconnu dans les étiquettes locales : accepté si le titre n'existe qu'une fois.
    if (bestScore === 0 && candidates.length === 1 && candidates[0].artist === "Artiste inconnu") return candidates[0];
    return bestScore >= 0.5 ? best : null;
  }
}

function words(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((w) => w.length > 1 && !["the", "les", "le", "la", "and", "et"].includes(w)),
  );
}

export interface MatchedPlaylist {
  name: string;
  found: Track[];
  missing: SpotifyTrack[];
}

export function matchPlaylist(matcher: LibraryMatcher, p: SpotifyPlaylist): MatchedPlaylist {
  const found: Track[] = [];
  const seen = new Set<string>();
  const missing: SpotifyTrack[] = [];
  for (const s of p.tracks) {
    const t = matcher.find(s);
    if (!t) missing.push(s);
    else if (!seen.has(t.id)) {
      seen.add(t.id);
      found.push(t);
    }
  }
  return { name: p.name, found, missing };
}

/** Liste des morceaux absents, une ligne par morceau (« Artiste — Titre »). */
export function missingText(list: SpotifyTrack[]): string {
  return list.map((t) => (t.artist ? `${t.artist} — ${t.title}` : t.title)).join("\n");
}
