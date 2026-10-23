import { defineStore } from "pinia";
import { api } from "@/lib/api";
import type { NearbyPeer, ShareImportResult, ShareItem, ShareOffer, TransferProgress } from "@/lib/types";

// Réglages du partage (par appareil).
const VISIBLE_KEY = "mp:share-visible";
const RELAY_KEY = "mp:share-relay";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // réglage valable pour la session
  }
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `t${Date.now().toString(36)}${counter}`;
}

/** Envoi ou réception suivi dans l'interface. */
export interface Transfer {
  id: string;
  direction: "envoi" | "reception";
  /** Ce qui est partagé (nom du morceau ou de la playlist), quand on le sait. */
  label: string;
  /** Appareil voisin, ou code de partage. */
  peer: string | null;
  code: string | null;
  progress: TransferProgress;
  result: ShareImportResult | null;
}

export const useShareStore = defineStore("share", {
  state: () => ({
    /** Fenêtre « Partager » ouverte pour cet élément. */
    sharing: null as (ShareItem & { name: string }) | null,
    /** Fenêtre « Recevoir avec un code » ouverte. */
    receiving: false,
    peers: [] as NearbyPeer[],
    scanning: false,
    scanError: null as string | null,
    transfers: [] as Transfer[],
    /** Envois proposés par un appareil voisin, en attente de réponse. */
    offers: [] as { id: string; offer: ShareOffer }[],
    /** Appareil visible des voisins (et prêt à recevoir) pendant que l'appli est ouverte. */
    visible: read(VISIBLE_KEY) !== "0",
    /** Relais choisi sur cet appareil (vide : celui de l'application). */
    relay: read(RELAY_KEY) ?? "",
    defaultRelay: null as string | null,
    /** Nom sous lequel cet appareil se présente. */
    deviceName: "",
  }),
  getters: {
    relayInUse: (s): string | null => s.relay.trim() || s.defaultRelay,
    byId: (s) => (id: string) => s.transfers.find((t) => t.id === id) ?? null,
  },
  actions: {
    async init(deviceName: string) {
      try {
        this.defaultRelay = await api.defaultRelay();
      } catch {
        this.defaultRelay = null;
      }
      await this.setDeviceName(deviceName);
    },
    /** Nom affiché aux voisins (nom du profil) ; relance la visibilité si besoin. */
    async setDeviceName(name: string) {
      this.deviceName = name;
      if (this.visible) await this.startVisible();
    },
    async startVisible() {
      try {
        await api.nearbyStart(this.deviceName);
      } catch {
        // pas de réseau local (hors ligne, mode avion) : réessayé au prochain retour dans l'appli
      }
    },
    async setVisible(on: boolean) {
      this.visible = on;
      write(VISIBLE_KEY, on ? "1" : "0");
      if (on) await this.startVisible();
      else await api.nearbyStop().catch(() => {});
    },
    setRelay(url: string) {
      this.relay = url.trim();
      write(RELAY_KEY, this.relay || null);
    },

    open(item: ShareItem, name: string) {
      this.sharing = { ...item, name };
      this.peers = [];
      void this.scan();
    },
    close() {
      this.sharing = null;
    },
    async scan() {
      this.scanning = true;
      this.scanError = null;
      try {
        this.peers = await api.nearbyScan();
      } catch (e) {
        this.scanError = String(e);
      } finally {
        this.scanning = false;
      }
    },

    track(t: Omit<Transfer, "progress" | "result">): Transfer {
      const transfer: Transfer = {
        ...t,
        progress: { id: t.id, stage: "attente", done: 0, total: 0, message: null },
        result: null,
      };
      this.transfers.unshift(transfer);
      // L'objet suivi par Vue (et non l'objet d'origine) : ses changements s'affichent.
      return this.transfers[0];
    },
    onProgress(p: TransferProgress) {
      const t = this.byId(p.id);
      if (t) t.progress = { ...p, message: p.message ?? t.progress.message };
    },
    finish(id: string, stage: TransferProgress["stage"], message: string | null) {
      const t = this.byId(id);
      if (t) t.progress = { ...t.progress, stage, message };
    },
    dismiss(id: string) {
      this.transfers = this.transfers.filter((t) => t.id !== id);
    },
    async cancel(id: string) {
      await api.transferCancel(id).catch(() => {});
    },

    /** Envoi à un appareil voisin. */
    async sendNearby(peer: NearbyPeer) {
      if (!this.sharing) return;
      const item: ShareItem = { kind: this.sharing.kind, id: this.sharing.id };
      const t = this.track({ id: newId(), direction: "envoi", label: this.sharing.name, peer: peer.name, code: null });
      try {
        await api.nearbySend(peer, item, this.deviceName, t.id);
        this.finish(t.id, "fini", null);
      } catch (e) {
        const message = String(e);
        this.finish(t.id, message.includes("refusé") ? "refuse" : "erreur", message);
      }
    },
    /** Envoi à distance : renvoie le code à transmettre (l'envoi attend en arrière-plan). */
    async sendRemote(): Promise<string | null> {
      if (!this.sharing) return null;
      const item: ShareItem = { kind: this.sharing.kind, id: this.sharing.id };
      const t = this.track({ id: newId(), direction: "envoi", label: this.sharing.name, peer: null, code: null });
      try {
        const { code } = await api.remoteSendStart(item, this.deviceName, this.relay.trim() || null, t.id);
        t.code = code;
        return code;
      } catch (e) {
        this.finish(t.id, "erreur", String(e));
        return null;
      }
    },
    /** Réception avec un code saisi. */
    async receiveRemote(code: string): Promise<Transfer> {
      const t = this.track({ id: newId(), direction: "reception", label: "", peer: null, code: code.trim() });
      try {
        t.result = await api.remoteReceive(code, this.relay.trim() || null, t.id);
        t.label = t.result.name;
        this.finish(t.id, "fini", null);
      } catch (e) {
        this.finish(t.id, "erreur", String(e));
      }
      return t;
    },

    /** Envoi proposé par un voisin : en attente de réponse. */
    onOffer(id: string, offer: ShareOffer) {
      this.offers.push({ id, offer });
    },
    async answer(id: string, accept: boolean) {
      const pending = this.offers.find((o) => o.id === id);
      this.offers = this.offers.filter((o) => o.id !== id);
      await api.nearbyAnswer(id, accept).catch(() => {});
      if (accept && pending) {
        this.track({ id, direction: "reception", label: pending.offer.name, peer: pending.offer.from, code: null });
      }
    },
    onReceived(result: ShareImportResult) {
      const t = this.transfers.find((x) => x.direction === "reception" && !x.result && x.label === result.name);
      if (t) t.result = result;
    },
  },
});
