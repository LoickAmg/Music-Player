import { defineStore } from "pinia";
import { type AccountKeys, deriveKeys, downloadBackup, uploadBackup } from "@/lib/account";
import { currentBackupJson } from "@/lib/backupNow";
import { mergeBackups, parseBackup } from "@/lib/backup";
import { relay, RelayError } from "@/lib/friendsApi";
import { useFriendsStore } from "./friends";

// Compte Music Player : code d'ami des Proches + mot de passe ; sauvegarde chiffrée en ligne,
// mise à jour une fois par jour, récupérable sur un autre appareil.

const KEY = "mp:compte";
const DAY = 24 * 60 * 60 * 1000;

interface Saved {
  code: string;
  keys: AccountKeys;
  lastUpload: number;
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

export const useAccountStore = defineStore("account", {
  state: () => ({
    saved: load(),
    busy: false,
    error: null as string | null,
  }),
  getters: {
    connected: (state) => !!state.saved,
  },
  actions: {
    persist() {
      try {
        if (this.saved) localStorage.setItem(KEY, JSON.stringify(this.saved));
        else localStorage.removeItem(KEY);
      } catch {
        // stockage indisponible : compte valable pour la session
      }
    },
    async run(task: () => Promise<void>): Promise<boolean> {
      this.busy = true;
      this.error = null;
      try {
        await task();
        return true;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return false;
      } finally {
        this.busy = false;
      }
    },
    /** Crée le compte (ou change le mot de passe) puis envoie une première sauvegarde. */
    async create(password: string): Promise<boolean> {
      const friends = useFriendsStore();
      return this.run(async () => {
        if (!friends.enabled) await friends.enable();
        if (!friends.me || !friends.base) throw new Error(friends.error ?? "Profil indisponible.");
        const keys = await deriveKeys(friends.me.code, password);
        await relay.account(friends.base, friends.me.code, friends.me.secret, keys.cle);
        this.saved = { code: friends.me.code, keys, lastUpload: 0 };
        this.persist();
        await this.upload();
      });
    },
    /** Envoie la sauvegarde de cet appareil, fusionnée avec celle déjà en ligne (déposée par
     *  un autre appareil du compte) : rien n'est perdu d'un appareil à l'autre. */
    async upload() {
      const friends = useFriendsStore();
      if (!this.saved || !friends.base) return;
      let json = await currentBackupJson();
      try {
        const online = await downloadBackup(friends.base, this.saved.code, this.saved.keys);
        json = JSON.stringify(mergeBackups(parseBackup(json), parseBackup(online.json)));
      } catch (e) {
        // Pas encore de sauvegarde en ligne : la première est celle-ci. Sinon (mot de passe
        // changé ailleurs, relais injoignable), on n'écrase rien.
        if (!(e instanceof RelayError && e.status === 404)) throw e;
      }
      await uploadBackup(friends.base, this.saved.code, this.saved.keys, json);
      this.saved = { ...this.saved, lastUpload: Date.now() };
      this.persist();
    },
    async uploadNow(): Promise<boolean> {
      return this.run(() => this.upload());
    },
    /** Appareil connecté au compte sans les Proches (connexion avec la 0.5.12) : identité
     *  reprise depuis la sauvegarde en ligne. */
    async adoptIfNeeded() {
      const friends = useFriendsStore();
      if (!this.saved || friends.enabled || !friends.base) return;
      try {
        const { json } = await downloadBackup(friends.base, this.saved.code, this.saved.keys);
        const prefs = (JSON.parse(json) as { prefs?: Record<string, string> }).prefs ?? {};
        if (prefs["mp:proches"]) {
          friends.adopt(JSON.parse(prefs["mp:proches"]), prefs["mp:proches-mots"] ? JSON.parse(prefs["mp:proches-mots"]) : undefined);
        }
      } catch {
        // hors ligne : au prochain lancement
      }
    },
    /** Sauvegarde automatique : une fois par jour, au lancement. */
    async autoUpload() {
      if (!this.saved || Date.now() - this.saved.lastUpload < DAY) return;
      try {
        await this.upload();
      } catch {
        // hors ligne : au prochain lancement
      }
    },
    /** Connexion sur un autre appareil : renvoie la sauvegarde en ligne (JSON) à restaurer. */
    async login(code: string, password: string): Promise<string | null> {
      const friends = useFriendsStore();
      let json: string | null = null;
      await this.run(async () => {
        if (!friends.base) throw new Error("Aucun relais configuré (Réglages → Partage).");
        const keys = await deriveKeys(code, password);
        const backup = await downloadBackup(friends.base, code, keys);
        json = backup.json;
        // Le compte, c'est aussi l'identité des Proches : reprise tout de suite (amis,
        // conversations), sans attendre la restauration du reste.
        try {
          const prefs = (JSON.parse(backup.json) as { prefs?: Record<string, string> }).prefs ?? {};
          if (prefs["mp:proches"]) {
            friends.adopt(JSON.parse(prefs["mp:proches"]), prefs["mp:proches-mots"] ? JSON.parse(prefs["mp:proches-mots"]) : undefined);
          }
        } catch {
          // sauvegarde sans Proches : rien à reprendre
        }
        this.saved = { code, keys, lastUpload: backup.at };
        this.persist();
      });
      return json;
    },
    logout() {
      this.saved = null;
      this.persist();
    },
  },
});
