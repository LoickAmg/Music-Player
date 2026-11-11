import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { FakeRelay } from "@/lib/relayTestKit";

// Carte d'ami (nom, photo) commune à tous les appareils d'un même profil.
vi.mock("@/lib/api", () => ({
  api: {
    setAppearance: async () => {},
    importAsset: async () => "photo.jpg",
    deleteAsset: async () => {},
    defaultRelay: async () => "https://relais.test",
    nearbyStart: async () => {},
  },
}));

import { useAppearanceStore } from "./appearance";
import { useFriendsStore } from "./friends";
import { useShareStore } from "./share";

let relay: FakeRelay;
const BASE = "https://relais.test";
const ME = { code: "K7QM-2D9X", secret: "a".repeat(64) };
const PHOTO = "data:image/jpeg;base64,/9j/AAAA";

/** Un appareil : sa propre mémoire (pinia), le même relais. */
function device(name: string): Pinia {
  localStorage.clear();
  const pinia = createPinia();
  setActivePinia(pinia);
  useShareStore().relay = BASE;
  const friends = useFriendsStore();
  friends.me = { ...ME };
  friends.enabled = true;
  useAppearanceStore().settings.profile = { name, avatar: null };
  return pinia;
}
const on = (pinia: Pinia) => {
  setActivePinia(pinia);
  return { friends: useFriendsStore(), profile: () => useAppearanceStore().settings.profile };
};
const card = async () => (await relay.fetch(`${BASE}/v1/profil/${ME.code}/carte`)).json();

beforeEach(async () => {
  relay = new FakeRelay();
  // Les photos des cartes sont des adresses data: ; le reste passe par le relais en mémoire.
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).startsWith("data:") ? Promise.resolve(new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }))) : relay.fetch(url, init),
  );
  await relay.post(ME.code, "profil", { secret: ME.secret, nom: "Mahouna", avatar: PHOTO });
});

describe("carte d'ami entre appareils liés", () => {
  it("un appareil sans nom reprend la carte au lieu de l'écraser", async () => {
    const pc = on(device(""));
    await pc.friends.syncCard();
    expect((await card()).nom).toBe("Mahouna");
    expect(pc.profile().name).toBe("Mahouna");
    expect(pc.profile().avatar).toBe("photo.jpg");
    expect(pc.friends.cardDirty).toBe(false);
  });

  it("un nom changé sur un appareil arrive sur l'autre", async () => {
    const phone = device("Mahouna");
    const pc = device("");
    await on(pc).friends.syncCard();

    const p = on(phone);
    p.friends.cardSeen = { nom: "Mahouna", avatar: PHOTO };
    useAppearanceStore().settings.profile = { name: "Loïck", avatar: null };
    p.friends.markCardDirty();
    await p.friends.syncCard();
    expect((await card()).nom).toBe("Loïck");

    const c = on(pc);
    await c.friends.syncCard();
    expect(c.profile().name).toBe("Loïck");
  });

  it("une carte déjà écrasée par « Music Player » est réparée par l'appareil qui a un nom", async () => {
    await relay.post(ME.code, "profil", { secret: ME.secret, nom: "", avatar: null });
    expect((await card()).nom).toBe("Music Player");
    const phone = on(device("Mahouna"));
    phone.friends.cardSeen = { nom: "Mahouna", avatar: PHOTO };
    await phone.friends.syncCard();
    expect((await card()).nom).toBe("Mahouna");
  });

  it("au démarrage, un appareil vide ne republie pas de carte vide", async () => {
    const pc = on(device(""));
    pc.friends.start();
    pc.friends.stop();
    await vi.waitFor(async () => expect(pc.profile().name).toBe("Mahouna"));
    expect((await card()).nom).toBe("Mahouna");
  });
});
