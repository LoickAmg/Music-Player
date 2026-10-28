// Client du relais pour les Proches (voir relay/src/index.js) : profil par code d'ami,
// messages (demande, accord, retrait), statut d'écoute lu par les seuls amis autorisés,
// annuaire de zone sur option.

/** Alphabet des codes d'ami : sans 0/O ni 1/I, faciles à dicter. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_PATTERN = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Saisie libre (« k7qm 2d9x », « K7QM2D9X ») → code canonique, ou null. */
export function parseCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (raw.length !== 8) return null;
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return CODE_PATTERN.test(code) ? code : null;
}

export function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Card {
  code: string;
  nom: string;
  avatar: string | null;
}

/** Ce qu'écoute un ami (à l'instant `at`, ms). */
export interface Presence {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  duration: number;
  position: number;
  at: number;
}

export interface Message {
  type: "demande" | "accord" | "retrait";
  de: string;
  nom: string;
  avatar: string | null;
  token: string | null;
  at: number;
}

/** Morceau ou playlist joint à un mot (décrits, jamais de fichier). */
export type Piece =
  | { type: "morceau"; titre: string; artiste: string; album: string }
  | { type: "playlist"; nom: string; morceaux: { titre: string; artiste: string; album: string }[] };

/** Mot reçu d'un proche (messagerie). */
export interface Word {
  type: "mot";
  de: string;
  texte: string;
  piece: Piece | null;
  at: number;
}

/** Avis reçu (« Un avis ? »), lu par l'administrateur. */
export interface AvisItem {
  id: string;
  kind: "bug" | "suggestion" | "idee" | "avis" | "autre";
  message: string;
  name: string;
  contact: string;
  screen: string;
  version: string;
  platform: string;
  images: number;
  statut: "nouveau" | "lu" | "traite";
  at: number;
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function relayBase(relay: string): string {
  return relay.trim().replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

async function call<T>(base: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  } catch {
    // Le relais répond-il ? Un relais d'avant les Proches refuse ces requêtes d'une façon que
    // le navigateur présente comme une coupure réseau : on distingue les deux cas.
    const reachable = await fetch(`${base}/`, { mode: "no-cors" }).then(
      () => true,
      () => false,
    );
    throw new RelayError(
      reachable
        ? "Le relais de partage ne prend pas encore en charge les Proches (mise à jour du relais nécessaire)."
        : "Relais injoignable : vérifiez la connexion Internet.",
      0,
    );
  }
  const data = (await response.json().catch(() => ({}))) as T & { erreur?: string };
  if (!response.ok) throw new RelayError(data.erreur ?? `Erreur du relais (${response.status})`, response.status);
  return data;
}

export const relay = {
  saveProfile: (base: string, code: string, secret: string, nom: string, avatar: string | null) =>
    call<Card>(base, `/v1/profil/${code}/profil`, { secret, nom, avatar }),
  card: (base: string, code: string) => call<Card>(base, `/v1/profil/${code}/carte`),
  setStatus: (base: string, code: string, secret: string, statut: Omit<Presence, "at"> | null) =>
    call<{ ok: true }>(base, `/v1/profil/${code}/statut`, { secret, statut }),
  grant: (base: string, code: string, secret: string, lecteur: string, token: string) =>
    call<{ ok: true }>(base, `/v1/profil/${code}/autoriser`, { secret, lecteur, token }),
  revoke: (base: string, code: string, secret: string, lecteur: string) =>
    call<{ ok: true }>(base, `/v1/profil/${code}/retirer`, { secret, lecteur }),
  send: (base: string, to: string, message: Omit<Message, "at">) => call<{ ok: true }>(base, `/v1/profil/${to}/message`, message),
  /** Mot à un proche : `token` est celui qu'il nous a donné (preuve qu'on est son ami). */
  word: (base: string, to: string, word: { de: string; token: string; texte: string; piece: Piece | null }) =>
    call<{ ok: true }>(base, `/v1/profil/${to}/message`, { type: "mot", ...word }),
  inbox: (base: string, code: string, secret: string) =>
    call<{ messages: (Message | Word)[] }>(base, `/v1/profil/${code}/boite`, { secret }),
  friends: (base: string, lecteur: string, amis: { code: string; token: string }[]) =>
    call<{ amis: { code: string; carte?: Card; statut?: Presence | null; refuse?: boolean }[] }>(base, "/v1/amis", {
      lecteur,
      amis,
    }),
  /** Compte : empreinte du mot de passe enregistrée (par l'appareil propriétaire du profil). */
  account: (base: string, code: string, secret: string, cle: string) =>
    call<{ ok: true }>(base, `/v1/profil/${code}/compte`, { secret, cle }),
  uploadChunk: (base: string, code: string, cle: string, n: number, total: number, data: string) =>
    call<{ ok: true }>(base, `/v1/profil/${code}/envoyer`, { cle, n, total, data }),
  downloadChunk: (base: string, code: string, cle: string, n: number) =>
    call<{ total: number; at: number; data: string }>(base, `/v1/profil/${code}/recuperer`, { cle, n }),
  /** Avis : dépôt (public) ; le reste avec le code administrateur. */
  sendAvis: (base: string, avis: Record<string, unknown>) => call<{ ok: true; message: string }>(base, "/v1/avis", avis),
  avisCount: (base: string, admin: string) =>
    call<{ nouveaux: number; dernier: AvisItem | null }>(base, "/v1/avis/nouveaux", { admin }),
  avisList: (base: string, admin: string) => call<{ avis: AvisItem[] }>(base, "/v1/avis/liste", { admin }),
  avisImage: (base: string, admin: string, id: string, n: number) => call<{ data: string }>(base, "/v1/avis/image", { admin, id, n }),
  avisStatus: (base: string, admin: string, id: string, statut: AvisItem["statut"]) =>
    call<{ ok: true }>(base, "/v1/avis/statut", { admin, id, statut }),
  avisDelete: (base: string, admin: string, id: string) => call<{ ok: true }>(base, "/v1/avis/supprimer", { admin, id }),
  zone: (base: string) => call<{ zone: string | null; profils: Card[] }>(base, "/v1/zone"),
  announce: (base: string, code: string, secret: string, visible: boolean) =>
    call<{ zone: string | null }>(base, "/v1/zone", { code, secret, visible }),
};

/** Photo de profil réduite (72 px, JPEG) pour la carte d'ami. */
export async function smallAvatar(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();
    const size = 72;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    const data = canvas.toDataURL("image/jpeg", 0.8);
    return data.length <= 24 * 1024 ? data : null;
  } catch {
    return null;
  }
}
