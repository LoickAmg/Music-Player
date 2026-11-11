import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRelay } from "./relayTestKit";
import { PARCEL_MAX_BYTES, PARCEL_RAW_CHUNK, receiveParcel, sendParcel } from "./parcel";
import { toBase64 } from "./sync";

let relay: FakeRelay;
const BASE = "https://relais.test";
const ME = { code: "K7QM-2D9X", secret: "a".repeat(64) };
const WHO = { base: BASE, de: ME.code, secret: ME.secret };

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}
const reader = (file: Uint8Array) => async (offset: number, len: number) => toBase64(file.subarray(offset, offset + len));
function sink() {
  const parts: Uint8Array[] = [];
  return {
    write: async (data: string, append: boolean) => {
      if (!append) parts.length = 0;
      parts.push(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    },
    joined: () => {
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    },
  };
}

beforeEach(async () => {
  relay = new FakeRelay();
  vi.stubGlobal("fetch", relay.fetch);
  await relay.post(ME.code, "profil", { secret: ME.secret, nom: "Mahouna" });
});

describe("son joint à un message (colis)", () => {
  it("arrive entier chez le destinataire, et le relais n'en garde que du chiffré", async () => {
    const file = bytes(PARCEL_RAW_CHUNK * 2 + 1234);
    const steps: number[] = [];
    const ref = await sendParcel(WHO, file.length, reader(file), (done) => steps.push(done));
    expect(steps[steps.length - 1]).toBe(file.length);
    const stored = [...relay.parcels.get(ref.id)!.storage.map.entries()].filter(([k]) => /^m\d+$/.test(k));
    expect(stored).toHaveLength(3);
    expect(String(stored[0][1])).not.toContain(toBase64(file.subarray(0, 64)));

    const out = sink();
    await receiveParcel(BASE, ref, out.write);
    expect(out.joined()).toEqual(file);
  }, 30_000); // chiffrement de quelques Mo : lent quand toute la suite tourne en parallèle

  it("refuse le dépôt d'un inconnu", async () => {
    await expect(sendParcel({ base: BASE, de: ME.code, secret: "b".repeat(64) }, 10, reader(bytes(10)))).rejects.toThrow(/non reconnu/);
  });

  it("refuse un son trop lourd avant de rien envoyer", async () => {
    const read = vi.fn();
    await expect(sendParcel(WHO, PARCEL_MAX_BYTES + 1, read)).rejects.toThrow(/trop lourd/);
    expect(read).not.toHaveBeenCalled();
  });

  it("détecte un morceau modifié en route, et rien n'est lisible sans la bonne clé", async () => {
    const file = bytes(5000);
    const ref = await sendParcel(WHO, file.length, reader(file));
    await expect(receiveParcel(BASE, { ...ref, cle: toBase64(new Uint8Array(32)) }, sink().write)).rejects.toThrow(/illisible/);
    const storage = relay.parcels.get(ref.id)!.storage;
    const data = String(storage.map.get("m0"));
    storage.map.set("m0", data.slice(0, 40) + (data[40] === "A" ? "B" : "A") + data.slice(41));
    await expect(receiveParcel(BASE, ref, sink().write)).rejects.toThrow(/illisible/);
  });

  it("s'efface au bout de 7 jours", async () => {
    const ref = await sendParcel(WHO, 100, reader(bytes(100)));
    const entry = relay.parcels.get(ref.id)!;
    expect(entry.storage.alarm! - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    await entry.colis.alarm();
    await expect(receiveParcel(BASE, ref, sink().write)).rejects.toThrow(/7 jours/);
  });
});
