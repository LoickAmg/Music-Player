// Alertes : un seul chemin pour prévenir la personne. Appli au premier plan : une bannière dans
// l'appli ; fenêtre cachée ou sans le focus (autre appli devant, appli réduite, écran du
// téléphone ailleurs) : une notification du système. Chaque type se règle dans les Réglages.

import { notify } from "./notify";

export type AlertKind = "messages" | "partages" | "appareils" | "proches";

export const ALERT_KINDS: { id: AlertKind; label: string; hint: string }[] = [
  { id: "messages", label: "Messages des proches", hint: "Mots et sons reçus dans une discussion, demandes d'ajout" },
  { id: "partages", label: "Sons partagés avec vous", hint: "Un voisin du Wi-Fi veut vous envoyer un son, envoi reçu ou terminé" },
  { id: "appareils", label: "Mes appareils", hint: "Sons absents d'ici sur un autre appareil, copies demandées ou terminées" },
  { id: "proches", label: "Proches en ligne", hint: "Un proche se met à écouter, ou apparaît dans votre ville" },
];

const KEY = "mp:alertes";

export function alertSettings(): Record<AlertKind, boolean> {
  const all: Record<AlertKind, boolean> = { messages: true, partages: true, appareils: true, proches: true };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Record<AlertKind, boolean>>;
    return { ...all, ...saved };
  } catch {
    return all;
  }
}

export function setAlert(kind: AlertKind, on: boolean) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...alertSettings(), [kind]: on }));
  } catch {
    // réglage valable pour la session
  }
}

/** L'appli est-elle sous les yeux de la personne ? */
export function inView(): boolean {
  if (typeof document === "undefined") return false;
  return !document.hidden && (typeof document.hasFocus !== "function" || document.hasFocus());
}

type Banner = (message: string) => void;
let banner: Banner = () => {};
/** La bannière de l'appli (posée au démarrage par App.vue). */
export function setBanner(show: Banner) {
  banner = show;
}

/** Même alerte répétée : une fois toutes les `quiet` ms au plus. */
const lastShown = new Map<string, number>();

export interface AlertOptions {
  /** Pas de bannière (ce qu'elle dirait est déjà à l'écran). */
  silentInApp?: boolean;
  /** Clé de regroupement et délai minimal entre deux alertes de même clé. */
  key?: string;
  quiet?: number;
}

export function alert(kind: AlertKind, title: string, body: string, options: AlertOptions = {}): void {
  if (!alertSettings()[kind]) return;
  const now = Date.now();
  if (options.key) {
    const last = lastShown.get(options.key) ?? 0;
    if (now - last < (options.quiet ?? 0)) return;
    lastShown.set(options.key, now);
  }
  if (inView()) {
    if (!options.silentInApp) banner(body ? `${title} — ${body}` : title);
  } else {
    void notify(title, body);
  }
}

/** Pour les tests : oublie les regroupements. */
export function resetAlerts() {
  lastShown.clear();
}
