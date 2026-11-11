import { defineStore } from "pinia";
import { nextTick } from "vue";
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
  type JournalEntry,
  type SelfEntry,
  type Word,
} from "@/lib/friendsApi";
import { conversationKey, openWord, publicKey, sealWord } from "@/lib/e2e";
import { alert } from "@/lib/alerts";
import { api } from "@/lib/api";
import { PARCEL_MAX_BYTES, receiveParcel, sendParcel } from "@/lib/parcel";
import type { Track } from "@/lib/types";
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
  /** Identifiant de l'entrée du journal (mots reçus) : pas de doublon d'un appareil à l'autre. */
  id?: string;
  mine: boolean;
  texte: string;
  piece: Piece | null;
  at: number;
  /** Son joint reçu : morceaux importés ici (Musique/Music Player/Reçus). */
  recu?: string[];
}

/** Avancement d'un son joint, envoyé (« out:code ») ou reçu (« in:id du colis »). */
export interface ParcelProgress {
  done: number;
  total: number;
  error?: string | null;
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
  /** Sa clé publique : ses messages sont alors chiffrés de bout en bout. */
  pubKey?: string | null;
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
  /** Journal du profil déjà lu (date) et dernières entrées vues (plusieurs appareils). */
  cursor: number;
  seen: string[];
  /** Nom ou photo changés ici depuis la dernière publication de la carte d'ami. */
  cardDirty: boolean;
  /** Dernière carte publiée ou reprise par cet appareil : un écart vient d'un autre appareil. */
  cardSeen: { nom: string; avatar: string | null } | null;
}

function load(): Saved {
  const empty: Saved = {
    me: null,
    enabled: false,
    shareListening: true,
    zoneVisible: false,
    friends: [],
    outgoing: [],
    incoming: [],
    cursor: 0,
    seen: [],
    cardDirty: false,
    cardSeen: null,
  };
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
let lastCard = 0;
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
    /** Carte reprise d'un autre appareil en cours d'application (pas une modification d'ici). */
    adoptingCard: false,
    /** Sons joints en cours d'envoi ou de réception. */
    parcels: {} as Record<string, ParcelProgress>,
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
    /** Profil sans proches, demandes ni conversations : le remplacer ne fait rien perdre. */
    isEmpty: (state) =>
      !state.friends.length && !state.outgoing.length && !state.incoming.length && !Object.values(state.conversations).some((l) => l.length),
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
        cursor: this.cursor,
        seen: this.seen,
        cardDirty: this.cardDirty,
        cardSeen: this.cardSeen,
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

    /** Note pour mes autres appareils (même profil) : ils s'y mettent à jour. */
    note(entree: Partial<SelfEntry>) {
      if (!this.me || !this.base) return;
      void relay.note(this.base, this.me.code, this.me.secret, entree).catch(() => {});
    },
    /** Appareil lié : même profil, mêmes proches et conversations que
     *  l'appareil d'origine ; le journal du relais complète ce qui a changé depuis. */
    adopt(saved: Partial<Saved>, words?: { conversations?: Record<string, ChatLine[]>; unread?: Record<string, number> }) {
      if (!saved.me) return;
      this.stop();
      this.me = saved.me;
      this.enabled = saved.enabled ?? true;
      this.shareListening = saved.shareListening ?? true;
      this.zoneVisible = false;
      this.friends = saved.friends ?? [];
      this.outgoing = saved.outgoing ?? [];
      this.incoming = saved.incoming ?? [];
      this.cursor = 0;
      this.seen = [];
      // Carte d'ami : celle du profil rejoint est reprise (cet appareil n'y a rien changé).
      this.cardSeen = null;
      this.cardDirty = false;
      if (words?.conversations) this.conversations = words.conversations;
      if (words?.unread) this.unread = words.unread;
      this.save();
      this.saveWords();
      this.start();
    },
    /** Cet appareil quitte le groupe de ses appareils liés : plus aucune trace du profil ici. */
    forget() {
      this.stop();
      this.me = null;
      this.enabled = false;
      this.zoneVisible = false;
      this.friends = [];
      this.outgoing = [];
      this.incoming = [];
      this.live = {};
      this.conversations = {};
      this.unread = {};
      this.cursor = 0;
      this.seen = [];
      this.cardSeen = null;
      this.cardDirty = false;
      this.save();
      this.saveWords();
      this.watchInBackground();
      useShareStore().setFriendCode(null);
    },
    /** Profil sur le relais (code d'ami nouveau si déjà pris), sans activer les Proches. */
    async ensureProfile(): Promise<{ code: string; secret: string }> {
      if (!this.base) throw new RelayError("Aucun relais configuré (Réglages → Partage).", 0);
      // Profil existant : la carte du relais est commune à mes appareils, on ne l'écrase pas.
      if (this.me) {
        await this.syncCard(true);
        return this.me;
      }
      const card = await this.myCard();
      for (let attempt = 0; ; attempt++) {
        const me = this.me ?? { code: newCode(), secret: hex(32) };
        try {
          await relay.saveProfile(this.base, me.code, me.secret, card.nom, card.avatar, await publicKey(me.secret));
          this.me = me;
          this.cardSeen = { nom: card.nom, avatar: card.avatar };
          this.cardDirty = false;
          this.save();
          return me;
        } catch (e) {
          if (e instanceof RelayError && e.status === 409 && attempt < 3) {
            this.me = null;
            continue;
          }
          throw e;
        }
      }
    },
    /** Active les Proches : crée le profil sur le relais au besoin. */
    async enable() {
      if (!this.base) {
        this.error = "Aucun relais configuré (Réglages → Partage).";
        return;
      }
      this.busy = true;
      await this.run(async () => {
        await this.ensureProfile();
        this.enabled = true;
        this.save();
        this.start();
        if (this.watching) useShareStore().setFriendCode(this.me!.code);
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
      this.watchInBackground();
      useShareStore().setFriendCode(null);
    },
    /** Nom ou photo changés sur cet appareil : la carte d'ami suivra. */
    markCardDirty() {
      if (this.adoptingCard) return;
      this.cardDirty = true;
      this.save();
    },
    /**
     * Carte d'ami (nom, photo) : la même sur tous mes appareils. Le relais garde la dernière
     * publiée. Un changement fait ici la remplace ; sinon, celle du relais est reprise (venue
     * d'un autre appareil, ou appareil tout juste lié, sans nom ni photo). Un appareil vide
     * n'écrase donc jamais la carte des autres.
     */
    async syncCard(force = false) {
      if (!this.me || !this.base || (!this.enabled && !force)) return;
      const { base, me } = { base: this.base, me: this.me };
      let card: Card | null = null;
      try {
        card = await relay.card(base, me.code);
      } catch (e) {
        if (!(e instanceof RelayError && e.status === 404)) return; // hors ligne : plus tard
      }
      const appearance = useAppearanceStore();
      const local = appearance.settings.profile;
      const localEmpty = !local.name.trim() && !local.avatar;
      const blank = (c: { nom: string; avatar: string | null }) => (!c.nom || c.nom === "Music Player") && !c.avatar;
      const publish = async () => {
        const mine = await this.myCard();
        await relay.saveProfile(base, me.code, me.secret, mine.nom, mine.avatar, await publicKey(me.secret));
        this.cardSeen = { nom: mine.nom, avatar: mine.avatar };
        this.cardDirty = false;
        this.save();
      };
      try {
        if (!card) return await publish();
        const seen = this.cardSeen;
        const fromElsewhere = !seen || seen.nom !== card.nom || seen.avatar !== card.avatar;
        if (this.cardDirty && !localEmpty) return await publish();
        // Carte vide sur le relais (écrasée par un appareil sans nom) : celle d'ici la répare.
        if (blank(card) && !localEmpty) return await publish();
        if (!blank(card) && (fromElsewhere || localEmpty)) {
          await this.adoptCard(card);
          if (!card.cle) await publish();
          return;
        }
        if (!card.cle) await publish();
      } catch {
        // Relais injoignable : nouvel essai au prochain tour.
      }
    },
    /** Reprend le nom et la photo de la carte d'ami (venus d'un autre de mes appareils). */
    async adoptCard(card: Card) {
      const appearance = useAppearanceStore();
      const seen = this.cardSeen;
      this.adoptingCard = true;
      try {
        const name = card.nom === "Music Player" ? "" : card.nom.slice(0, 40);
        if (name !== appearance.settings.profile.name) {
          appearance.settings.profile = { ...appearance.settings.profile, name };
          appearance.changed();
        }
        if (card.avatar !== (seen?.avatar ?? null) || !appearance.settings.profile.avatar) {
          const blob = card.avatar ? await fetch(card.avatar).then((r) => r.blob()).catch(() => null) : null;
          if (blob || !card.avatar) await appearance.setAvatar(blob);
        }
        this.cardSeen = { nom: card.nom, avatar: card.avatar };
        this.cardDirty = false;
        this.save();
        await nextTick();
      } finally {
        this.adoptingCard = false;
      }
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
        await relay.send(base, card.code, { type: "demande", de: code, nom: mine.nom, avatar: mine.avatar, token }, secret);
        if (!existing) this.outgoing.push({ code: card.code, name: card.nom, avatar: card.avatar, token, at: Date.now() });
        this.note({ type: "attente", code: card.code, nom: card.nom, avatar: card.avatar, token });
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
        await relay.send(base, req.code, { type: "accord", de: code, nom: mine.nom, avatar: mine.avatar, token }, secret);
        this.addFriend({ code: req.code, name: req.name, avatar: req.avatar, readToken: req.token, since: Date.now() });
        this.incoming = this.incoming.filter((i) => i.code !== req.code);
        this.note({ type: "ami", code: req.code, nom: req.name, avatar: req.avatar, token: req.token });
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
      this.note({ type: "oubli", code });
      if (this.me && this.base) await relay.revoke(this.base, this.me.code, this.me.secret, code).catch(() => {});
    },
    async remove(friendCode: string) {
      this.friends = this.friends.filter((f) => f.code !== friendCode);
      delete this.live[friendCode];
      this.save();
      this.note({ type: "oubli", code: friendCode });
      if (this.me && this.base) {
        await relay.revoke(this.base, this.me.code, this.me.secret, friendCode).catch(() => {});
        await relay.send(this.base, friendCode, { type: "retrait", de: this.me.code, nom: "", avatar: null, token: null }, this.me.secret).catch(() => {});
      }
    },
    /** Efface le profil du relais (mes proches en sont prévenus), puis de cet appareil. */
    async erase() {
      const { me, base } = this;
      if (me && base) {
        for (const f of this.friends) {
          await relay.send(base, f.code, { type: "retrait", de: me.code, nom: "", avatar: null, token: null }, me.secret).catch(() => {});
        }
        await relay.erase(base, me.code, me.secret);
      }
      this.forget();
    },
    /** Clé publique d'un proche : connue, ou lue sur sa carte. Null s'il n'en a pas encore. */
    async peerKey(code: string): Promise<string | null> {
      const friend = this.friends.find((f) => f.code === code);
      if (friend?.pubKey) return friend.pubKey;
      if (!this.base) return null;
      const card = await relay.card(this.base, code).catch(() => null);
      if (friend && card?.cle) {
        friend.pubKey = card.cle;
        this.save();
      }
      return card?.cle ?? null;
    },
    /** Message chiffré d'une conversation avec `peer`, en clair (texte et pièce jointe). */
    async readSealed(peer: string | null, sealed: string): Promise<{ texte: string; piece: Piece | null }> {
      try {
        if (!this.me || !peer) throw new Error();
        return await openWord(await conversationKey(this.me.secret, peer), sealed);
      } catch {
        return { texte: "Message illisible sur cet appareil.", piece: null };
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
    async onWord(w: Word & { id?: string }) {
      if (!this.isFriend(w.de)) return;
      if (w.id && (this.conversations[w.de] ?? []).some((l) => l.id === w.id)) return;
      const { texte, piece } = w.chiffre ? await this.readSealed(await this.peerKey(w.de), w.chiffre) : w;
      this.addLine(w.de, { id: w.id, mine: false, texte, piece, at: w.at });
      if (this.chatWith !== w.de) this.unread = { ...this.unread, [w.de]: (this.unread[w.de] ?? 0) + 1 };
      this.saveWords();
      const name = this.friends.find((f) => f.code === w.de)?.name ?? "Un proche";
      const what =
        piece?.type === "playlist"
          ? `Playlist : ${piece.nom}`
          : piece?.type === "morceau"
            ? `${piece.colis ? "Vous a envoyé un son" : "Morceau"} : ${piece.titre} · ${piece.artiste}`
            : "";
      this.signal(name, [texte, what].filter(Boolean).join(" — "), w.at, this.chatWith === w.de);
    },
    /** Appli ouverte mais cachée : notification du système (pas pour l'historique relu). */
    /** Message ou demande reçus : bannière dans l'appli, notification si elle n'est pas sous les
     *  yeux (pas pour l'historique relu, ni pour la discussion déjà ouverte). */
    signal(title: string, body: string, at: number, onScreen = false) {
      if (Date.now() - at < 10 * 60_000) alert("messages", title, body, { silentInApp: onScreen });
    },
    /** Android : messages et demandes signalés aussi appli fermée, à partir d'ici. */
    watchInBackground() {
      try {
        if (this.enabled && this.me && this.base) {
          const names = Object.fromEntries(this.friends.map((f) => [f.code, f.name]));
          window.AndroidProches?.watch(this.base, this.me.code, this.me.secret, Math.max(this.cursor, Date.now() - 3600_000), JSON.stringify(names));
        } else {
          window.AndroidProches?.stop();
        }
      } catch {
        // ancienne activité Android
      }
    },
    /** Mot à un proche : texte, et/ou un morceau ou une playlist décrits. */
    async sendWord(code: string, texte: string, piece: Piece | null): Promise<boolean> {
      const friend = this.friends.find((f) => f.code === code);
      if (!friend) return false;
      const ok = await this.run(async () => {
        const { base, code: me, secret } = this.need();
        const words = { texte: texte.trim(), piece };
        // Proche à jour : ni le relais ni personne d'autre ne peut lire le message.
        const peer = await this.peerKey(code);
        if (peer) {
          const chiffre = await sealWord(await conversationKey(secret, peer), words);
          await relay.word(base, code, { de: me, token: friend.readToken, texte: "", piece: null, chiffre });
          this.note({ type: "envoye", code, chiffre: await sealWord(await conversationKey(secret, await publicKey(secret)), words) });
        } else {
          await relay.word(base, code, { de: me, token: friend.readToken, ...words });
          this.note({ type: "envoye", code, ...words });
        }
        this.addLine(code, { mine: true, ...words, at: Date.now() });
        this.saveWords();
        return true;
      });
      return !!ok;
    },
    /**
     * Envoie un morceau dans la discussion, fichier compris : déposé chiffré sur le relais (gardé
     * 7 jours), il arrive même si le proche a l'appli fermée. Proche pas à jour, fichier trop
     * lourd ou relais indisponible : le titre part seul, et on le dit.
     */
    async sendTrack(code: string, track: Track, texte: string): Promise<boolean> {
      const friend = this.friends.find((f) => f.code === code);
      if (!friend || !this.me || !this.base) return false;
      const piece: Piece = { type: "morceau", titre: track.title, artiste: track.artist, album: track.album };
      const key = `out:${code}`;
      let warning: string | null = null;
      if (await this.peerKey(code)) {
        this.parcels[key] = { done: 0, total: 0 };
        let name: string | null = null;
        try {
          const file = await api.parcelPrepare(track.id);
          name = file.name;
          if (file.size > PARCEL_MAX_BYTES) throw new Error(`fichier trop lourd (${Math.round(file.size / 1e6)} Mo, ${Math.round(PARCEL_MAX_BYTES / 1e6)} Mo au plus)`);
          const who = { base: this.base, de: this.me.code, secret: this.me.secret };
          piece.colis = await sendParcel(who, file.size, (offset, len) => api.parcelRead(file.name, offset, len), (done, total) => {
            this.parcels[key] = { done, total };
          });
        } catch (e) {
          warning = `Le fichier n'a pas pu être joint (${e instanceof Error ? e.message : String(e)}) : seul le titre est envoyé.`;
        } finally {
          if (name) void api.parcelForget(name).catch(() => {});
          delete this.parcels[key];
        }
      } else {
        warning = `${friend.name} doit mettre Music Player à jour pour recevoir le fichier : seul le titre est envoyé.`;
      }
      const ok = await this.sendWord(code, texte, piece);
      if (ok && piece.colis) useShareStore().noteShared([track.id], "envoye", { who: friend.name, via: "discussion" });
      if (ok && warning) this.error = warning;
      return ok;
    },
    /** Reprend le fichier d'un son reçu dans la discussion ; renvoie le morceau importé. */
    async receivePiece(code: string, at: number): Promise<string | null> {
      const line = (this.conversations[code] ?? []).find((l) => l.at === at && !l.mine);
      const piece = line?.piece;
      if (!line || piece?.type !== "morceau" || !piece.colis || !this.base) return null;
      const ref = piece.colis;
      const key = `in:${ref.id}`;
      if (this.parcels[key] && !this.parcels[key].error) return null;
      this.parcels[key] = { done: 0, total: ref.taille };
      const name = `colis-${ref.id}.${"mpshare"}`;
      try {
        await receiveParcel(this.base, ref, (data, append) => api.parcelWrite(name, data, append), (done, total) => {
          this.parcels[key] = { done, total };
        });
        const result = await api.parcelImport(name);
        line.recu = result.track_ids;
        this.saveWords();
        const who = this.friends.find((f) => f.code === code)?.name;
        useShareStore().noteShared(result.track_ids, "recu", { who, via: "discussion" });
        delete this.parcels[key];
        return result.track_ids[0] ?? null;
      } catch (e) {
        void api.parcelForget(name).catch(() => {});
        this.parcels[key] = { done: 0, total: ref.taille, error: e instanceof Error ? e.message : String(e) };
        return null;
      }
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
      // Une demande plus ancienne que l'amitié (journal relu sur un autre appareil) est réglée.
      const req: Incoming = { code: m.de, name: m.nom, avatar: m.avatar, token: m.token, at: m.at };
      const known = this.friends.find((f) => f.code === m.de);
      if (known && m.at <= known.since) return;
      if (known || this.outgoing.some((o) => o.code === m.de)) {
        void this.accept(req);
        return;
      }
      this.incoming = [...this.incoming.filter((i) => i.code !== m.de), req];
      this.signal(m.nom || "Music Player", "Vous demande en proche", m.at);
    },
    /** Ce qu'un autre de mes appareils a fait (même profil). */
    async onSelf(e: SelfEntry) {
      if (e.type === "ami" && e.token) {
        this.addFriend({ code: e.code, name: e.nom, avatar: e.avatar, readToken: e.token, since: e.at });
        this.incoming = this.incoming.filter((i) => i.code !== e.code);
      } else if (e.type === "attente" && e.token && !this.isFriend(e.code) && !this.isPending(e.code)) {
        this.outgoing.push({ code: e.code, name: e.nom, avatar: e.avatar, token: e.token, at: e.at });
      } else if (e.type === "oubli") {
        this.friends = this.friends.filter((f) => f.code !== e.code);
        this.outgoing = this.outgoing.filter((o) => o.code !== e.code);
        delete this.live[e.code];
      } else if (e.type === "envoye") {
        // Mot envoyé depuis un autre appareil (celui-ci l'a déjà, à quelques secondes près).
        const { texte, piece } = e.chiffre && this.me ? await this.readSealed(await publicKey(this.me.secret), e.chiffre) : e;
        const lines = this.conversations[e.code] ?? [];
        if (!lines.some((l) => l.mine && l.texte === texte && Math.abs(l.at - e.at) < 120_000)) {
          this.addLine(e.code, { mine: true, texte, piece, at: e.at });
          this.saveWords();
        }
      }
    },
    /** Journal du profil : partagé par tous mes appareils, chacun le lit à son rythme. */
    async pollJournal(): Promise<boolean> {
      if (!this.me || !this.base) return false;
      let entrees: JournalEntry[];
      try {
        ({ entrees } = await relay.journal(this.base, this.me.code, this.me.secret, this.cursor));
      } catch (e) {
        if (e instanceof RelayError && e.status === 404) return false; // relais d'avant le journal
        return true;
      }
      const seen = new Set(this.seen);
      for (const e of entrees.sort((a, b) => a.at - b.at)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        this.cursor = Math.max(this.cursor, e.at);
        if (e.moi) await this.onSelf(e);
        else if (e.type === "mot") await this.onWord(e);
        else this.onMessage(e);
      }
      if (entrees.length) {
        this.seen = [...seen].slice(-300);
        this.save();
      }
      this.watchInBackground();
      return true;
    },
    async pollInbox() {
      if (!this.enabled || !this.me || !this.base) return;
      if (await this.pollJournal()) return;
      try {
        const { messages } = await relay.inbox(this.base, this.me.code, this.me.secret);
        for (const m of messages) {
          if (m.type === "mot") await this.onWord(m);
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
          const before = this.live[a.code];
          // Un proche se met à écouter (après un premier tour, pour ne pas tout annoncer au démarrage).
          if (before && !before.status?.playing && a.statut?.playing) {
            const name = this.friends.find((x) => x.code === a.code)?.name ?? "Un proche";
            alert("proches", `${name} est en ligne`, `Écoute ${a.statut.title} · ${a.statut.artist}`, { key: `en-ligne:${a.code}`, quiet: 30 * 60_000 });
          }
          this.live[a.code] = { status: a.statut ?? null, refused: !!a.refuse, checkedAt: now };
          const f = this.friends.find((x) => x.code === a.code);
          if (f && a.carte && (f.name !== a.carte.nom || f.avatar !== a.carte.avatar || f.pubKey !== (a.carte.cle ?? null))) {
            f.name = a.carte.nom;
            f.avatar = a.carte.avatar;
            f.pubKey = a.carte.cle ?? null;
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
      if (zone) {
        const known = new Set((this.zone?.profiles ?? []).map((p) => p.code));
        const profiles = zone.profils.filter((p) => p.code !== this.me?.code);
        if (this.zone) {
          for (const p of profiles.filter((x) => !known.has(x.code))) {
            alert("proches", "Quelqu'un près de chez vous", `${p.nom} utilise Music Player${zone.zone ? ` à ${zone.zone}` : ""}`, { key: `zone:${p.code}`, quiet: 6 * 3600_000 });
          }
        }
        this.zone = { label: zone.zone, profiles };
      }
    },

    /** Tours réguliers : boîte de réception, statut des amis, rappel de mon statut. */
    tick() {
      if (!this.enabled) return;
      const now = Date.now();
      const hidden = typeof document !== "undefined" && document.hidden;
      // Chaque proche lu compte pour le relais (offre gratuite) : rythme soutenu seulement quand
      // on regarde.
      const friendsEvery = this.watching ? 15_000 : hidden ? 300_000 : 60_000;
      const inboxEvery = this.chatWith ? 5_000 : this.watching ? 15_000 : hidden ? 300_000 : 90_000;
      if (now - lastFriends >= friendsEvery) {
        lastFriends = now;
        void this.pollFriends();
      }
      if (now - lastInbox >= inboxEvery) {
        lastInbox = now;
        void this.pollInbox();
      }
      void this.publish();
      // Nom ou photo changés sur un autre de mes appareils.
      if (now - lastCard >= (hidden ? 600_000 : 120_000)) {
        lastCard = now;
        void this.syncCard();
      }
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
      // Carte d'ami commune à mes appareils (et clé publique des profils d'avant le chiffrement).
      lastCard = Date.now();
      void this.syncCard();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Page « Proches » ouverte : tout de suite à jour. */
    setWatching(on: boolean) {
      this.watching = on;
      // Le code d'ami n'est annoncé sur le Wi-Fi que page Proches ouverte (réseaux publics).
      void useShareStore().setFriendCode(on && this.enabled ? (this.me?.code ?? null) : null);
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
