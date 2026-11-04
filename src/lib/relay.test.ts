import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { conversationKey, openWord, publicKey, sealWord } from "./e2e";
import { FakeRelay } from "./relayTestKit";
import { Profil } from "../../relay/src/index.js";
import { useFriendsStore } from "@/stores/friends";
import { useShareStore } from "@/stores/share";

const A = "K7QM-2D9X";
const B = "H4JN-8RTY";
const C = "ZZZZ-2222";
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const SECRET_C = "c".repeat(64);
const TOKEN = "1".repeat(32);

let relay: FakeRelay;
const alarm = (code: string) => (relay.profile(code) as Profil & { alarm(): Promise<void> }).alarm();

beforeEach(async () => {
  relay = new FakeRelay();
  localStorage.clear();
  setActivePinia(createPinia());
  vi.stubGlobal("fetch", relay.fetch);
  useShareStore().relay = "https://relais.test";
  await relay.post(A, "profil", { secret: SECRET_A, nom: "A" });
  await relay.post(B, "profil", { secret: SECRET_B, nom: "B" });
  await relay.post(C, "profil", { secret: SECRET_C, nom: "C" });
});

describe("expéditeurs vérifiés", () => {
  const retrait = { type: "retrait", de: B };

  it("refuse un retrait, une demande ou un accord au nom d'un autre", async () => {
    expect((await relay.post(A, "message", retrait)).status).toBe(403);
    expect((await relay.post(A, "message", { ...retrait, preuve: SECRET_C })).status).toBe(403);
    expect((await relay.post(A, "message", { type: "accord", de: B, nom: "Usurpateur", token: TOKEN, preuve: SECRET_C })).status).toBe(403);
    expect((await relay.post(A, "message", { type: "demande", de: B, nom: "Usurpateur", token: TOKEN })).status).toBe(403);
    expect(relay.storage(A).map.get("journal")).toBeUndefined();
  });

  it("accepte le vrai expéditeur, sans jamais transmettre sa preuve", async () => {
    expect((await relay.post(A, "message", { ...retrait, preuve: SECRET_B })).status).toBe(200);
    expect(JSON.stringify([...relay.storage(A).map.entries()])).not.toContain(SECRET_B);
  });

  it("limite les demandes d'un même expéditeur", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await relay.post(A, "message", { type: "demande", de: B, nom: "B", token: TOKEN, preuve: SECRET_B })).status;
    expect(last).toBe(429);
    expect((await relay.post(A, "message", { type: "demande", de: C, nom: "C", token: TOKEN, preuve: SECRET_C })).status).toBe(200);
  });

  it("le propriétaire n'est plus bloqué ni ses proches retirés par un tiers (de bout en bout)", async () => {
    const friends = useFriendsStore();
    friends.me = { code: A, secret: SECRET_A };
    friends.friends = [{ code: B, name: "B", avatar: null, readToken: TOKEN, since: 1 }];
    await relay.post(A, "message", retrait);
    await friends.pollJournal();
    expect(friends.friends).toHaveLength(1);
  });
});

describe("conservation", () => {
  it("efface vraiment le statut d'écoute après une heure", async () => {
    await relay.post(A, "statut", { secret: SECRET_A, statut: { title: "Morceau", playing: true } });
    const storage = relay.storage(A);
    expect(storage.alarm).not.toBeNull();
    expect(storage.alarm! - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    await alarm(A);
    expect(storage.map.has("statut")).toBe(true); // pas encore
    const st = storage.map.get("statut") as { at: number };
    storage.map.set("statut", { ...st, at: Date.now() - 61 * 60 * 1000 });
    await alarm(A);
    expect(storage.map.has("statut")).toBe(false);
  });

  it("purge le journal après 60 jours et la vieille boîte après 7", async () => {
    const storage = relay.storage(A);
    const old = (days: number) => Date.now() - days * 24 * 3600_000;
    storage.map.set("journal", [{ id: "a", type: "mot", at: old(61) }, { id: "b", type: "mot", at: old(30) }]);
    storage.map.set("boite", [{ type: "mot", at: old(8) }, { type: "mot", at: old(1) }]);
    await alarm(A);
    expect((storage.map.get("journal") as unknown[]).length).toBe(1);
    expect((storage.map.get("boite") as unknown[]).length).toBe(1);
  });

  it("efface un profil inactif depuis un an", async () => {
    const storage = relay.storage(A);
    storage.map.set("vu", Date.now() - 366 * 24 * 3600_000);
    await alarm(A);
    expect(storage.map.size).toBe(0);
    expect((await relay.fetch(`https://relais.test/v1/profil/${A}/carte`)).status).toBe(404);
  });

  it("garde un profil actif", async () => {
    const storage = relay.storage(A);
    await alarm(A);
    expect(storage.map.has("secret")).toBe(true);
    expect(storage.alarm).not.toBeNull();
  });
});

describe("suppression du profil", () => {
  it("exige le secret, puis efface tout", async () => {
    await relay.post(A, "statut", { secret: SECRET_A, statut: { title: "Morceau", playing: true } });
    expect((await relay.post(A, "effacer", { secret: SECRET_B })).status).toBe(403);
    expect(relay.storage(A).map.has("carte")).toBe(true);
    expect((await relay.post(A, "effacer", { secret: SECRET_A })).status).toBe(200);
    expect(relay.storage(A).map.size).toBe(0);
    expect(relay.storage(A).alarm).toBeNull();
  });

  it("prévient mes proches et ne laisse rien sur l'appareil", async () => {
    const friends = useFriendsStore();
    friends.me = { code: A, secret: SECRET_A };
    friends.friends = [{ code: B, name: "B", avatar: null, readToken: TOKEN, since: 1 }];
    await friends.erase();
    expect(relay.storage(A).map.size).toBe(0);
    expect(relay.storage(B).map.get("journal")).toHaveLength(1);
    expect(friends.me).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain(SECRET_A);
  });
});

describe("messages chiffrés de bout en bout", () => {
  it("la même clé des deux côtés, aucune pour un tiers", async () => {
    const [pubA, pubB, pubC] = await Promise.all([publicKey(SECRET_A), publicKey(SECRET_B), publicKey(SECRET_C)]);
    expect(pubA).toMatch(/^[0-9a-f]{64}$/);
    const key = await conversationKey(SECRET_A, pubB);
    expect(await conversationKey(SECRET_B, pubA)).toBe(key);
    const sealed = await sealWord(key, { texte: "bonjour", piece: null });
    expect((await openWord(key, sealed)).texte).toBe("bonjour");
    await expect(openWord(await conversationKey(SECRET_C, pubB), sealed)).rejects.toThrow();
    expect(await conversationKey(SECRET_C, pubA)).not.toBe(key);
    void pubC;
  });

  /** Deux appareils (stores) qui se parlent à travers le relais. */
  async function pair() {
    const pubA = await publicKey(SECRET_A);
    const pubB = await publicKey(SECRET_B);
    await relay.post(A, "profil", { secret: SECRET_A, nom: "A", cle: pubA });
    await relay.post(B, "profil", { secret: SECRET_B, nom: "B", cle: pubB });
    await relay.post(A, "autoriser", { secret: SECRET_A, lecteur: B, token: "2".repeat(32) });
    await relay.post(B, "autoriser", { secret: SECRET_B, lecteur: A, token: TOKEN });
    const a = useFriendsStore();
    a.$patch({ me: { code: A, secret: SECRET_A }, enabled: true, friends: [{ code: B, name: "B", avatar: null, readToken: TOKEN, since: 1 }] });
    expect(await a.sendWord(B, "ligne un\nligne deux", null)).toBe(true);
    return a;
  }

  it("le relais ne voit jamais le texte, et le proche le lit", async () => {
    await pair();
    const stored = JSON.stringify([...relay.storage(B).map.entries(), ...relay.storage(A).map.entries()]);
    expect(stored).not.toContain("ligne un");
    expect(stored).toContain("chiffre");

    setActivePinia(createPinia());
    localStorage.clear();
    useShareStore().relay = "https://relais.test";
    const b = useFriendsStore();
    b.$patch({ me: { code: B, secret: SECRET_B }, enabled: true, friends: [{ code: A, name: "A", avatar: null, readToken: "2".repeat(32), since: 1 }] });
    await b.pollJournal();
    expect(b.conversations[A][0].texte).toBe("ligne un\nligne deux");
    expect(b.conversations[A][0].mine).toBe(false);
  });

  it("mon autre appareil relit ce que j'ai envoyé", async () => {
    await pair();
    setActivePinia(createPinia());
    localStorage.clear();
    useShareStore().relay = "https://relais.test";
    const other = useFriendsStore();
    other.$patch({ me: { code: A, secret: SECRET_A }, enabled: true, friends: [{ code: B, name: "B", avatar: null, readToken: TOKEN, since: 1 }] });
    await other.pollJournal();
    expect(other.conversations[B][0]).toMatchObject({ mine: true, texte: "ligne un\nligne deux" });
  });

  it("proche pas encore à jour : le message passe en clair, retours à la ligne gardés", async () => {
    await relay.post(A, "autoriser", { secret: SECRET_A, lecteur: B, token: TOKEN });
    const res = await relay.post(A, "message", { type: "mot", de: B, token: TOKEN, texte: "un\r\ndeux\n\n\n\n\ntrois" });
    expect(res.status).toBe(200);
    const { entrees } = await (await relay.post(A, "journal", { secret: SECRET_A, depuis: 0 })).json();
    expect(entrees[0].texte).toBe("un\ndeux\n\n\ntrois");
  });
});
