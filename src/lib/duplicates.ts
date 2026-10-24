// Repérage des doublons : même morceau (titre et artiste rapprochés) de même durée, à
// quelques secondes près. La copie à garder est proposée d'après la qualité du fichier.

import type { Track } from "./types";

export interface DuplicateGroup {
  key: string;
  tracks: Track[];
  /** Copie proposée à garder (la meilleure). */
  keep: string;
}

/** Écart de durée toléré entre deux copies (secondes). */
const TOLERANCE = 3;

const NOISE = [
  /\((official|offici[eè]l+e?)[^)]*\)/g,
  /\[(official|offici[eè]l+e?)[^\]]*\]/g,
  /\((audio|lyrics?|paroles|clip|video|vid[eé]o|hd|hq|4k|visualizer)[^)]*\)/g,
  /\[(audio|lyrics?|paroles|clip|video|vid[eé]o|hd|hq|4k|visualizer)[^\]]*\]/g,
  /\s[-–]\s*(remaster(ed)?|remasteris[eé]e?)(\s\d{4})?$/g,
  /\((\d{4}\s)?remaster(ed)?(\s\d{4})?\)/g,
  /\s\(\d\)$/g, // « Titre (1) » : copie de fichier
  /\s[-–]\s*(copie|copy)(\s\(\d+\))?$/g,
];

/** Texte comparable : minuscules, sans accents, sans les mentions de mise en ligne. */
export function normalize(text: string): string {
  let s = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  for (const re of NOISE) s = s.replace(re, "");
  return s
    .replace(/^\d{1,3}\s*[-._)]\s*/, "") // numéro de piste en tête du nom
    .replace(/\s*\(?(feat|ft)\.?\s.*$/, "") // invités
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function artistKey(t: Track): string {
  const a = t.artist === "Artiste inconnu" ? "" : t.artist;
  return normalize(a.split(/,|&| x | et /i)[0] ?? "");
}

const EXT_RANK: Record<string, number> = { flac: 6, wav: 5, aiff: 5, alac: 5, m4a: 4, aac: 3, ogg: 3, opus: 3, mp3: 2, wma: 1 };

function ext(t: Track): string {
  return t.path.split(".").pop()?.toLowerCase() ?? "";
}

/** Qualité d'une copie : format, pochette, étiquettes complètes, nom propre. */
export function score(t: Track): number {
  let s = (EXT_RANK[ext(t)] ?? 0) * 10;
  if (t.has_cover) s += 6;
  if (t.album !== "Album inconnu") s += 3;
  if (t.artist !== "Artiste inconnu") s += 3;
  if (t.year) s += 1;
  if (t.track_no) s += 1;
  if (/\(\d\)\.[^.]+$|copie|copy/i.test(t.path)) s -= 4;
  return s;
}

export function findDuplicates(tracks: Track[]): DuplicateGroup[] {
  const byName = new Map<string, Track[]>();
  for (const t of tracks) {
    const title = normalize(t.title);
    if (!title || t.duration_secs <= 0) continue;
    const key = `${artistKey(t)}\u0000${title}`;
    const list = byName.get(key);
    if (list) list.push(t);
    else byName.set(key, [t]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [key, list] of byName) {
    if (list.length < 2) continue;
    // Même nom, durées différentes (version live, remix, extrait) : pas des doublons.
    const sorted = [...list].sort((a, b) => a.duration_secs - b.duration_secs);
    let cluster: Track[] = [sorted[0]];
    const flush = () => {
      if (cluster.length > 1) {
        const best = [...cluster].sort((a, b) => score(b) - score(a) || a.path.length - b.path.length)[0];
        groups.push({ key: `${key}\u0000${cluster[0].id}`, tracks: cluster, keep: best.id });
      }
    };
    for (const t of sorted.slice(1)) {
      if (t.duration_secs - cluster[cluster.length - 1].duration_secs <= TOLERANCE) cluster.push(t);
      else {
        flush();
        cluster = [t];
      }
    }
    flush();
  }
  return groups.sort((a, b) => a.tracks[0].title.localeCompare(b.tracks[0].title, "fr"));
}

/** Format affiché à côté d'une copie (« FLAC », « MP3 »). */
export function formatLabel(t: Track): string {
  return ext(t).toUpperCase();
}
