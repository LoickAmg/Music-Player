import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { Profil } from "../../relay/src/index.js";
import type { Listen } from "./recap";
import {
  asBase,
  decrypt,
  deletions,
  type DeviceState,
  downloadDoc,
  EMPTY_BASE,
  encrypt,
  localDoc,
  mergeDocs,
  newSyncKey,
  planApply,
  suspicious,
  type SyncBase,
  type SyncIdentity,
  uploadDoc,
} from "./sync";
import type { Playlist, Track } from "./types";

function track(id: string, title: string, artist = "Artiste"): Track {
  return { id, path: `/m/${id}.mp3`, title, artist, album: "Album", album_artist: artist, track_no: null, disc_no: null, year: null, genre: null, duration_secs: 200, has_cover: false, added_secs: 0 };
}
const playlist = (name: string, ids: string[]): Playlist => ({ id: `id-${name}`, name, track_ids: ids, theme: "ocean", style: null });

/** Appareil de test : ses fichiers, playlists et titres aimés, et sa base. */
class Device {
  base: SyncBase = EMPTY_BASE;
  listens: Listen[] = [];
  constructor(
    public library: Track[],
    public playlists: Playlist[] = [],
    public favoriteIds: string[] = [],
  ) {}
  get state(): DeviceState {
    return { playlists: this.playlists, favoriteIds: this.favoriteIds, library: this.library, listens: this.listens };
  }
  /** Un tour de synchronisation contre l'état commun ; renvoie le nouvel état commun. */
  sync(remote: ReturnType<typeof localDoc>) {
    const merged = mergeDocs(this.base, localDoc(this.base, this.state), remote);
    const plan = planApply(merged, this.state);
    for (const p of plan.createPlaylists) this.playlists.push({ ...playlist(p.name, p.ids), theme: p.theme });
    this.playlists = this.playlists.filter((p) => !plan.deletePlaylists.includes(p.id));
    for (const a of plan.addTracks) this.playlists.find((p) => p.id === a.id)!.track_ids.push(...a.ids);
    for (const r of plan.removeTracks) {
      const p = this.playlists.find((x) => x.id === r.id)!;
      p.track_ids = p.track_ids.filter((id) => !r.ids.includes(id));
    }
    this.favoriteIds = [...this.favoriteIds.filter((id) => !plan.removeFavorites.includes(id)), ...plan.addFavorites];
    this.listens.push(...plan.listens);
    this.base = asBase(merged);
    return merged;
  }
}

const EMPTY = () => localDoc(EMPTY_BASE, { playlists: [], favoriteIds: [], library: [], listens: [] });

describe("synchronisation entre appareils", () => {
  // Le PC et le téléphone ont les mêmes morceaux, sous des identifiants différents.
  const pcLib = () => [track("p1", "Lemon"), track("p2", "Redo"), track("p3", "Bota")];
  const phoneLib = () => [track("t1", "Lemon"), track("t2", "Redo"), track("t3", "Bota")];

  it("réunit les deux appareils au premier passage", () => {
    const pc = new Device(pcLib(), [playlist("Soir", ["p1"])], ["p2"]);
    const phone = new Device(phoneLib(), [playlist("Matin", ["t3"])], ["t1"]);
    let doc = pc.sync(EMPTY());
    doc = phone.sync(doc);
    doc = pc.sync(doc);
    expect(phone.playlists.map((p) => p.name).sort()).toEqual(["Matin", "Soir"]);
    expect(pc.playlists.map((p) => p.name).sort()).toEqual(["Matin", "Soir"]);
    expect(phone.favoriteIds.sort()).toEqual(["t1", "t2"]);
    expect(pc.favoriteIds.sort()).toEqual(["p1", "p2"]);
    expect(pc.playlists.find((p) => p.name === "Matin")!.track_ids).toEqual(["p3"]);
    expect(doc.playlists).toHaveLength(2);
  });

  it("fait suivre les suppressions : playlist, morceau et titre aimé", () => {
    const pc = new Device(pcLib(), [playlist("Soir", ["p1", "p2"]), playlist("Vieille", ["p3"])], ["p1", "p2"]);
    const phone = new Device(phoneLib());
    let doc = pc.sync(EMPTY());
    doc = phone.sync(doc);
    expect(phone.playlists).toHaveLength(2);

    // Sur le téléphone : une playlist supprimée, un morceau retiré, un titre plus aimé.
    phone.playlists = phone.playlists.filter((p) => p.name !== "Vieille");
    phone.playlists[0].track_ids = ["t1"];
    phone.favoriteIds = ["t1"];
    doc = phone.sync(doc);
    doc = pc.sync(doc);

    expect(pc.playlists.map((p) => p.name)).toEqual(["Soir"]);
    expect(pc.playlists[0].track_ids).toEqual(["p1"]);
    expect(pc.favoriteIds).toEqual(["p1"]);
    expect(doc.playlists).toHaveLength(1);

    // Et elles ne reviennent pas au tour suivant.
    doc = phone.sync(doc);
    expect(phone.playlists.map((p) => p.name)).toEqual(["Soir"]);
    expect(doc.favorites.map((f) => f.title)).toEqual(["Lemon"]);
  });

  it("un morceau absent de cet appareil n'est pas supprimé pour les autres", () => {
    const pc = new Device(pcLib(), [playlist("Soir", ["p1", "p3"])]);
    const phone = new Device([track("t1", "Lemon")]); // pas de « Bota » sur le téléphone
    let doc = pc.sync(EMPTY());
    doc = phone.sync(doc);
    expect(phone.playlists[0].track_ids).toEqual(["t1"]);
    doc = phone.sync(doc);
    doc = pc.sync(doc);
    expect(pc.playlists[0].track_ids).toEqual(["p1", "p3"]);
    expect(doc.playlists[0].tracks.map((t) => t.title).sort()).toEqual(["Bota", "Lemon"]);
  });

  it("les étiquettes différentes d'un appareil à l'autre ne provoquent ni perte ni doublon", () => {
    const pc = new Device([track("p1", "Soleil", "(D)Juno feat. X")], [playlist("Soir", ["p1"])]);
    const phone = new Device([track("t1", "Soleil", "(D)Juno")]);
    let doc = pc.sync(EMPTY());
    doc = phone.sync(doc);
    expect(phone.playlists[0].track_ids).toEqual(["t1"]);
    for (let i = 0; i < 3; i++) {
      doc = phone.sync(doc);
      doc = pc.sync(doc);
    }
    expect(phone.playlists[0].track_ids).toEqual(["t1"]);
    expect(pc.playlists[0].track_ids).toEqual(["p1"]);
    expect(doc.playlists[0].tracks).toHaveLength(1);
  });

  it("deux fichiers aux mêmes étiquettes ne sont pas échangés l'un contre l'autre", () => {
    const pc = new Device([track("a", "Lemon"), track("b", "Lemon")], [playlist("Soir", ["b"])]);
    const doc = pc.sync(EMPTY());
    expect(planApply(doc, pc.state).addTracks).toEqual([]);
    expect(planApply(doc, pc.state).removeTracks).toEqual([]);
  });

  it("additionne l'écoute sans doublon", () => {
    const listen = (started: number): Listen => ({ track_id: "x", title: "Lemon", artist: "Artiste", album: "Album", started, secs: 100, duration_secs: 200 });
    const pc = new Device(pcLib());
    const phone = new Device(phoneLib());
    pc.listens = [listen(1), listen(2)];
    phone.listens = [listen(2), listen(3)];
    let doc = pc.sync(EMPTY());
    doc = phone.sync(doc);
    doc = pc.sync(doc);
    expect(doc.listens.map((l) => l.started).sort()).toEqual([1, 2, 3]);
    expect(pc.listens).toHaveLength(3);
    expect(phone.listens.find((l) => l.started === 1)!.track_id).toBe("t1");
  });

  it("repère une suppression massive", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const library = ids.map((id) => track(id, `Titre ${id}`));
    const pc = new Device(library, [playlist("Tout", ids)], []);
    const doc = pc.sync(EMPTY());
    const emptied = { ...doc, playlists: [{ ...doc.playlists[0], tracks: [] }] };
    const plan = planApply(emptied, pc.state);
    expect(deletions(plan)).toBe(30);
    expect(suspicious(plan, pc.state)).toBe(true);
    expect(suspicious(planApply(doc, pc.state), pc.state)).toBe(false);
  });

  it("garde l'image de jaquette propre à l'appareil", () => {
    const pc = new Device(pcLib(), [{ ...playlist("Soir", ["p1"]), style: { image: "photo.jpg", dim: 0.3 } }]);
    const doc = pc.sync(EMPTY());
    expect(doc.playlists[0].style?.image).toBeNull();
    expect(planApply(doc, pc.state).restyle).toEqual([]);
    const restyled = { ...doc, playlists: [{ ...doc.playlists[0], style: { image: null, dim: 0.8 } }] };
    expect(planApply(restyled, pc.state).restyle[0].style).toEqual({ image: "photo.jpg", dim: 0.8 });
  });
});

describe("état commun sur le relais", () => {
  class Storage {
    map = new Map<string, unknown>();
    async get(k: string) {
      return this.map.get(k);
    }
    async put(k: string, v: unknown) {
      this.map.set(k, v);
    }
    async delete(k: string) {
      this.map.delete(k);
    }
  }
  let profiles: Map<string, Profil>;
  const env = {
    PROFILS: {
      idFromName: (n: string) => n,
      get: (id: string) => {
        if (!profiles.has(id)) profiles.set(id, new Profil({ storage: new Storage() }));
        return profiles.get(id)!;
      },
    },
  };
  const id: SyncIdentity = { base: "https://relais.test", code: "K7QM-2D9X", secret: "a".repeat(64), key: newSyncKey() };
  const doc = (name: string) => ({ ...EMPTY(), playlists: [{ name, theme: "x", style: null, tracks: [] }] });

  beforeEach(async () => {
    profiles = new Map();
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env));
    await fetch(`${id.base}/v1/profil/${id.code}/profil`, { method: "POST", body: JSON.stringify({ secret: id.secret, nom: "A" }) });
  });

  it("publie et relit un état chiffré que le relais ne peut pas lire", async () => {
    expect(await downloadDoc(id)).toBeNull();
    await uploadDoc(id, doc("Secrète"), null);
    const stored = JSON.stringify([...(profiles.get(id.code) as unknown as { state: { storage: Storage } }).state.storage.map.entries()]);
    expect(stored).not.toContain("Secrète");
    expect((await downloadDoc(id))!.doc.playlists[0].name).toBe("Secrète");
  });

  it("refuse une publication basée sur une version dépassée", async () => {
    await uploadDoc(id, doc("Un"), null);
    const { version } = (await downloadDoc(id))!;
    await uploadDoc(id, doc("Deux"), version);
    await expect(uploadDoc(id, doc("Trois"), version)).rejects.toMatchObject({ status: 409 });
    expect((await downloadDoc(id))!.doc.playlists[0].name).toBe("Deux");
  });

  it("un envoi abandonné ne casse pas l'état publié", async () => {
    await uploadDoc(id, doc("Bon"), null);
    const { version } = (await downloadDoc(id))!;
    const post = (body: unknown) => fetch(`${id.base}/v1/profil/${id.code}/synchroenvoi`, { method: "POST", body: JSON.stringify(body) });
    const chunk = { secret: id.secret, attendu: version, total: 2, data: "QUJD" };
    await post({ ...chunk, envoi: "a".repeat(32), n: 0 });
    // Un morceau d'un autre envoi n'est pas mélangé au premier.
    expect((await post({ ...chunk, envoi: "b".repeat(32), n: 1 })).status).toBe(409);
    expect((await downloadDoc(id))!.doc.playlists[0].name).toBe("Bon");
    await uploadDoc(id, doc("Suivant"), version);
    expect((await downloadDoc(id))!.doc.playlists[0].name).toBe("Suivant");
  });

  it("exige le secret du profil", async () => {
    const wrong = { ...id, secret: "b".repeat(64) };
    await expect(downloadDoc(wrong)).rejects.toMatchObject({ status: 403 });
    await expect(uploadDoc(wrong, doc("x"), null)).rejects.toMatchObject({ status: 403 });
  });

  it("une autre clé ne déchiffre rien", async () => {
    await expect(decrypt(newSyncKey(), await encrypt(id.key, "secret"))).rejects.toThrow();
  });
});
