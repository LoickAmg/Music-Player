import { defineStore } from "pinia";
import { api } from "@/lib/api";
import {
  alreadyAsked,
  type CopyRequest,
  type DeviceInventory,
  inventoryHash,
  inventoryOf,
  type InvTrack,
  localIds,
  mergeCopies,
  missingFrom,
  newRequests,
} from "@/lib/devices";
import type { NearbyPeer, ShareOffer } from "@/lib/types";
import { useLibraryStore } from "./library";
import { isRunning, useShareStore } from "./share";
import { useSyncStore } from "./sync";

// Mes appareils (liés au même profil) : ce que chacun a et que l'autre n'a pas, et la copie
// d'un appareil à l'autre, demandée ici ou automatique. Celui qui a les fichiers les envoie
// tout seul quand il voit la demande : par le Wi-Fi si les deux s'y voient, sinon par le
// relais (sauf copie automatique, réservée au Wi-Fi pour ne pas consommer de données mobiles).

const KEY = "mp:mes-appareils";
const onAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
/** Rythme de vérification quand une copie me concerne (sinon : celui de la synchronisation). */
const ACTIVE_EVERY = 15_000;
/** Liste des voisins du Wi-Fi gardée ce temps-là avant d'être relue. */
const PEERS_TTL = 30_000;
/** Copie automatique : demandes de cette taille au plus à la fois. */
const AUTO_AT_ONCE = 120;

interface Saved {
  /** Empreinte et date de ma liste de morceaux (la date ne bouge que si la liste change). */
  hash: string;
  at: number;
  copies: CopyRequest[];
  /** Appareils dont les nouveaux morceaux arrivent ici tout seuls. */
  autoFrom: string[];
  /** Essais d'envoi par le relais restés sans réponse, par demande. */
  tries: Record<string, number>;
}

function load(): Saved {
  const empty: Saved = { hash: "", at: 0, copies: [], autoFrom: [], tries: {} };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as Partial<Saved>) } : empty;
  } catch {
    return empty;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export const useDevicesStore = defineStore("devices", {
  state: () => ({
    ...load(),
    myId: "",
    /** Inventaires de tous mes appareils, tels que la dernière synchronisation les a donnés. */
    devices: [] as DeviceInventory[],
    acting: false,
    /** Demande en cours ici → transfert suivi (envoi ou réception). */
    working: {} as Record<string, string>,
    /** Voisins du Wi-Fi, relus au plus toutes les 30 s. */
    peers: [] as NearbyPeer[],
    peersAt: 0,
  }),
  getters: {
    others(state): DeviceInventory[] {
      return state.devices.filter((d) => d.id !== state.myId);
    },
    mine(state): DeviceInventory | null {
      return state.devices.find((d) => d.id === state.myId) ?? null;
    },
    /** Demandes encore ouvertes qui concernent cet appareil. */
    active(state): CopyRequest[] {
      return state.copies.filter((c) => (c.from === state.myId || c.to === state.myId) && (c.state === "attente" || c.state === "envoi"));
    },
  },
  actions: {
    save() {
      const saved: Saved = { hash: this.hash, at: this.at, copies: this.copies, autoFrom: this.autoFrom, tries: this.tries };
      try {
        localStorage.setItem(KEY, JSON.stringify(saved));
      } catch {
        // valable pour la session
      }
    },
    async init() {
      if (this.myId) return;
      this.myId = await api.deviceIdentity().catch(() => "");
    },

    /** Ma liste de morceaux, publiée avec l'état synchronisé. */
    selfInventory(): DeviceInventory | null {
      if (!this.myId) return null;
      const tracks = inventoryOf(useLibraryStore().tracks);
      const hash = inventoryHash(tracks);
      if (hash !== this.hash) {
        this.hash = hash;
        this.at = Date.now();
        this.save();
      }
      // Le nom du profil est le même partout : l'appareil se présente par son genre.
      const name = onAndroid ? "Téléphone" : "Ordinateur";
      return { id: this.myId, name, platform: onAndroid ? "android" : "pc", at: this.at, tracks };
    },
    /** Ce que cet appareil apporte à la synchronisation. */
    forSync(): { devices: DeviceInventory[]; copies: CopyRequest[] } {
      const self = this.selfInventory();
      const others = this.devices.filter((d) => d.id !== this.myId);
      return { devices: self ? [...others, self] : others, copies: this.copies };
    },
    /** État fusionné reçu de la synchronisation. */
    onSynced(devices: DeviceInventory[], copies: CopyRequest[]) {
      this.devices = devices;
      this.copies = mergeCopies(this.copies, copies);
      this.save();
      this.planAuto();
      void this.act();
      this.pace();
    },

    /** Morceaux d'un autre appareil qui manquent ici. */
    missingHere(deviceId: string): InvTrack[] {
      const other = this.devices.find((d) => d.id === deviceId);
      const self = this.selfInventory();
      if (!other || !self) return [];
      return missingFrom(other.tracks, self.tracks);
    },
    /** Morceaux d'ici qui manquent sur un autre appareil. */
    missingThere(deviceId: string): InvTrack[] {
      const other = this.devices.find((d) => d.id === deviceId);
      const self = this.selfInventory();
      if (!other || !self) return [];
      return missingFrom(self.tracks, other.tracks);
    },
    /** Morceaux en route depuis cet appareil (demandés, pas encore arrivés). */
    pending(deviceId: string): Set<string> {
      return alreadyAsked(this.copies, this.myId, deviceId);
    },

    /** Demande à un autre appareil de copier ces morceaux ici. */
    async request(deviceId: string, tracks: InvTrack[], auto = false) {
      if (!this.myId || !tracks.length) return;
      const asked = this.pending(deviceId);
      const fresh = tracks.filter((t) => !asked.has(`${t.a.trim().toLowerCase()}\u0000${t.t.trim().toLowerCase()}`));
      if (!fresh.length) return;
      this.copies = [...this.copies, ...newRequests(this.myId, deviceId, fresh, auto)];
      this.save();
      this.pace();
      await this.publish();
    },
    /** Annule les demandes encore en attente vers cet appareil. */
    async cancel(deviceId: string) {
      const now = Date.now();
      this.copies = this.copies.map((c) =>
        c.from === this.myId && c.to === deviceId && c.state === "attente" ? { ...c, state: "echec", message: "Annulée", updated: now } : c,
      );
      this.save();
      await this.publish();
    },
    /** Publie tout de suite ; si une synchronisation tourne déjà, au tour suivant. */
    async publish() {
      const sync = useSyncStore();
      sync.localChange();
      await sync.run();
    },
    setAuto(deviceId: string, on: boolean) {
      this.autoFrom = on ? [...new Set([...this.autoFrom, deviceId])] : this.autoFrom.filter((d) => d !== deviceId);
      this.save();
      if (on) {
        this.planAuto();
        void this.publish();
      }
    },
    /** Copie automatique : les morceaux qui manquent ici sont demandés, par paquets. */
    planAuto() {
      for (const id of this.autoFrom) {
        if (!this.devices.some((d) => d.id === id)) continue;
        if (this.copies.some((c) => c.from === this.myId && c.to === id && (c.state === "attente" || c.state === "envoi"))) continue;
        const missing = this.missingHere(id).slice(0, AUTO_AT_ONCE);
        if (!missing.length) continue;
        this.copies = [...this.copies, ...newRequests(this.myId, id, missing, true)];
        useSyncStore().localChange();
      }
      this.save();
    },

    /** Changement d'état d'une demande, publié aussitôt. */
    mark(id: string, patch: Partial<CopyRequest>) {
      this.copies = this.copies.map((c) => (c.id === id ? { ...c, ...patch, updated: Date.now() } : c));
      this.save();
      useSyncStore().localChange();
    },
    async nearbyPeer(deviceId: string): Promise<NearbyPeer | null> {
      if (Date.now() - this.peersAt > PEERS_TTL) {
        this.peers = await api.nearbyScan().catch(() => []);
        this.peersAt = Date.now();
      }
      return this.peers.find((p) => p.id === deviceId) ?? null;
    },

    /** Ce que cet appareil doit faire pour les demandes en cours : envoyer, recevoir, constater. */
    async act() {
      if (this.acting || !this.myId) return;
      this.acting = true;
      const share = useShareStore();
      try {
        for (const c of this.copies) {
          const tid = this.working[c.id];
          const t = tid ? share.byId(tid) : null;
          if (t && isRunning(t)) continue;
          if (tid) {
            delete this.working[c.id];
            this.settle(c, t?.progress.stage ?? "erreur", t?.progress.message ?? null);
            continue;
          }
          if (c.to === this.myId && c.state === "attente") await this.send(c);
          else if (c.to === this.myId && c.state === "envoi") this.mark(c.id, { state: "attente", code: null }); // envoi interrompu (appli fermée)
          else if (c.from === this.myId && c.state === "envoi" && c.code) await this.receive(c);
        }
      } finally {
        this.acting = false;
      }
    },
    /** Fin d'un transfert suivi ici. */
    settle(c: CopyRequest, stage: string, message: string | null) {
      if (stage === "fini") {
        delete this.tries[c.id];
        this.mark(c.id, { state: "fini", message: null });
        return;
      }
      if (c.to === this.myId) {
        // Envoi sans réponse (l'autre appareil était fermé) : nouvel essai plus tard.
        const tries = (this.tries[c.id] ?? 0) + 1;
        this.tries[c.id] = tries;
        this.mark(c.id, tries >= 4 ? { state: "echec", message: message ?? "L'autre appareil n'a pas répondu." } : { state: "attente", code: null });
      } else {
        // Réception ratée : l'expéditeur relancera un envoi.
        this.mark(c.id, { state: "attente", code: null, message });
      }
    },
    async send(c: CopyRequest) {
      const share = useShareStore();
      const ids = localIds(c, useLibraryStore().tracks);
      if (!ids.length) {
        this.mark(c.id, { state: "echec", message: "Ces morceaux ne sont plus sur l'appareil d'origine." });
        return;
      }
      const item = { kind: "copy" as const, id: `${c.token}|${ids.join(",")}` };
      const label = `${ids.length} morceau${ids.length > 1 ? "x" : ""} pour ${this.devices.find((d) => d.id === c.from)?.name ?? "un autre appareil"}`;
      const peer = await this.nearbyPeer(c.from);
      if (peer) {
        this.mark(c.id, { state: "envoi", code: null });
        const tid = share.sendNearbyItem(peer, item, label);
        const sent = share.byId(tid);
        if (sent) sent.meta = { who: peer.name, via: "appareils" };
        this.working[c.id] = tid;
        return;
      }
      // Copie automatique : seulement sur le même Wi-Fi.
      if (c.auto) return;
      const started = await share.sendRemoteItemTracked(item, label);
      if (!started) {
        this.settle(c, "erreur", "Envoi impossible pour l'instant.");
        return;
      }
      this.working[c.id] = started.id;
      const sent = share.byId(started.id);
      if (sent) sent.meta = { who: this.devices.find((d) => d.id === c.from)?.name, via: "appareils" };
      this.mark(c.id, { state: "envoi", code: started.code });
    },
    async receive(c: CopyRequest) {
      const share = useShareStore();
      const from = this.devices.find((d) => d.id === c.to)?.name ?? "Mon autre appareil";
      const t = share.receiveRemoteTracked(c.code!, `Copie depuis ${from}`);
      t.meta = { who: from, via: "appareils" };
      this.working[c.id] = t.id;
    },
    /** Envoi d'un voisin : accepté sans question s'il porte le jeton d'une de mes demandes. */
    claimOffer(offer: ShareOffer): boolean {
      return offer.kind === "copie" && this.copies.some((c) => c.from === this.myId && c.token === offer.name && (c.state === "attente" || c.state === "envoi"));
    },
    /** Copie reçue par le Wi-Fi : la demande est remplie. Renvoie le nom de l'appareil d'origine
     *  (pour l'historique), ou null si ce n'était pas une de mes copies. */
    onReceived(name: string): string | null {
      const c = this.copies.find((x) => x.from === this.myId && x.token === name);
      if (!c) return null;
      if (c.state !== "fini") this.mark(c.id, { state: "fini", message: null });
      return this.devices.find((d) => d.id === c.to)?.name ?? "Mon autre appareil";
    },

    /** Vérifications rapprochées tant qu'une copie me concerne. */
    pace() {
      if (this.active.length && !timer) {
        timer = setInterval(() => {
          if (!this.active.length) {
            clearInterval(timer!);
            timer = null;
            return;
          }
          void useSyncStore().check();
          void this.act();
        }, ACTIVE_EVERY);
      }
    },
  },
});
