import { defineStore } from "pinia";
import { api } from "@/lib/api";
import { relay, RelayError } from "@/lib/friendsApi";
import {
  asBase,
  decrypt,
  deletions,
  type DeviceState,
  downloadDoc,
  EMPTY_BASE,
  emptyDoc,
  localDoc,
  mergeDocs,
  newSyncKey,
  planApply,
  sameDoc,
  suspicious,
  type SyncBase,
  type SyncDoc,
  type SyncIdentity,
  type SyncPlan,
  uploadDoc,
} from "@/lib/sync";
import { useFavoritesStore } from "./favorites";
import { type ChatLine, type Friend, type Incoming, type Outgoing, useFriendsStore } from "./friends";
import { useLibraryStore } from "./library";
import { useListeningStore } from "./listening";
import { usePlaylistsStore } from "./playlists";
import { useShareStore } from "./share";

// Appareils liés : on relie deux appareils une fois avec un code de partage (chiffré de bout en
// bout), puis playlists, titres aimés et écoute restent identiques, sans compte ni mot de passe.

const KEY = "mp:synchro";
const BASE_KEY = "mp:synchro-base";
/** Ancien compte (0.5.13 et avant), repris une fois à la mise à jour. */
const OLD_ACCOUNT_KEY = "mp:compte";
const LINK_FORMAT = "music-player-lien";
/** Le relais est interrogé à ce rythme quand l'appli est ouverte. */
const CHECK_EVERY = 5 * 60 * 1000;
/** Délai après un changement sur cet appareil, pour regrouper plusieurs gestes. */
const AFTER_CHANGE = 15 * 1000;

interface Saved {
  key: string;
  lastSync: number;
}

/** Ce qu'un appareil transmet à celui qu'on relie (uniquement par le code de partage). */
export interface LinkPayload {
  format: typeof LINK_FORMAT;
  key: string;
  from: string;
  proches: {
    me: { code: string; secret: string };
    enabled: boolean;
    shareListening: boolean;
    friends: Friend[];
    outgoing: Outgoing[];
    incoming: Incoming[];
  };
  mots: { conversations: Record<string, ChatLine[]> };
}

export function parseLink(text: string): LinkPayload | null {
  try {
    const data = JSON.parse(text) as Partial<LinkPayload>;
    return data.format === LINK_FORMAT && typeof data.key === "string" && !!data.proches?.me?.secret ? (data as LinkPayload) : null;
  } catch {
    return null;
  }
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function store(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // stockage indisponible : valable pour la session
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;
let applying = false;
let lastVersion: string | null = null;
/** Une modification faite ici attend d'être publiée. */
let dirty = true;
/** Ancienne sauvegarde du compte, à fusionner au premier passage. */
let inherited: SyncDoc | null = null;

export const useSyncStore = defineStore("sync", {
  state: () => ({
    saved: load<Saved>(KEY),
    running: false,
    error: null as string | null,
    /** Beaucoup de suppressions à appliquer : on attend l'accord de la personne. */
    held: null as number | null,
    /** Code à saisir sur l'autre appareil, pendant une liaison. */
    linkCode: null as string | null,
    linkBusy: false,
    /** Ce téléphone ou ce PC attend un lien : un lien qui arrive sans ça est ignoré. */
    awaitingLink: false,
    /** Lien reçu, à confirmer avant de l'appliquer. */
    pendingLink: null as LinkPayload | null,
  }),
  getters: {
    linked: (state) => !!state.saved,
  },
  actions: {
    persist() {
      store(KEY, this.saved);
    },
    identity(): SyncIdentity | null {
      const friends = useFriendsStore();
      if (!this.saved || !friends.me || !friends.base) return null;
      return { base: friends.base, code: friends.me.code, secret: friends.me.secret, key: this.saved.key };
    },
    device(listens: DeviceState["listens"]): DeviceState {
      return {
        playlists: usePlaylistsStore().items,
        favoriteIds: [...useFavoritesStore().ids],
        library: useLibraryStore().tracks,
        listens,
      };
    },

    /** Ouvre la liaison : renvoie un code à saisir sur l'autre appareil. */
    async startLink(): Promise<void> {
      const friends = useFriendsStore();
      const share = useShareStore();
      this.error = null;
      this.linkBusy = true;
      this.linkCode = null;
      try {
        const me = await friends.ensureProfile();
        if (!this.saved) {
          this.saved = { key: newSyncKey(), lastSync: 0 };
          this.persist();
        }
        const payload: LinkPayload = {
          format: LINK_FORMAT,
          key: this.saved.key,
          from: share.deviceName || "un autre appareil",
          proches: {
            me,
            enabled: friends.enabled,
            shareListening: friends.shareListening,
            friends: friends.friends,
            outgoing: friends.outgoing,
            incoming: friends.incoming,
          },
          mots: { conversations: friends.conversations },
        };
        this.linkCode = await share.sendRemoteItem({ kind: "backup", id: JSON.stringify(payload) }, "Liaison entre appareils");
        if (!this.linkCode) throw new Error("Impossible de créer le code : vérifiez la connexion.");
        void this.run();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.linkBusy = false;
      }
    },
    /** Cet appareil rejoint les autres : le code vient de l'appareil déjà lié. */
    async receiveLink(code: string): Promise<void> {
      const share = useShareStore();
      this.error = null;
      this.linkBusy = true;
      this.awaitingLink = true;
      try {
        const t = await share.receiveRemote(code);
        if (t.progress.stage === "erreur") this.error = t.progress.message ?? "Liaison impossible.";
      } finally {
        this.awaitingLink = false;
        this.linkBusy = false;
      }
    },
    /** Lien reçu (par le partage). Rien n'est appliqué sans confirmation. */
    onLink(link: LinkPayload): boolean {
      if (!this.awaitingLink) return false;
      this.pendingLink = link;
      return true;
    },
    /** Confirmation : même identité que les autres appareils, puis première synchronisation. */
    confirmLink() {
      const link = this.pendingLink;
      if (!link) return;
      this.pendingLink = null;
      useFriendsStore().adopt(link.proches, { conversations: link.mots?.conversations, unread: {} });
      this.saved = { key: link.key, lastSync: 0 };
      this.persist();
      store(BASE_KEY, null);
      dirty = true;
      void this.run();
    },
    cancelLink() {
      this.pendingLink = null;
    },
    /** Cet appareil quitte le groupe : il oublie la clé, le profil Proches et ses conversations. */
    unlink() {
      useFriendsStore().forget();
      this.saved = null;
      this.persist();
      store(BASE_KEY, null);
      this.held = null;
      this.error = null;
      lastVersion = null;
    },

    /** Efface le profil, les proches et l'état commun du relais, puis de cet appareil. */
    async eraseEverything(): Promise<boolean> {
      this.error = null;
      try {
        await useFriendsStore().erase();
        this.unlink();
        return true;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return false;
      }
    },

    /** Mise à jour depuis le compte (0.5.13) : mêmes appareils, sans mot de passe. La clé du
     *  compte, identique sur tous ses appareils, devient la clé de synchronisation : ils restent
     *  reliés sans rien refaire. La sauvegarde en ligne est fusionnée une fois, puis effacée. */
    async migrateAccount() {
      const old = load<{ code: string; keys: { cle: string; key: string } }>(OLD_ACCOUNT_KEY);
      const friends = useFriendsStore();
      if (!old || !friends.base) return;
      try {
        const first = await relay.downloadChunk(friends.base, old.code, old.keys.cle, 0);
        const parts = [first.data];
        for (let n = 1; n < first.total; n++) parts.push((await relay.downloadChunk(friends.base, old.code, old.keys.cle, n)).data);
        const backup = JSON.parse(await decrypt(old.keys.key, parts.join(""))) as Partial<SyncDoc> & { prefs?: Record<string, string> };
        if (!friends.me && backup.prefs?.["mp:proches"]) {
          friends.adopt(JSON.parse(backup.prefs["mp:proches"]), backup.prefs["mp:proches-mots"] ? JSON.parse(backup.prefs["mp:proches-mots"]) : undefined);
        }
        inherited = { ...emptyDoc(), playlists: backup.playlists ?? [], favorites: backup.favorites ?? [], listens: backup.listens ?? [] };
      } catch (e) {
        // Hors ligne : à la prochaine ouverture. Sinon (sauvegarde déjà effacée par un autre
        // appareil, ou illisible) : il n'y a plus rien à reprendre.
        if (e instanceof RelayError && e.status === 0) return;
      }
      if (friends.me?.code !== old.code) {
        inherited = null;
        store(OLD_ACCOUNT_KEY, null);
        return;
      }
      this.saved = this.saved ?? { key: old.keys.key, lastSync: 0 };
      this.persist();
      // Sauvegarde reprise : l'ancien compte reste noté tant qu'elle n'est pas fusionnée.
      if (!inherited) store(OLD_ACCOUNT_KEY, null);
    },

    async apply(plan: SyncPlan) {
      const playlists = usePlaylistsStore();
      const favorites = useFavoritesStore();
      applying = true;
      try {
        for (const p of plan.createPlaylists) {
          const id = await playlists.create(p.name, p.theme);
          if (!id) continue;
          if (p.style) await playlists.setStyle(id, p.style);
          if (p.ids.length) await playlists.addTracks(id, p.ids);
        }
        for (const id of plan.deletePlaylists) await playlists.remove(id);
        for (const a of plan.addTracks) await playlists.addTracks(a.id, a.ids);
        for (const r of plan.removeTracks) await playlists.removeTracks(r.id, r.ids);
        for (const s of plan.restyle) {
          await playlists.setTheme(s.id, s.theme);
          await playlists.setStyle(s.id, s.style);
        }
        if (plan.addFavorites.length) {
          await api.addFavorites(plan.addFavorites);
          favorites.setFromInitialState(await api.listFavorites());
        }
        for (const id of plan.removeFavorites) if (favorites.isFavorite(id)) await favorites.toggle(id);
        if (plan.listens.length) {
          await api.importListens(plan.listens);
          void useListeningStore().load();
        }
      } finally {
        applying = false;
      }
    },

    /** Un tour : fusion avec l'état du relais, changements appliqués ici, nouvel état publié.
     *  `decision` : réponse à une suppression massive (« appliquer » ou « tout garder »). */
    async run(decision?: "appliquer" | "garder"): Promise<boolean> {
      const id = this.identity();
      const library = useLibraryStore();
      // Bibliothèque pas encore lue : tout semblerait absent.
      if (!id || this.running || library.scanning || !library.tracks.length) return false;
      this.running = true;
      this.error = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const remote = await downloadDoc(id);
          const base: SyncBase = decision === "garder" ? EMPTY_BASE : (load<SyncBase>(BASE_KEY) ?? EMPTY_BASE);
          const local = localDoc(base, this.device(await api.getListens()));
          let start = remote?.doc ?? emptyDoc();
          if (inherited) start = mergeDocs(EMPTY_BASE, start, inherited);
          const merged = mergeDocs(base, local, start);
          const plan = planApply(merged, this.device(local.listens));
          if (!decision && suspicious(plan, this.device(local.listens))) {
            this.held = deletions(plan);
            return false;
          }
          this.held = null;
          await this.apply(plan);
          if (!remote || !sameDoc(merged, remote.doc)) {
            try {
              await uploadDoc(id, merged, remote?.version ?? null);
            } catch (e) {
              // Un autre appareil a publié pendant ce temps : on recommence avec son état.
              if (e instanceof RelayError && e.status === 409) continue;
              throw e;
            }
          }
          store(BASE_KEY, asBase(merged));
          lastVersion = (await relay.syncState(id.base, id.code, id.secret)).version;
          dirty = false;
          this.saved = { ...this.saved!, lastSync: Date.now() };
          this.persist();
          // Ancienne sauvegarde du compte fusionnée et publiée : on peut l'effacer du relais.
          if (inherited) {
            inherited = null;
            store(OLD_ACCOUNT_KEY, null);
            void relay.forgetAccount(id.base, id.code, id.secret).catch(() => {});
          }
          return true;
        }
        return false;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return false;
      } finally {
        this.running = false;
      }
    },

    /** Vérification légère : le relais n'est relu que si quelque chose a changé. */
    async check() {
      const id = this.identity();
      if (!id || this.held !== null) return;
      if (dirty) {
        await this.run();
        return;
      }
      try {
        const { version } = await relay.syncState(id.base, id.code, id.secret);
        if (version !== lastVersion) await this.run();
      } catch {
        // hors ligne : au prochain tour
      }
    },
    /** Changement sur cet appareil : publié quelques secondes plus tard. */
    localChange() {
      if (applying || !this.saved) return;
      dirty = true;
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => void this.check(), AFTER_CHANGE);
    },
    async start() {
      await this.migrateAccount();
      if (timer) return;
      timer = setInterval(() => void this.check(), CHECK_EVERY);
      void this.check();
    },
  },
});
