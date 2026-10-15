/**
 * Rétrospective d'écoute (mois ou année), calculée à partir du journal d'écoute enregistré
 * côté Rust. Les dates sont lues dans l'heure locale de l'appareil (jour, heure, mois).
 */
export interface Listen {
  track_id: string;
  title: string;
  artist: string;
  album: string;
  genre?: string | null;
  /** Début de l'écoute, secondes Unix. */
  started: number;
  /** Temps réellement écouté (secondes). */
  secs: number;
  duration_secs: number;
}

export type Period = { kind: "month"; year: number; month: number } | { kind: "year"; year: number };

export interface Ranked {
  key: string;
  label: string;
  sub: string;
  /** Un morceau qui représente l'entrée (pour la pochette). */
  trackId: string;
  secs: number;
  plays: number;
}

export interface Personality {
  id: string;
  title: string;
  text: string;
}

export interface Recap {
  period: Period;
  label: string;
  totalSecs: number;
  plays: number;
  trackCount: number;
  artistCount: number;
  albumCount: number;
  /** Jours où au moins un morceau a été écouté. */
  activeDays: number;
  topTracks: Ranked[];
  topArtists: Ranked[];
  topAlbums: Ranked[];
  topGenres: Ranked[];
  /** Mois : secondes par jour du mois ; année : secondes par mois. */
  timeline: number[];
  byHour: number[];
  /** Lundi = 0. */
  byWeekday: number[];
  bestDay: { date: Date; secs: number } | null;
  longestStreak: { days: number; from: Date; to: Date } | null;
  /** Plus grand nombre d'écoutes d'un même morceau en un jour. */
  obsession: { track: Ranked; plays: number; date: Date } | null;
  firstListen: Listen | null;
  /** Artistes entendus pour la première fois sur la période (si l'historique remonte avant). */
  discoveries: string[];
  hasEarlierHistory: boolean;
  previousTotalSecs: number;
  personality: Personality;
}

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export function monthName(month: number): string {
  return MONTHS[month] ?? "";
}

/** Une écoute compte comme « écoute » complète au-delà de 30 s, ou de la moitié d'un morceau court. */
export function isPlay(l: Listen): boolean {
  return l.secs >= 30 || (l.duration_secs > 0 && l.secs >= l.duration_secs * 0.5);
}

export function periodLabel(p: Period): string {
  return p.kind === "year" ? String(p.year) : `${monthName(p.month)} ${p.year}`;
}

export function periodRange(p: Period): [Date, Date] {
  return p.kind === "year" ? [new Date(p.year, 0, 1), new Date(p.year + 1, 0, 1)] : [new Date(p.year, p.month, 1), new Date(p.year, p.month + 1, 1)];
}

export function previousPeriod(p: Period): Period {
  if (p.kind === "year") return { kind: "year", year: p.year - 1 };
  return p.month === 0 ? { kind: "month", year: p.year - 1, month: 11 } : { kind: "month", year: p.year, month: p.month - 1 };
}

export function nextPeriod(p: Period): Period {
  if (p.kind === "year") return { kind: "year", year: p.year + 1 };
  return p.month === 11 ? { kind: "month", year: p.year + 1, month: 0 } : { kind: "month", year: p.year, month: p.month + 1 };
}

function inRange(l: Listen, [from, to]: [Date, Date]): boolean {
  const ms = l.started * 1000;
  return ms >= from.getTime() && ms < to.getTime();
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function rank(listens: Listen[], keyOf: (l: Listen) => string | null, describe: (l: Listen) => { label: string; sub: string }, by: "plays" | "secs"): Ranked[] {
  const map = new Map<string, Ranked & { lastSecs: number }>();
  for (const l of listens) {
    const key = keyOf(l);
    if (!key) continue;
    const entry = map.get(key) ?? { key, ...describe(l), trackId: l.track_id, secs: 0, plays: 0, lastSecs: 0 };
    entry.secs += l.secs;
    if (isPlay(l)) entry.plays += 1;
    // Pochette : le morceau le plus écouté de l'entrée.
    if (l.secs > entry.lastSecs) {
      entry.lastSecs = l.secs;
      entry.trackId = l.track_id;
    }
    map.set(key, entry);
  }
  return [...map.values()]
    .map((entry) => ({ key: entry.key, label: entry.label, sub: entry.sub, trackId: entry.trackId, secs: entry.secs, plays: entry.plays }))
    .sort((a, b) => (by === "plays" ? b.plays - a.plays || b.secs - a.secs : b.secs - a.secs || b.plays - a.plays));
}

const UNKNOWN = /^(artiste|album) inconnu$/i;
const norm = (s: string) => s.trim().toLowerCase();

function personalityOf(r: Omit<Recap, "personality">): Personality {
  const total = r.totalSecs || 1;
  const night = [22, 23, 0, 1, 2, 3, 4].reduce((s, h) => s + r.byHour[h], 0) / total;
  const morning = [5, 6, 7, 8].reduce((s, h) => s + r.byHour[h], 0) / total;
  const topArtistShare = (r.topArtists[0]?.secs ?? 0) / total;
  const topTrackShare = r.plays ? (r.topTracks[0]?.plays ?? 0) / r.plays : 0;
  const variety = r.plays ? r.artistCount / r.plays : 0;
  if (night >= 0.3) return { id: "nuit", title: "Oiseau de nuit", text: "Ta musique s'allume quand la ville s'éteint : une bonne part de tes écoutes a lieu entre 22 h et 5 h." };
  if (morning >= 0.3) return { id: "aube", title: "Lève-tôt", text: "Tu commences la journée en musique : tes écoutes se concentrent tôt le matin." };
  if (topTrackShare >= 0.15) return { id: "boucle", title: "Boucle infinie", text: "Quand un morceau te plaît, tu ne le lâches plus : ton titre préféré revient encore et encore." };
  if (topArtistShare >= 0.35) return { id: "fidele", title: "Fan inconditionnel", text: `${r.topArtists[0]?.label} occupe une place à part : plus d'un tiers de ton temps d'écoute.` };
  if (variety >= 0.4 && r.artistCount >= 15) return { id: "explorateur", title: "Explorateur", text: "Tu passes d'un univers à l'autre sans t'arrêter : un artiste différent presque à chaque écoute." };
  if ((r.bestDay?.secs ?? 0) >= 4 * 3600) return { id: "marathon", title: "Marathonien", text: "Des journées entières en musique : ton record dépasse quatre heures d'écoute." };
  return { id: "melomane", title: "Mélomane", text: "Un peu de tout, beaucoup d'envie : ta musique t'accompagne au fil des jours." };
}

export function buildRecap(all: Listen[], period: Period): Recap {
  const range = periodRange(period);
  const listens = all.filter((l) => inRange(l, range)).sort((a, b) => a.started - b.started);
  const previous = all.filter((l) => inRange(l, periodRange(previousPeriod(period))));
  const earlier = all.filter((l) => l.started * 1000 < range[0].getTime());

  const plays = listens.filter(isPlay).length;
  const artistKey = (l: Listen) => (UNKNOWN.test(l.artist.trim()) ? null : norm(l.artist));
  const albumKey = (l: Listen) => (UNKNOWN.test(l.album.trim()) ? null : `${norm(l.album)}|${norm(l.artist)}`);

  const topTracks = rank(listens, (l) => l.track_id, (l) => ({ label: l.title, sub: l.artist }), "plays");
  const topArtists = rank(listens, artistKey, (l) => ({ label: l.artist, sub: "" }), "secs");
  const topAlbums = rank(listens, albumKey, (l) => ({ label: l.album, sub: l.artist }), "secs");
  const topGenres = rank(listens, (l) => (l.genre?.trim() ? norm(l.genre) : null), (l) => ({ label: l.genre!.trim(), sub: "" }), "secs");

  const days = period.kind === "month" ? new Date(period.year, period.month + 1, 0).getDate() : 12;
  const timeline = Array.from({ length: days }, () => 0);
  const byHour = Array.from({ length: 24 }, () => 0);
  const byWeekday = Array.from({ length: 7 }, () => 0);
  const perDay = new Map<string, { date: Date; secs: number }>();
  const trackPerDay = new Map<string, { trackId: string; date: Date; plays: number }>();
  for (const l of listens) {
    const d = new Date(l.started * 1000);
    timeline[period.kind === "month" ? d.getDate() - 1 : d.getMonth()] += l.secs;
    byHour[d.getHours()] += l.secs;
    byWeekday[(d.getDay() + 6) % 7] += l.secs;
    const k = dayKey(d);
    const day = perDay.get(k) ?? { date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), secs: 0 };
    day.secs += l.secs;
    perDay.set(k, day);
    if (isPlay(l)) {
      const tk = `${k}|${l.track_id}`;
      const t = trackPerDay.get(tk) ?? { trackId: l.track_id, date: day.date, plays: 0 };
      t.plays += 1;
      trackPerDay.set(tk, t);
    }
  }

  const sortedDays = [...perDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  // Plus longue série de jours consécutifs (écart d'un jour civil, arrondi : les changements
  // d'heure font des journées de 23 ou 25 h).
  let longestStreak: Recap["longestStreak"] = null;
  let runStart = 0;
  for (let i = 0; i < sortedDays.length; i++) {
    const follows = i > 0 && Math.round((sortedDays[i].date.getTime() - sortedDays[i - 1].date.getTime()) / 86_400_000) === 1;
    if (!follows) runStart = i;
    const days = i - runStart + 1;
    if (!longestStreak || days > longestStreak.days) longestStreak = { days, from: sortedDays[runStart].date, to: sortedDays[i].date };
  }
  const bestDay = sortedDays.reduce<Recap["bestDay"]>((best, d) => (!best || d.secs > best.secs ? d : best), null);
  const obsessionRaw = [...trackPerDay.values()].sort((a, b) => b.plays - a.plays)[0];
  const obsessionTrack = obsessionRaw && topTracks.find((t) => t.trackId === obsessionRaw.trackId || t.key === obsessionRaw.trackId);
  const obsession = obsessionRaw && obsessionTrack && obsessionRaw.plays >= 3 ? { track: obsessionTrack, plays: obsessionRaw.plays, date: obsessionRaw.date } : null;

  const knownBefore = new Set(earlier.map(artistKey).filter(Boolean));
  const seen = new Set<string>();
  const discoveries: string[] = [];
  for (const l of listens) {
    const k = artistKey(l);
    if (!k || knownBefore.has(k) || seen.has(k)) continue;
    seen.add(k);
    discoveries.push(l.artist.trim());
  }

  const base = {
    period,
    label: periodLabel(period),
    totalSecs: listens.reduce((s, l) => s + l.secs, 0),
    plays,
    trackCount: new Set(listens.map((l) => l.track_id)).size,
    artistCount: topArtists.length,
    albumCount: topAlbums.length,
    activeDays: perDay.size,
    topTracks,
    topArtists,
    topAlbums,
    topGenres,
    timeline,
    byHour,
    byWeekday,
    bestDay,
    longestStreak,
    obsession,
    firstListen: listens[0] ?? null,
    discoveries: earlier.length ? discoveries : [],
    hasEarlierHistory: earlier.length > 0,
    previousTotalSecs: previous.reduce((s, l) => s + l.secs, 0),
  };
  return { ...base, personality: personalityOf(base) };
}

/** « 12 h 05 », « 47 min ». */
export function formatListening(secs: number): string {
  const minutes = Math.round(secs / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h.toLocaleString("fr-FR")} h ${String(minutes % 60).padStart(2, "0")}`;
}

export function minutesLabel(secs: number): string {
  return Math.round(secs / 60).toLocaleString("fr-FR");
}

/** Écart avec la période précédente, en pourcentage arrondi (null sans point de comparaison). */
export function evolution(r: Recap): number | null {
  if (r.previousTotalSecs < 60) return null;
  return Math.round(((r.totalSecs - r.previousTotalSecs) / r.previousTotalSecs) * 100);
}
