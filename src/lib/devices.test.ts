import { describe, expect, it } from "vitest";
import { BATCH_TRACKS, batches, type CopyRequest, inventoryHash, inventoryOf, localIds, mergeCopies, mergeDevices, missingFrom, newRequests, RELAY_CYCLE_BYTES, requestBytes } from "./devices";
import type { Track } from "./types";

function track(id: string, title: string, artist = "Damso", extra: Partial<Track> = {}): Track {
  return { id, path: `/m/${id}.mp3`, title, artist, album: "QALF", album_artist: artist, track_no: null, disc_no: null, year: null, genre: null, duration_secs: 200, has_cover: false, added_secs: 0, ...extra };
}
const inv = (title: string, artist = "Damso") => ({ t: title, a: artist, al: "QALF", d: 200 });

describe("inventaire d'un appareil", () => {
  it("laisse de côté les fichiers abîmés et les doublons", () => {
    const list = inventoryOf([track("a", "Morose"), track("b", "morose"), track("c", "Θ. Macarena", "Damso", { damage: "illisible" })]);
    expect(list.map((t) => t.t)).toEqual(["Morose"]);
  });
  it("garde la même empreinte tant que la liste ne change pas", () => {
    const a = inventoryOf([track("a", "Morose"), track("b", "Silence")]);
    const b = inventoryOf([track("x", "Silence"), track("y", "Morose")]);
    expect(inventoryHash(a)).toBe(inventoryHash(b));
    expect(inventoryHash(inventoryOf([track("a", "Morose")]))).not.toBe(inventoryHash(a));
  });
});

describe("morceaux manquants", () => {
  it("rapproche les morceaux malgré des étiquettes un peu différentes", () => {
    const phone = [inv("Morose"), inv("Silence"), inv("Tard", "Nayte")];
    const pc = [{ ...inv("morose"), al: "" }];
    expect(missingFrom(phone, pc).map((t) => t.t)).toEqual(["Silence", "Tard"]);
  });
});

describe("demandes de copie", () => {
  it("découpe une grosse demande en lots numérotés (40 morceaux au plus), chacun avec son jeton", () => {
    const many = Array.from({ length: BATCH_TRACKS * 2 + 3 }, (_, i) => ({ ...inv(`Titre ${i}`), d: 30 }));
    const reqs = newRequests("pc", "tel", many);
    expect(reqs.map((r) => r.tracks.length)).toEqual([BATCH_TRACKS, BATCH_TRACKS, 3]);
    expect(reqs.map((r) => `${r.part}/${r.parts}`)).toEqual(["1/3", "2/3", "3/3"]);
    expect(new Set(reqs.map((r) => r.token)).size).toBe(3);
    expect(reqs.every((r) => r.state === "attente" && r.from === "pc" && r.to === "tel")).toBe(true);
  });

  it("garde chaque lot sous 150 Mo pour l'offre gratuite du relais (playlist de 100 sons)", () => {
    const playlist = Array.from({ length: 100 }, (_, i) => inv(`Titre ${i}`)); // 3 min 20 chacun
    const reqs = newRequests("pc", "tel", playlist);
    expect(reqs.reduce((s, r) => s + r.tracks.length, 0)).toBe(100);
    expect(reqs.every((r) => requestBytes(r) <= RELAY_CYCLE_BYTES)).toBe(true);
    expect(reqs.length).toBe(6);
    expect(batches([{ ...inv("Très long mix"), d: 3 * 3600 }])).toHaveLength(1);
  });

  it("garde l'état le plus avancé d'une demande vue des deux côtés", () => {
    const [r] = newRequests("pc", "tel", [inv("Morose")], false, 1000);
    const sent: CopyRequest = { ...r, state: "envoi", code: "4821-soleil-guitare", updated: 2000 };
    const done: CopyRequest = { ...r, state: "fini", updated: 3000 };
    expect(mergeCopies([r], [sent], 5000)[0]).toMatchObject({ state: "envoi", code: "4821-soleil-guitare" });
    expect(mergeCopies([sent], [done], 5000)[0].state).toBe("fini");
    expect(mergeCopies([done], [sent], 5000)[0].state).toBe("fini");
  });

  it("oublie les demandes terminées depuis deux jours", () => {
    const [r] = newRequests("pc", "tel", [inv("Morose")], false, 0);
    const day = 24 * 3600 * 1000;
    expect(mergeCopies([{ ...r, state: "fini", updated: 0 }], [], 3 * day)).toEqual([]);
    expect(mergeCopies([r], [], day)).toHaveLength(1);
  });

  it("retrouve sur l'appareil d'origine les fichiers demandés", () => {
    const [r] = newRequests("pc", "tel", [inv("Morose"), inv("Absent")]);
    expect(localIds(r, [track("m1", "Morose"), track("m2", "Autre")])).toEqual(["m1"]);
  });
});

describe("inventaires de plusieurs appareils", () => {
  it("garde pour chaque appareil la liste la plus récente", () => {
    const old = { id: "tel", name: "Téléphone", platform: "android" as const, at: 1, tracks: [] };
    const fresh = { ...old, at: 2, tracks: [inv("Morose")] };
    const pc = { id: "pc", name: "Ordinateur", platform: "pc" as const, at: 5, tracks: [] };
    const merged = mergeDevices([old, pc], [fresh]);
    expect(merged.find((d) => d.id === "tel")?.tracks).toHaveLength(1);
    expect(merged).toHaveLength(2);
  });
});
