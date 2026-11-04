// Messages entre proches, chiffrés de bout en bout : seuls les deux correspondants peuvent les
// lire, pas le relais. Clé de conversation par accord X25519. La clé privée est tirée du secret du
// profil : tous les appareils liés (même secret) ont la même, sans échange ni conflit.

import { x25519 } from "@noble/curves/ed25519.js";
import type { Piece } from "./friendsApi";
import { decrypt, encrypt, toBase64 } from "./sync";

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function privateKey(secret: string): Promise<Uint8Array> {
  return sha256(new TextEncoder().encode(`music-player/messages/v1|${secret}`));
}

/** Clé publique du profil (hex), affichée sur sa carte d'ami. */
export async function publicKey(secret: string): Promise<string> {
  return toHex(x25519.getPublicKey(await privateKey(secret)));
}

/** Clé commune à deux profils (base64) : la même des deux côtés. */
export async function conversationKey(secret: string, theirPublicKey: string): Promise<string> {
  return toBase64(await sha256(x25519.getSharedSecret(await privateKey(secret), fromHex(theirPublicKey))));
}

export interface Words {
  texte: string;
  piece: Piece | null;
}

export function sealWord(key: string, words: Words): Promise<string> {
  return encrypt(key, JSON.stringify(words));
}

export async function openWord(key: string, sealed: string): Promise<Words> {
  const words = JSON.parse(await decrypt(key, sealed)) as Partial<Words>;
  return { texte: typeof words.texte === "string" ? words.texte : "", piece: words.piece ?? null };
}
