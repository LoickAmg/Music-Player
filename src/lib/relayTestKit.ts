// Pour les tests : le vrai code du relais, avec un stockage en mémoire et sans réseau.
import worker, { Colis, Profil } from "../../relay/src/index.js";

export class FakeStorage {
  map = new Map<string, unknown>();
  alarm: number | null = null;
  async get(k: string) {
    const v = this.map.get(k);
    return v === undefined ? undefined : structuredClone(v);
  }
  async put(k: string, v: unknown) {
    this.map.set(k, structuredClone(v));
  }
  async delete(k: string) {
    this.map.delete(k);
  }
  async deleteAll() {
    this.map.clear();
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

export class FakeRelay {
  stores = new Map<string, FakeStorage>();
  profiles = new Map<string, Profil>();
  env = {
    PROFILS: {
      idFromName: (n: string) => n,
      get: (id: string) => this.profile(id),
    },
    COLIS: {
      idFromName: (n: string) => n,
      get: (id: string) => this.parcel(id),
    },
  };
  parcels = new Map<string, { colis: Colis; storage: FakeStorage }>();
  parcel(id: string): Colis {
    let found = this.parcels.get(id);
    if (!found) {
      const storage = new FakeStorage();
      found = { colis: new Colis({ storage }), storage };
      this.parcels.set(id, found);
    }
    return found.colis;
  }
  profile(code: string): Profil {
    let found = this.profiles.get(code);
    if (!found) {
      const storage = new FakeStorage();
      this.stores.set(code, storage);
      found = new Profil({ storage });
      this.profiles.set(code, found);
    }
    return found;
  }
  storage(code: string): FakeStorage {
    this.profile(code);
    return this.stores.get(code)!;
  }
  fetch = (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), this.env);
  post(code: string, action: string, body: unknown) {
    return this.fetch(`https://relais.test/v1/profil/${code}/${action}`, { method: "POST", body: JSON.stringify(body) });
  }
}
