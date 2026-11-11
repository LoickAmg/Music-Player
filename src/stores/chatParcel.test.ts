import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { FakeRelay } from "@/lib/relayTestKit";
import { publicKey } from "@/lib/e2e";
import { toBase64 } from "@/lib/sync";
import type { Track } from "@/lib/types";

// Un son envoyé dans la discussion part avec son fichier (colis chiffré sur le relais), et le
// proche le reçoit en un geste. Le moteur Rust est simulé : l'archive est un tableau d'octets.
const disk = vi.hoisted(() => ({ archive: new Uint8Array(0), written: [] as number[][], forgotten: [] as string[] }));
vi.mock("@/lib/api", () => ({
  api: {
    defaultRelay: async () => "https://relais.test",
    nearbyStart: async () => {},
    parcelPrepare: async () => ({ name: "colis-envoi.mpshare", size: disk.archive.length }),
    parcelRead: async (_name: string, offset: number, len: number) => toBase64(disk.archive.subarray(offset, offset + len)),
    parcelWrite: async (_name: string, data: string, append: boolean) => {
      if (!append) disk.written = [];
      disk.written.push([...Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]);
      return 0;
    },
    parcelImport: async () => ({ name: "Morose", kind: "track", added_tracks: 1, skipped_tracks: 0, playlist_id: null, track_ids: ["recu-1"] }),
    parcelForget: async (name: string) => void disk.forgotten.push(name),
  },
}));

import { useFriendsStore } from "./friends";
import { useLibraryStore } from "./library";
import { useShareStore } from "./share";

let relay: FakeRelay;
const BASE = "https://relais.test";
const A = { code: "K7QM-2D9X", secret: "a".repeat(64) };
const B = { code: "P3RT-8HJK", secret: "b".repeat(64) };
const TOKEN = "c".repeat(32);
const track: Track = { id: "t1", path: "/m/t1.mp3", title: "Morose", artist: "Damso", album: "QALF", album_artist: "Damso", track_no: null, disc_no: null, year: null, genre: null, duration_secs: 200, has_cover: false, added_secs: 0 };

beforeEach(async () => {
  relay = new FakeRelay();
  vi.stubGlobal("fetch", relay.fetch);
  disk.archive = Uint8Array.from({ length: 1_600_000 }, (_, i) => (i * 13) & 0xff);
  disk.written = [];
  disk.forgotten = [];
  await relay.post(A.code, "profil", { secret: A.secret, nom: "Mahouna", cle: await publicKey(A.secret) });
  await relay.post(B.code, "profil", { secret: B.secret, nom: "Biggy03", cle: await publicKey(B.secret) });
  await relay.post(B.code, "autoriser", { secret: B.secret, lecteur: A.code, token: TOKEN });
  setActivePinia(createPinia());
  useShareStore().relay = BASE;
});

describe("son envoyé dans la discussion", () => {
  it("part avec son fichier chiffré, et le proche le reçoit dans ses Reçus", async () => {
    const friends = useFriendsStore();
    friends.me = { ...A };
    friends.enabled = true;
    friends.friends = [{ code: B.code, name: "Biggy03", avatar: null, readToken: TOKEN, since: 0, pubKey: await publicKey(B.secret) }];
    useLibraryStore().tracks = [track];
    useLibraryStore().all = [track];

    expect(await friends.sendTrack(B.code, track, "le son de damso")).toBe(true);
    const line = friends.conversations[B.code][0];
    expect(line.piece).toMatchObject({ type: "morceau", titre: "Morose", colis: { taille: 1_600_000 } });
    expect(friends.error).toBeNull();
    expect(disk.forgotten).toEqual(["colis-envoi.mpshare"]);
    expect(useShareStore().shared[0]).toMatchObject({ id: "t1", direction: "envoye", who: "Biggy03", via: "discussion", title: "Morose" });
    // Le relais n'a reçu que le message chiffré : ni le titre ni la clé du fichier en clair.
    const box = JSON.stringify([...relay.storage(B.code).map.entries()]);
    expect(box).not.toContain("Morose");
    expect(box).not.toContain((line.piece as { colis: { cle: string } }).colis.cle);

    // Chez le proche (même mémoire ici) : la ligne reçue est rejouée, puis le fichier repris.
    setActivePinia(createPinia());
    useShareStore().relay = BASE;
    const other = useFriendsStore();
    other.me = { ...B };
    other.friends = [{ code: A.code, name: "Mahouna", avatar: null, readToken: TOKEN, since: 0, pubKey: await publicKey(A.secret) }];
    other.conversations = { [A.code]: [{ ...line, mine: false }] };
    expect(await other.receivePiece(A.code, line.at)).toBe("recu-1");
    expect(new Uint8Array(disk.written.flat())).toEqual(disk.archive);
    expect(other.conversations[A.code][0].recu).toEqual(["recu-1"]);
    expect(useShareStore().shared[0]).toMatchObject({ id: "recu-1", direction: "recu", who: "Mahouna", via: "discussion" });
  }, 30_000); // chiffrement de quelques Mo : lent quand toute la suite tourne en parallèle

  it("envoie le titre seul, en le disant, si le proche n'est pas à jour", async () => {
    const friends = useFriendsStore();
    friends.me = { ...A };
    friends.enabled = true;
    friends.friends = [{ code: B.code, name: "Biggy03", avatar: null, readToken: TOKEN, since: 0, pubKey: null }];
    await relay.post(B.code, "profil", { secret: B.secret, nom: "Biggy03" });
    expect(await friends.sendTrack(B.code, track, "")).toBe(true);
    expect(friends.conversations[B.code][0].piece).not.toHaveProperty("colis");
    expect(friends.error).toMatch(/mettre Music Player à jour/);
  });
});
