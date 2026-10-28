import { defineStore } from "pinia";
import {
  type Card,
  hex,
  type Message,
  newCode,
  type Piece,
  type Presence,
  relay,
  RelayError,
  relayBase,
  smallAvatar,
  type Word,
} from "@/lib/friendsApi";
import { useAppearanceStore } from "./appearance";
import { useLibraryStore } from "./library";
import { usePlayerStore } from "./player";
import { useShareStore } from "./share";

// Proches : on s'ajoute par code d'ami (ou depuis la liste des appareils du même Wi-Fi, ou
// de sa ville sur option) ; l'ajout n'aboutit que si l'autre accepte. Chacun voit alors ce
// que l'autre écoute, si l'autre a choisi de le partager. Tout passe par le relais du
// partage ; l'état (code, secret, amis) reste sur l'appareil.

const KEY = "mp:proches";
/** Conversations avec les proches (gardées sur l'appareil, 300 lignes par proche au plus). */
const WORDS_KEY = "mp:proches-mots";
const MAX_LINES = 300;

export interface ChatLine {
  mine: boolean;
  texte: string;
  piece: Piece | null;
  at: number;
}

function loadWords(): { conversations: Record<string, ChatLine[]>; unread: Record<string, number> } {
  try {
    const raw = localStorage.getItem(WORDS_KEY);
    if (raw) return { conversations: {}, unread: {}, ...(JSON.parse(raw) as object) };
  } catch {
    // illisible : on repart de zéro
  }
  return { conversations: {}, unread: {} };
}

export interface Friend {
  code: string;
  name: string;
  avatar: string | null;
  /** Jeton reçu de l'ami : permet de lire son statut. */
  readToken: string;
  since: number;
}

/** Demande envoyée, en attente d'accord (avec le jeton déjà donné). */
export interface Outgoing {
  code: string;
  name: string;
  avatar: string | null;
  token: string;
  at: number;
}

/** Demande reçue, en attente de réponse. */
export interface Incoming {
  code: string;
  name: string;
  avatar: string | null;
  token: string;
  at: number;
}

export interface Live {
  status: Presence | null;
  /** L'ami a retiré l'autorisation (ou réinstallé l'appli). */
  refused: boolean;
  checkedAt: number;
}

interface Saved {
  me: { code: string; secret: string } | null;
  enabled: boolean;
  shareListening: boolean;
  zoneVisible: boolean;
  friends: Friend[];
  outgoing: Outgoing[];
  incoming: Incoming[];
}

function load(): Saved {
  const empty: Saved = { me: null, enabled: false, shareListening: true, zoneVisible: false, friends: [], outgoing: [], incoming: [] };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as Partial<Saved>) } : empty;
  } catch {
    return empty;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastInbox = 0;
let lastFriends = 0;
let lastPublish = 0;
let lastAnnounce = 0;
let publishedKey = "";

export const useFriendsStore = defineStore("friends", {
  state: () => ({
    ...load(),
    live: {} as Record<string, Live>,
    ...loadWords(),
    /** Conversation ouverte (code du proche), ou null. */
    chatWith: null as string | null,
    /** Page « Proches » à l'écran : rafraîchissement plus fréquent. */
    watching: false,
    zone: null as { label: string | null; profiles: Card[] } | null,
    error: null as string | null,
    busy: false,
  }),
  getters: {
    base(): string | null {
      const r = useShareStore().relayInUse;
      return r ? relayBase(r) : null;
    },
    /** Amis en train d'écouter quelque chose, le plus récent d'abord. */
    listening(state): { friend: Friend; status: Presence }[] {
      return state.friends
        .map((friend) => ({ friend, status: state.live[friend.code]?.status ?? null }))
        .filter((x): x is { friend: Friend; status: Presence } => !!x.status && isFresh(x.status))
        .sort((a, b) => Number(b.status.playing) - Number(a.status.playing) || b.status.at - a.status.at);
    },
    isFriend: (state) => (code: string) => state.friends.some((f) => f.code === code),
    unreadTotal: (state) => Object.values(state.unread).reduce((s, n) => s + n, 0),
    isPending: (state) => (code: string) => state.outgoing.some((o) => o.code === code),
  },
  actions: {
    save() {
      const saved: Saved = {
        me: this.me,
        enabled: this.enabled,
        shareListening: this.shareListening,
        zoneVisible: this.zoneVisible,
        friends: this.friends,
        outgoing: this.outgoing,
        incoming: this.incoming,
      };
      try {
        localStorage.setItem(KEY, JSON.stringify(saved));
      } catch {
        // réglages valables pour la session
      }
    },
    need(): { base: string; code: string; secret: string } {
      if (!this.base) throw new RelayError("Aucun relais configuré (Réglages → Partage).", 0);
      if (!this.me || !this.enabled) throw new RelayError("Activez d'abord les Proches.", 0);
      return { base: this.base, code: this.me.code, secret: this.me.secret };
    },
    async myCard(): Promise<{ nom: string; avatar: string | null }> {
      const appearance = useAppearanceStore();
      const { name, avatar } = appearance.settings.profile;
      return { nom: name.trim() || "Music Player", avatar: await smallAvatar(avatar ? appearance.assetUrl(avatar) : null) };
    },
    async run<T>(task: () => Promise<T>): Promise<T | null> {
      this.error = null;
      try {
        return await task();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return null;
      }
    },

    /** Active les Proches : crée le profil sur le relais (code d'ami nouveau si déjà pris). */
    async enable() {
      if (!this.base) {
        this.error = "Aucun relais configuré (Réglages → Partage).";
        return;
      }
      this.busy = true;
      await this.run(async () => {
        const card = await this.myCard();
        for (let attempt = 0; ; attempt++) {
          const me = this.me ?? { code: newCode(), secret: hex(32) };
          try {
            await relay.saveProfile(this.base!, me.code, me.secret, card.nom, card.avatar);
            this.me = me;
            break;
          } catch (e) {
            if (e instanceof RelayError && e.status === 409 && attempt < 3) {
              this.me = null;
              continue;
            }
            throw e;
          }
        }
        this.enabled = true;
        this.save();
        this.start();
        useShareStore().setFriendCode(this.me!.code);
      });
      this.busy = false;
    },
    async disable() {
      if (this.me && this.base) {
        await relay.setStatus(this.base, this.me.code, this.me.secret, null).catch(() => {});
        if (this.zoneVisible) await relay.announce(this.base, this.me.code, this.me.secret, false).catch(() => {});
      }
      this.enabled = false;
      this.zoneVisible = false;
      this.save();
      this.stop();
      useShareStore().setFriendCode(null);
    },
    /** Nom ou photo du profil modifiés : carte d'ami mise à jour. */
    async refreshCard() {
      if (!this.enabled || !this.me || !this.base) return;
      const card = await this.myCard();
      await relay.saveProfile(this.base, this.me.code, this.me.secret, card.nom, card.avatar).catch(() => {});
    },

    async findProfile(code: string): Promise<Card | null> {
      if (!this.base) return null;
      return this.run(() => relay.card(this.base!, code));
    },
    /** Demande d'ami : l'autre pourra lire mon statut dès qu'il accepte. */
    async request(card: Card) {
      if (card.code === this.me?.code || this.isFriend(card.code)) return;
      await this.run(async () => {
        const { base, code, secret } = this.need();
        const existing = this.outgoing.find((o) => o.code === card.code);
        const token = existing?.token ?? hex(16);
        await relay.grant(base, code, secret, card.code, token);
        const mine = await this.myCard();
        await relay.send(base, card.code, { type: "demande", de: code, nom: mine.nom, avatar: mine.avatar, token });
        if (!existing) this.outgoing.push({ code: card.code, name: card.nom, avatar: card.avatar, token, at: Date.now() });
        // Demande croisée : l'autre m'avait déjà demandé, on s'accepte tout de suite.
        const crossed = this.incoming.find((i) => i.code === card.code);
        if (crossed) await this.accept(crossed);
        this.save();
      });
    },
    async accept(req: Incoming) {
      await this.run(async () => {
        const { base, code, secret } = this.need();
        const token = this.outgoing.find((o) => o.code === req.code)?.token ?? hex(16);
        await relay.grant(base, code, secret, req.code, token);
        const mine = await this.myCard();
        await relay.send(base, req.code, { type: "accord", de: code, nom: mine.nom, avatar: mine.avatar, token });
        this.addFriend({ code: req.code, name: req.name, avatar: req.avatar, readToken: req.token, since: Date.now() });
        this.incoming = this.incoming.filter((i) => i.code !== req.code);
        this.save();
        lastFriends = 0;
      });
    },
    refuse(req: Incoming) {
      this.incoming = this.incoming.filter((i) => i.code !== req.code);
      this.save();
    },
    async cancelRequest(code: string) {
      this.outgoing = this.outgoing.filter((o) => o.code !== code);
      this.save();
      if (this.me && this.base) await relay.revoke(this.base, this.me.code, this.me.secret, code).catch(() => {});
    },
    async remove(friendCode: string) {
      this.friends = this.friends.filter((f) => f.code !== friendCode);
      delete this.live[friendCode];
      this.save();
      if (this.me && this.base) {
        await relay.revoke(this.base, this.me.code, this.me.secret, friendCode).catch(() => {});
        await relay.send(this.base, friendCode, { type: "retrait", de: this.me.code, nom: "", avatar: null, token: null }).catch(() => {});
      }
    },
    addFriend(friend: Friend) {
      const i = this.friends.findIndex((f) => f.code === friend.code);
      if (i >= 0) this.friends[i] = { ...this.friends[i], ...friend, since: this.friends[i].since };
      else this.friends.push(friend);
      this.outgoing = this.outgoing.filter((o) => o.code !== friend.code);
    },

    saveWords() {
      try {
        localStorage.setItem(WORDS_KEY, JSON.stringify({ conversations: this.conversations, unread: this.unread }));
      } catch {
        // stockage plein ou indisponible : la conversation reste pour la session
      }
    },
    addLine(code: string, line: ChatLine) {
      const lines = [...(this.conversations[code] ?? []), line].slice(-MAX_LINES);
      this.conversations = { ...this.conversations, [code]: lines };
    },
    onWord(w: Word) {
      if (!this.isFriend(w.de)) return;
      this.addLine(w.de, { mine: false, texte: w.texte, piece: w.piece, at: w.at });
      if (this.chatWith !== w.de) this.unread = { ...this.unread, [w.de]: (this.unread[w.de] ?? 0) + 1 };
      this.saveWords();
    },
    /** Mot à un proche : texte, et/ou un morceau ou une playlist décrits. */
    async sendWord(code: string, texte: string, piece: Piece | null): Promise<boolean> {
      const friend = this.friends.find((f) => f.code === code);
      if (!friend) return false;
      const ok = await this.run(async () => {
        const { base, code: me } = this.need();
        await relay.word(base, code, { de: me, token: friend.readToken, texte: texte.trim(), piece });
        this.addLine(code, { mine: true, texte: texte.trim(), piece, at: Date.now() });
        this.saveWords();
        return true;
      });
      return !!ok;
    },
    openChat(code: string | null) {
      this.chatWith = code;
      if (code && this.unread[code]) {
        const rest = { ...this.unread };
        delete rest[code];
        this.unread = rest;
        this.saveWords();
      }
      lastInbox = 0;
    },
    onMessage(m: Message) {
      if (m.type === "retrait") {
        this.friends = this.friends.filter((f) => f.code !== m.de);
        this.outgoing = this.outgoing.filter((o) => o.code !== m.de);
        this.incoming = this.incoming.filter((i) => i.code !== m.de);
        delete this.live[m.de];
        return;
      }
      if (!m.token) return;
      if (m.type === "accord") {
        // Accord à une demande envoyée (ou nouveau jeton d'un ami qui a réinstallé l'appli).
        if (this.outgoing.some((o) => o.code === m.de) || this.isFriend(m.de)) {
          this.addFriend({ code: m.de, name: m.nom, avatar: m.avatar, readToken: m.token, since: Date.now() });
        }
        return;
      }
      // Demande : d'un ami déjà connu (il a réinstallé l'appli) ou croisée → acceptée d'office.
      const req: Incoming = { code: m.de, name: m.nom, avatar: m.avatar, token: m.token, at: m.at };
      if (this.isFriend(m.de) || this.outgoing.some((o) => o.code === m.de)) {
        void this.accept(req);
        return;
      }
      this.incoming = [...this.incoming.filter((i) => i.code !== m.de), req];
    },
    async pollInbox() {
      if (!this.enabled || !this.me || !this.base) return;
      try {
        const { messages } = await relay.inbox(this.base, this.me.code, this.me.secret);
        for (const m of messages) {
          if (m.type === "mot") this.onWord(m);
          else this.onMessage(m);
        }
        if (messages.length) this.save();
      } catch {
        // hors ligne : au prochain tour
      }
    },
    async pollFriends() {
      if (!this.enabled || !this.me || !this.base || !this.friends.length) return;
      try {
        const { amis } = await relay.friends(
          this.base,
          this.me.code,
          this.friends.map((f) => ({ code: f.code, token: f.readToken })),
        );
        const now = Date.now();
        for (const a of amis) {
          this.live[a.code] = { status: a.statut ?? null, refused: !!a.refuse, checkedAt: now };
          const f = this.friends.find((x) => x.code === a.code);
          if (f && a.carte && (f.name !== a.carte.nom || f.avatar !== a.carte.avatar)) {
            f.name = a.carte.nom;
            f.avatar = a.carte.avatar;
            this.save();
          }
        }
      } catch {
        // hors ligne : au prochain tour
      }
    },
    /** Publie ce que j'écoute (musique seulement : jamais les vocaux ni les enregistrements). */
    async publish(force = false) {
      if (!this.enabled || !this.me || !this.base) return;
      const player = usePlayerStore();
      const library = useLibraryStore();
      const t = player.currentTrack;
      const music = t && library.kindOf(t) === "musique";
      const status =
        this.shareListening && t && music
          ? {
              title: t.title,
              artist: t.artist,
              album: t.album,
              playing: !player.isPaused,
              duration: t.duration_secs,
              position: player.positionAt(performance.now()),
            }
          : null;
      const key = status ? `${status.title}|${status.artist}|${status.playing}` : "rien";
      // Rien de neuf : un rappel par minute pendant la lecture (le statut reste « frais »).
      if (!force && key === publishedKey && (!status?.playing || Date.now() - lastPublish < 60_000)) return;
      publishedKey = key;
      lastPublish = Date.now();
      await relay.setStatus(this.base, this.me.code, this.me.secret, status).catch(() => {
        publishedKey = "";
      });
    },
    setShareListening(on: boolean) {
      this.shareListening = on;
      this.save();
      void this.publish(true);
    },
    async setZoneVisible(on: boolean) {
      await this.run(async () => {
        const { base, code, secret } = this.need();
        await relay.announce(base, code, secret, on);
        this.zoneVisible = on;
        lastAnnounce = Date.now();
        this.save();
        await this.loadZone();
      });
    },
    async loadZone() {
      if (!this.base) return;
      const zone = await this.run(() => relay.zone(this.base!));
      if (zone) this.zone = { label: zone.zone, profiles: zone.profils.filter((p) => p.code !== this.me?.code) };
    },

    /** Tours réguliers : boîte de réception, statut des amis, rappel de mon statut. */
    tick() {
      if (!this.enabled) return;
      const now = Date.now();
      const hidden = typeof document !== "undefined" && document.hidden;
      const friendsEvery = this.watching ? 8_000 : hidden ? 120_000 : 20_000;
      const inboxEvery = this.chatWith ? 4_000 : this.watching ? 10_000 : hidden ? 180_000 : 45_000;
      if (now - lastFriends >= friendsEvery) {
        lastFriends = now;
        void this.pollFriends();
      }
      if (now - lastInbox >= inboxEvery) {
        lastInbox = now;
        void this.pollInbox();
      }
      void this.publish();
      if (this.zoneVisible && now - lastAnnounce >= 5 * 60_000 && this.me && this.base) {
        lastAnnounce = now;
        void relay.announce(this.base, this.me.code, this.me.secret, true).catch(() => {});
      }
    },
    start() {
      if (timer || !this.enabled) return;
      lastFriends = lastInbox = 0;
      timer = setInterval(() => this.tick(), 4_000);
      this.tick();
      if (this.me) useShareStore().setFriendCode(this.me.code);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Page « Proches » ouverte : tout de suite à jour. */
    setWatching(on: boolean) {
      this.watching = on;
      if (on) {
        lastFriends = lastInbox = 0;
        this.tick();
      }
    },
  },
});

/** Statut encore pertinent : en lecture depuis moins de 3 min, en pause depuis moins d'1 h. */
export function isFresh(s: Presence, now = Date.now()): boolean {
  return now - s.at < (s.playing ? 3 * 60_000 : 60 * 60_000);
}
