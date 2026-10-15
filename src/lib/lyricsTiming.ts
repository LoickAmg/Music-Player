import type { LyricLine } from "./types";

/**
 * Rythme des paroles synchronisées, pour l'affichage :
 *  - chaque ligne est découpée en mots, avec l'instant où chacun commence et finit d'être
 *    chanté : minutage exact quand la source le donne (LRC enrichi), sinon estimé d'après
 *    le nombre de syllabes (un mot long dure plus longtemps qu'un « de ») ;
 *  - les longs passages sans voix (intro, pont, solo) deviennent des « pauses » affichées
 *    comme des points qui se remplissent jusqu'à la reprise du chant.
 */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface LyricItem {
  kind: "line" | "pause";
  /** Indice de la ligne d'origine (pauses : celle qui suit). */
  line: number;
  start: number;
  end: number;
  text: string;
  words: TimedWord[];
}

/** En dessous, un silence entre deux lignes n'est pas signalé (simple respiration). */
export const PAUSE_MIN_MS = 4500;
/** Durée moyenne d'une syllabe chantée (rap compris, on reste prudent). */
const SYLLABLE_MS = 280;

const VOWELS = /[aeiouyàâäáãåéèêëíìîïóòôöõúùûüœæ]+/giu;
const LETTER = /\p{L}/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

export function isBreak(text: string): boolean {
  return !text.trim() || /^[♪♫\s.…•·-]+$/.test(text);
}

/** Nombre approximatif de syllabes d'un mot (au moins 1 s'il contient une lettre). */
export function syllables(word: string): number {
  const cjk = word.match(CJK)?.length ?? 0;
  if (cjk) return cjk;
  const groups = word.match(VOWELS)?.length ?? 0;
  if (groups) return groups;
  return LETTER.test(word) ? 1 : 0;
}

/** Mots d'une ligne, chacun avec l'espace qui le suit (pour se recoller tel quel). */
export function splitWords(text: string): string[] {
  const parts = text.trim().match(/\S+\s*/g);
  return parts ?? [];
}

/** Fin estimée de la voix sur une ligne : jamais après la ligne suivante. */
function vocalEnd(line: LyricLine, next: number): number {
  const room = Math.max(0, next - line.time_ms);
  const words = line.words;
  if (words?.length) {
    const last = words[words.length - 1];
    const tail = Math.min(900, Math.max(250, syllables(last.text) * SYLLABLE_MS));
    return Math.min(next, Math.max(last.time_ms + tail, line.time_ms + 300));
  }
  const total = splitWords(line.text).reduce((n, w) => n + Math.max(1, syllables(w)), 0);
  const estimate = Math.max(1500, total * SYLLABLE_MS);
  // Lignes qui s'enchaînent : la voix occupe presque tout l'intervalle.
  return line.time_ms + Math.min(room * 0.92, estimate);
}

function timedWords(line: LyricLine, end: number): TimedWord[] {
  const given = line.words?.filter((w) => w.text.trim());
  if (given?.length) {
    return given.map((w, i) => ({
      text: w.text,
      start: w.time_ms,
      end: Math.max(w.time_ms + 80, i + 1 < given.length ? given[i + 1].time_ms : end),
    }));
  }
  const words = splitWords(line.text);
  const weights = words.map((w) => Math.max(1, syllables(w)) + (/[,;:!?…]\s*$/.test(w) ? 0.6 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const span = Math.max(200, end - line.time_ms);
  let at = line.time_ms;
  return words.map((text, i) => {
    const length = (span * weights[i]) / total;
    const word = { text, start: at, end: at + length };
    at += length;
    return word;
  });
}

/** Lignes et pauses, dans l'ordre, prêtes à afficher. `durationMs` : durée du morceau (0 si inconnue). */
export function buildItems(lines: LyricLine[], durationMs = 0): LyricItem[] {
  const items: LyricItem[] = [];
  const first = lines[0];
  if (first && first.time_ms >= PAUSE_MIN_MS && !isBreak(first.text)) {
    items.push({ kind: "pause", line: 0, start: 0, end: first.time_ms, text: "", words: [] });
  }
  lines.forEach((line, i) => {
    const next = lines[i + 1]?.time_ms ?? (durationMs > line.time_ms ? Math.min(durationMs, line.time_ms + 10000) : line.time_ms + 8000);
    if (isBreak(line.text)) {
      items.push({ kind: "pause", line: i + 1, start: line.time_ms, end: next, text: "", words: [] });
      return;
    }
    const end = vocalEnd(line, next);
    items.push({ kind: "line", line: i, start: line.time_ms, end, text: line.text, words: timedWords(line, end) });
    // Long silence avant la ligne suivante (pont, solo) : une pause s'affiche entre les deux.
    if (lines[i + 1] && !isBreak(lines[i + 1].text) && next - end >= PAUSE_MIN_MS) {
      items.push({ kind: "pause", line: i + 1, start: end, end: next, text: "", words: [] });
    }
  });
  return items;
}

/** Indice de l'élément en cours (le dernier qui a commencé), ou -1 avant le premier. */
export function activeItemIndex(items: LyricItem[], positionMs: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Avancement (0 à 1) d'un intervalle à l'instant donné. */
export function progress(start: number, end: number, at: number): number {
  if (end <= start) return at >= start ? 1 : 0;
  return Math.min(1, Math.max(0, (at - start) / (end - start)));
}
