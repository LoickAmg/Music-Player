// Colis : un son joint à un message entre proches. L'archive (.mpshare, préparée par le moteur)
// est chiffrée ici, morceau par morceau, avec une clé tirée au hasard ; le relais garde les
// morceaux illisibles 7 jours. La clé ne voyage que dans le message, chiffré de bout en bout.

import { type ParcelRef, relay, RelayError } from "./friendsApi";
import { toBase64 } from "./sync";

/** Octets d'archive par morceau : chiffré puis en base64, il reste sous 1 Mo (limite du relais). */
export const PARCEL_RAW_CHUNK = 700 * 1024;
export const PARCEL_MAX_CHUNKS = 40;
/** Taille maximale d'un son joint (environ 28 Mo). */
export const PARCEL_MAX_BYTES = PARCEL_RAW_CHUNK * PARCEL_MAX_CHUNKS;

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function aesKey(cle: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(cle) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}
/** Chaque morceau est lié à son colis et à sa place : impossible de les intervertir. */
const label = (id: string, n: number) => new TextEncoder().encode(`${id}:${n}`) as BufferSource;

async function seal(key: CryptoKey, id: string, n: number, raw: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: label(id, n) }, key, raw as BufferSource));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return toBase64(out);
}

async function open(key: CryptoKey, id: string, n: number, data: string): Promise<Uint8Array> {
  try {
    const bytes = fromBase64(data);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: label(id, n) }, key, bytes.subarray(12)));
  } catch {
    throw new Error("Son reçu illisible (abîmé en route).");
  }
}

export interface ParcelSender {
  base: string;
  de: string;
  secret: string;
}

/**
 * Dépose une archive sur le relais. `read(offset, len)` lit l'archive (base64). Reprend où le
 * relais en est après une coupure. Renvoie la référence à joindre au message.
 */
export async function sendParcel(
  who: ParcelSender,
  size: number,
  read: (offset: number, len: number) => Promise<string>,
  onProgress?: (done: number, total: number) => void,
): Promise<ParcelRef> {
  const total = Math.max(1, Math.ceil(size / PARCEL_RAW_CHUNK));
  if (total > PARCEL_MAX_CHUNKS) throw new Error(`Ce son est trop lourd pour être joint (${Math.round(PARCEL_MAX_BYTES / 1e6)} Mo au plus).`);
  const id = hex(crypto.getRandomValues(new Uint8Array(16)));
  const cle = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const key = await aesKey(cle);
  let n = 0;
  let retries = 0;
  while (n < total) {
    const raw = fromBase64(await read(n * PARCEL_RAW_CHUNK, PARCEL_RAW_CHUNK));
    const data = await seal(key, id, n, raw);
    try {
      const { recus } = await relay.parcelPut(who.base, id, { de: who.de, secret: who.secret, n, total, data });
      n = recus;
      retries = 0;
    } catch (e) {
      // Coupure, relais occupé ou morceau en double : on repart de ce que le relais a déjà. Un
      // refus (expéditeur inconnu, colis invalide) ne se réessaie pas.
      const status = e instanceof RelayError ? e.status : 0;
      if (++retries > 4 || (status >= 400 && status < 500 && status !== 409 && status !== 429)) throw e;
      if (status === 409) n = (await relay.parcelState(who.base, id).catch(() => ({ recus: 0 }))).recus;
      else await new Promise((r) => setTimeout(r, 1000 * retries));
    }
    onProgress?.(Math.min(n * PARCEL_RAW_CHUNK, size), size);
  }
  return { id, cle, taille: size };
}

/** Reprend un colis du relais et l'écrit morceau par morceau (`write(base64, àLaSuite)`). */
export async function receiveParcel(
  base: string,
  ref: ParcelRef,
  write: (data: string, append: boolean) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const key = await aesKey(ref.cle);
  const { total, complet } = await relay.parcelState(base, ref.id);
  if (!complet) throw new Error("L'envoi de ce son n'est pas encore terminé.");
  let done = 0;
  for (let n = 0; n < total; n++) {
    let chunk: { data: string } | null = null;
    for (let tries = 0; !chunk; tries++) {
      try {
        chunk = await relay.parcelRead(base, ref.id, n);
      } catch (e) {
        if (tries >= 3 || (e instanceof RelayError && e.status === 404)) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (tries + 1)));
      }
    }
    const raw = await open(key, ref.id, n, chunk.data);
    await write(toBase64(raw), n > 0);
    done += raw.length;
    onProgress?.(Math.min(done, ref.taille), ref.taille);
  }
}
