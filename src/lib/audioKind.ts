// Tri des fichiers audio qui ne sont pas de la musique : notes vocales (WhatsApp, Telegram…)
// et enregistrements (dictaphone, appels). Ils sont rangés à part (page « Vocaux ») au lieu
// d'encombrer les morceaux, les artistes et les ajouts récents. Tri d'après le dossier et
// le nom du fichier, corrigeable à la main morceau par morceau.

import type { Track } from "./types";

export type AudioKind = "musique" | "vocal" | "enregistrement";

const UNKNOWN_ARTIST = "Artiste inconnu";

/** Dossiers des notes vocales des messageries. */
const VOICE_DIRS = [
  /^whatsapp( business)? voice notes$/,
  /^(telegram|telegram x) (audio|voice)$/,
  /^signal( voice notes)?$/,
  /^messenger( audio)?$/,
];
/** Audio reçu par WhatsApp : souvent des vocaux transférés, parfois de vrais morceaux. */
const WHATSAPP_AUDIO_DIR = /^whatsapp( business)? audio$/;
/** Dossiers des enregistreurs (dictaphone, appels) des principales marques de téléphones. */
const RECORDING_DIRS = [
  /^recordings?$/,
  /^(call|voice|sound|audio)[ _]?record(ings?|er)$/,
  /^callrecord(ings?)?$/,
  /^enregistre(ments?|ur)( vocaux| d'appels| audio)?$/,
  /^(sound|voice|audio)[ _]?recorder$/,
  /^sounds?recorder$/,
  /^dictaphone$/,
  /^memos? vocaux$/,
  /^voice memos?$/,
];
const VOICE_FILE = /^ptt-\d{8}-wa\d+/;
const WHATSAPP_AUDIO_FILE = /^aud-\d{8}-wa\d+/;
const RECORDING_FILE = /^(recording|record|rec|voice|enregistrement|memo|call|appel|audio_record)[ _-]?\d/;

function parts(path: string): { dirs: string[]; file: string } {
  const segments = path.toLowerCase().split(/[\\/]+/).filter(Boolean);
  const file = segments.pop() ?? "";
  return { dirs: segments, file };
}

/** Nature d'un fichier d'après son emplacement, son nom et ses étiquettes. */
export function guessKind(t: Pick<Track, "path" | "artist">): AudioKind {
  const { dirs, file } = parts(t.path);
  const tagged = t.artist !== UNKNOWN_ARTIST;
  if (VOICE_FILE.test(file) || dirs.some((d) => VOICE_DIRS.some((re) => re.test(d)))) return "vocal";
  // Audio WhatsApp : un vrai morceau garde ses étiquettes (artiste), un vocal n'en a pas.
  if (!tagged && (WHATSAPP_AUDIO_FILE.test(file) || dirs.some((d) => WHATSAPP_AUDIO_DIR.test(d)))) return "vocal";
  if (dirs.some((d) => RECORDING_DIRS.some((re) => re.test(d)))) return "enregistrement";
  if (!tagged && RECORDING_FILE.test(file)) return "enregistrement";
  return "musique";
}

/** Date contenue dans un nom WhatsApp (PTT-20261020-WA0012 → 20 oct. 2026). */
export function dateFromName(path: string): Date | null {
  const m = parts(path).file.match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[^\d]|$)/);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) || date.getMonth() !== Number(m[2]) - 1 ? null : date;
}

/** Titre lisible : « Note vocale WhatsApp » au lieu de « PTT-20261020-WA0012 ». */
export function voiceTitle(t: Pick<Track, "path" | "title">): string {
  const file = parts(t.path).file;
  if (VOICE_FILE.test(file) && /^ptt-/i.test(t.title)) return "Note vocale WhatsApp";
  if (WHATSAPP_AUDIO_FILE.test(file) && /^aud-/i.test(t.title)) return "Audio WhatsApp";
  return t.title;
}
