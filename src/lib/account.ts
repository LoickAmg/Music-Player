// Compte Music Player (sans adresse e-mail) : code d'ami des Proches + mot de passe. La
// sauvegarde (.mpsave) est chiffrée sur l'appareil avec une clé tirée du mot de passe et
// gardée par le relais, qui ne voit jamais ni le mot de passe ni le contenu.

import { relay } from "./friendsApi";

const ITERATIONS = 210_000;
/** Morceaux envoyés au relais (1 Mo au plus chacun). */
const CHUNK = 900_000;

export interface AccountKeys {
  /** Preuve du mot de passe envoyée au relais (hex, 64 caractères). */
  cle: string;
  /** Clé de chiffrement (base64), qui ne quitte jamais l'appareil. */
  key: string;
}

function toBase64(bytes: Uint8Array): string {
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

/** Clés du compte, tirées du mot de passe et du code (lent exprès : 210 000 tours). */
export async function deriveKeys(code: string, password: string): Promise<AccountKeys> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(`music-player:${code}`), iterations: ITERATIONS },
      material,
      512,
    ),
  );
  const cle = [...bits.subarray(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { cle, key: toBase64(bits.subarray(0, 32)) };
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
    throw new Error("Sauvegarde illisible : mot de passe différent de celui de l'envoi ?");
  }
}

/** Envoie la sauvegarde chiffrée, morceau par morceau. */
export async function uploadBackup(base: string, code: string, keys: AccountKeys, json: string): Promise<void> {
  const data = await encrypt(keys.key, json);
  const total = Math.max(1, Math.ceil(data.length / CHUNK));
  for (let n = 0; n < total; n++) {
    await relay.uploadChunk(base, code, keys.cle, n, total, data.slice(n * CHUNK, (n + 1) * CHUNK));
  }
}

/** Récupère et déchiffre la sauvegarde en ligne ; renvoie son contenu et sa date. */
export async function downloadBackup(base: string, code: string, keys: AccountKeys): Promise<{ json: string; at: number }> {
  const first = await relay.downloadChunk(base, code, keys.cle, 0);
  const parts = [first.data];
  for (let n = 1; n < first.total; n++) parts.push((await relay.downloadChunk(base, code, keys.cle, n)).data);
  return { json: await decrypt(keys.key, parts.join("")), at: first.at };
}
