import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { FakeRelay } from "@/lib/relayTestKit";
import { newSyncKey } from "@/lib/sync";
import type { ShareItem, Track } from "@/lib/types";

// Deux appareils liés (même profil, même clé), le vrai relais en mémoire. Le moteur Rust est
// simulé : chaque appareil a sa bibliothèque ; l'archive envoyée par code est un simple
// « paquet » remis au destinataire quand il saisit le code.
const engine = vi.hoisted(() => ({
  device: "" as string,
  sent: new Map<string, string[]>(),
  received: [] as { device: string; ids: string[] }[],
  scans: 0,
}));
vi.mock("@/lib/api", () => ({
  api: {
    getListens: async () => [],
    importListens: async () => 0,
    listPlaylists: async () => [],
    listFavorites: async () => [],
    addFavorites: async () => 0,
    defaultRelay: async () => "https://relais.test",
    nearbyStart: async () => {},
    deviceIdentity: async () => engine.device,
    nearbyScan: async () => {
      engine.scans++;
      return [];
    },
    remoteSendStart: async (item: ShareItem) => {
      const code = `${1000 + engine.sent.size}-soleil-guitare`;
      engine.sent.set(code, (item.id.split("|")[1] ?? "").split(","));
      return { code };
    },
    remoteReceive: async (code: string) => {
      engine.received.push({ device: engine.device, ids: engine.sent.get(code) ?? [] });
      return { name: "copie", kind: "track", added_tracks: 1, skipped_tracks: 0, playlist_id: null, track_ids: ["recu"] };
    },
  },
}));

import { useDevicesStore } from "./devices";
import { useFriendsStore } from "./friends";
import { useLibraryStore } from "./library";
import { useShareStore } from "./share";
import { useSyncStore } from "./sync";

let relay: FakeRelay;
const BASE = "https://relais.test";
const ME = { code: "K7QM-2D9X", secret: "a".repeat(64) };
const KEY = newSyncKey();

function track(id: string, title: string): Track {
  return { id, path: `/m/${id}.mp3`, title, artist: "Damso", album: "QALF", album_artist: "Damso", track_no: null, disc_no: null, year: null, genre: null, duration_secs: 200, has_cover: false, added_secs: 0 };
}

async function device(id: string, name: string, tracks: Track[]): Promise<Pinia> {
  localStorage.clear();
  const pinia = createPinia();
  setActivePinia(pinia);
  engine.device = id;
  useShareStore().relay = BASE;
  useShareStore().deviceName = name;
  const friends = useFriendsStore();
  friends.me = { ...ME };
  useSyncStore().saved = { key: KEY, lastSync: 0 };
  useLibraryStore().tracks = tracks;
  await useDevicesStore().init();
  return pinia;
}
function on(pinia: Pinia, id: string) {
  setActivePinia(pinia);
  engine.device = id;
  return { devices: useDevicesStore(), sync: useSyncStore(), share: useShareStore() };
}

beforeEach(async () => {
  relay = new FakeRelay();
  engine.sent = new Map();
  engine.received = [];
  engine.scans = 0;
  vi.stubGlobal("fetch", relay.fetch);
  await relay.post(ME.code, "profil", { secret: ME.secret, nom: "Mahouna" });
});

describe("Mes appareils", () => {
  it("le PC voit ce que le téléphone a de plus, le demande, et le téléphone l'envoie seul", async () => {
    const phone = await device("tel", "Téléphone", [track("t1", "Morose"), track("t2", "Silence")]);
    const pc = await device("pc", "Ordinateur", [track("p1", "Silence")]);

    expect(await on(phone, "tel").sync.run()).toBe(true);
    const p = on(pc, "pc");
    expect(await p.sync.run()).toBe(true);
    expect(p.devices.others.map((d) => d.id)).toEqual(["tel"]);
    expect(p.devices.missingHere("tel").map((t) => t.t)).toEqual(["Morose"]);
    expect(p.devices.missingThere("tel")).toEqual([]);

    await p.devices.request("tel", p.devices.missingHere("tel"));
    expect(p.devices.active).toHaveLength(1);
    expect(p.devices.pending("tel").size).toBe(1);

    // Le téléphone voit la demande : pas sur le même Wi-Fi, donc envoi par le relais.
    const t = on(phone, "tel");
    await t.sync.run();
    await vi.waitFor(() => expect(engine.sent.size).toBe(1));
    expect([...engine.sent.values()][0]).toEqual(["t1"]);
    expect(t.devices.copies[0]).toMatchObject({ state: "envoi" });
    await t.sync.run();

    // Le PC récupère le code et reçoit, sans rien saisir.
    const c = on(pc, "pc");
    await c.sync.run();
    await vi.waitFor(() => expect(engine.received).toEqual([{ device: "pc", ids: ["t1"] }]));
    await c.devices.act();
    expect(c.devices.copies[0].state).toBe("fini");
    expect(c.devices.active).toHaveLength(0);
  });

  it("la copie automatique attend le même Wi-Fi", async () => {
    const phone = await device("tel", "Téléphone", [track("t1", "Morose")]);
    const pc = await device("pc", "Ordinateur", [track("p1", "Silence")]);
    await on(phone, "tel").sync.run();
    const p = on(pc, "pc");
    await p.sync.run();
    p.devices.setAuto("tel", true);
    await vi.waitFor(() => expect(p.devices.copies.some((c) => c.auto && c.to === "tel")).toBe(true));
    await vi.waitFor(() => expect(p.sync.running).toBe(false));
    await p.sync.run();

    const t = on(phone, "tel");
    await t.sync.run();
    await t.devices.act();
    expect(engine.scans).toBeGreaterThan(0);
    expect(engine.sent.size).toBe(0);
    expect(t.devices.copies[0].state).toBe("attente");
  });
});
