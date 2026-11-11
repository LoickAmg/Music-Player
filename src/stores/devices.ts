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
  RELAY_DAY_BYTES,
  RELAY_PAUSE_MS,
  requestBytes,
} from "@/lib/devices";
import { alert } from "@/lib/alerts";
import type { NearbyPeer, ShareOffer } from "@/lib/types";
import { useLibraryStore } from "./library";
import { isRunning, useShareStore } from "./share";
import { useSyncStore } from "./sync";
import { useUiStore } from "./ui";

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
  /** Envois par le relais aujourd'hui (offre gratuite) : jour, octets, fin du dernier lot. */
  relay: { day: string; bytes: number; lastEnd: number };
  /** « Plus tard » : liste d'un appareil (sa date) dont les nouveaux sons ne sont plus signalés. */
  dismissed: Record<string, number>;
  /** Sons déjà reçus de chaque appareil : jamais redemandés par la copie automatique. */
  copied: Record<string, string[]>;
}

const today = () => new Date().toISOString().slice(0, 10);

function load(): Saved {
  const empty: Saved = { hash: "", at: 0, copies: [], autoFrom: [], tries: {}, relay: { day: today(), bytes: 0, lastEnd: 0 }, dismissed: {}, copied: {} };
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
    /** Demandes envoyées en ce moment par le relais (un lot à la fois). */
    relaying: {} as Record<string, true>,
    /** Voisins du Wi-Fi, relus au plus toutes les 30 s. */
    peers: [] as NearbyPeer[],
    peersAt: 0,
    /** Dernière liste signalée (appareil:date), pour ne notifier qu'une fois. */
    signalled: "",
  }),
  getters: {
    others(state): DeviceInventory[] {
      return state.devices.filter((d) => d.id !== state.myId);
    },
    mine(state): DeviceInventory | null {
      return state.devices.find((d) => d.id === state.myId) ?? null;
    },
    /** Un autre appareil a des sons absents d'ici, pas encore vus ni demandés : à proposer. */
    notice(): { device: DeviceInventory; count: number } | null {
      for (const d of this.others) {
        if (this.dismissed[d.id] === d.at || this.autoFrom.includes(d.id)) continue;
        if (this.copies.some((c) => c.from === this.myId && c.to === d.id && (c.state === "attente" || c.state === "envoi"))) continue;
        const count = this.mine ? missingFrom(d.tracks, this.mine.tracks).length : 0;
        if (count) return { device: d, count };
      }
      return null;
    },
    /** Envois en cours d'ici vers un autre de mes appareils (à sa demande). */
    sending(state): CopyRequest[] {
      return state.copies.filter((c) => c.to === state.myId && (c.state === "attente" || c.state === "envoi"));
    },
    /** Demandes encore ouvertes qui concernent cet appareil. */
    active(state): CopyRequest[] {
      return state.copies.filter((c) => (c.from === state.myId || c.to === state.myId) && (c.state === "attente" || c.state === "envoi"));
    },
  },
  actions: {
    save() {
      const saved: Saved = {
        hash: this.hash,
        at: this.at,
        copies: this.copies,
        autoFrom: this.autoFrom,
        tries: this.tries,
        relay: this.relay,
        dismissed: this.dismissed,
        copied: this.copied,
      };
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
      const before = new Set(this.copies.filter((c) => c.to === this.myId).map((c) => c.id));
      const stoppedBefore = new Set(this.copies.filter((c) => c.cancelled).map((c) => c.id));
      this.devices = devices;
      this.copies = mergeCopies(this.copies, copies);
      // Copie arrêtée sur l'autre appareil : la copie automatique depuis lui s'arrête aussi.
      for (const c of this.copies) {
        if (c.from === this.myId && c.cancelled && !stoppedBefore.has(c.id) && this.autoFrom.includes(c.to)) {
          this.autoFrom = this.autoFrom.filter((d) => d !== c.to);
          useUiStore().notify(`Copie automatique depuis ${this.nameOf(c.to)} arrêtée.`);
        }
      }
      // Nouvelle demande d'un autre de mes appareils : on le dit avant d'envoyer.
      const fresh = this.copies.filter((c) => c.to === this.myId && c.state === "attente" && !before.has(c.id));
      if (fresh.length) {
        const n = fresh.reduce((s, c) => s + c.tracks.length, 0);
        const text = `${n} son${n > 1 ? "s" : ""} demandé${n > 1 ? "s" : ""} par ${this.nameOf(fresh[0].from)} : envoi dès que possible (Mes appareils pour l'arrêter).`;
        alert("appareils", "Copie entre vos appareils", text);
      }
      this.save();
      this.planAuto();
      this.signalNew();
      void this.act();
      this.pace();
    },
    nameOf(deviceId: string): string {
      return this.devices.find((d) => d.id === deviceId)?.name ?? "votre autre appareil";
    },
    /** Sons d'un autre appareil absents d'ici, pas encore signalés : une notification (une fois
     *  par changement de sa liste). Rien n'est copié sans qu'on le demande. */
    signalNew() {
      const n = this.notice;
      if (!n || this.signalled === `${n.device.id}:${n.device.at}`) return;
      this.signalled = `${n.device.id}:${n.device.at}`;
      // Dans l'appli, le bandeau le dit déjà ; ailleurs, une notification.
      alert("appareils", "Mes appareils", `${n.device.name} a ${n.count} son${n.count > 1 ? "s" : ""} absent${n.count > 1 ? "s" : ""} d'ici. Ouvrez Mes appareils pour choisir.`, {
        silentInApp: true,
      });
    },
    /** « Plus tard » : on ne reparle de cet appareil qu'à son prochain changement de liste. */
    dismiss(deviceId: string) {
      const d = this.devices.find((x) => x.id === deviceId);
      if (d) this.dismissed = { ...this.dismissed, [deviceId]: d.at };
      this.save();
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
    /** Arrête tout ce qui vient de cet appareil (demandé ici) : lots en attente et en cours ; la
     *  copie automatique depuis lui s'arrête aussi. */
    async cancel(deviceId: string) {
      await this.stopPair(this.myId, deviceId);
      if (this.autoFrom.includes(deviceId)) {
        this.autoFrom = this.autoFrom.filter((d) => d !== deviceId);
        useUiStore().notify(`Copie automatique depuis ${this.nameOf(deviceId)} arrêtée.`);
      }
      this.save();
      await this.publish();
    },
    /** Arrête les envois d'ici vers cet appareil (côté expéditeur). */
    async stopSending(deviceId: string) {
      await this.stopPair(deviceId, this.myId);
      await this.publish();
    },
    async stopPair(from: string, to: string) {
      const now = Date.now();
      const share = useShareStore();
      for (const c of this.copies) {
        if (c.from !== from || c.to !== to || (c.state !== "attente" && c.state !== "envoi")) continue;
        const tid = this.working[c.id];
        if (tid) await share.cancel(tid);
        delete this.working[c.id];
        delete this.relaying[c.id];
      }
      this.copies = this.copies.map((c) =>
        c.from === from && c.to === to && (c.state === "attente" || c.state === "envoi")
          ? { ...c, state: "echec", cancelled: true, message: "Arrêtée", code: null, updated: now }
          : c,
      );
      this.save();
    },
    /** Publie tout de suite ; si une synchronisation tourne déjà, au tour suivant. */
    async publish() {
      const sync = useSyncStore();
      sync.localChange();
      await sync.run();
    },
    /** Copie automatique : seulement quand la personne l'active elle-même (Mes appareils). */
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
        const done = new Set(this.copied[id] ?? []);
        const missing = this.missingHere(id)
          .filter((t) => !done.has(`${t.a.trim().toLowerCase()}\u0000${t.t.trim().toLowerCase()}`))
          .slice(0, AUTO_AT_ONCE);
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
    /**
     * Le relais peut-il prendre un lot maintenant ? Un lot à la fois, une pause entre deux lots,
     * 2 Go par jour : l'offre gratuite du relais suffit ainsi, même pour une grosse copie.
     * Renvoie la raison de l'attente, montrée sur les deux appareils, ou null.
     */
    relayWait(): string | null {
      if (this.relay.day !== today()) this.relay = { day: today(), bytes: 0, lastEnd: this.relay.lastEnd };
      if (Object.keys(this.relaying).length) return "Lot suivant dès la fin de celui en cours.";
      if (this.relay.bytes >= RELAY_DAY_BYTES) return "Limite du jour par le relais atteinte (2 Go) : la suite reprend demain, ou tout de suite sur le même Wi-Fi.";
      const pause = this.relay.lastEnd + RELAY_PAUSE_MS - Date.now();
      if (pause > 0) return `Courte pause entre deux lots (${Math.ceil(pause / 1000)} s).`;
      return null;
    },
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
            if (this.relaying[c.id]) {
              delete this.relaying[c.id];
              this.relay.lastEnd = Date.now();
              if (t?.progress.stage === "fini") this.relay.bytes += requestBytes(c);
              this.save();
            }
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
        if (c.from === this.myId) {
          const keys = c.tracks.map((t) => `${t.a.trim().toLowerCase()}\u0000${t.t.trim().toLowerCase()}`);
          this.copied = { ...this.copied, [c.to]: [...new Set([...(this.copied[c.to] ?? []), ...keys])].slice(-5000) };
        }
        this.mark(c.id, { state: "fini", message: null });
        return;
      }
      // Arrêtée ou refusée par la personne (d'un côté ou de l'autre) : jamais relancée.
      if (stage === "refuse" || /annul|refus|arr[êe]t/i.test(message ?? "")) {
        void this.stopPair(c.from, c.to).then(() => useSyncStore().localChange());
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
      const wait = this.relayWait();
      if (wait) {
        if (c.message !== wait) this.mark(c.id, { message: wait });
        return;
      }
      this.relaying[c.id] = true;
      const started = await share.sendRemoteItemTracked(item, label);
      if (!started) {
        delete this.relaying[c.id];
        this.relay.lastEnd = Date.now();
        this.settle(c, "erreur", "Envoi impossible pour l'instant.");
        return;
      }
      this.working[c.id] = started.id;
      const sent = share.byId(started.id);
      if (sent) sent.meta = { who: this.devices.find((d) => d.id === c.from)?.name, via: "appareils" };
      this.mark(c.id, { state: "envoi", code: started.code, message: null });
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
