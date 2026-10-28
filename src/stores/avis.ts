import { defineStore } from "pinia";
import { type AvisItem, relay, relayBase } from "@/lib/friendsApi";
import { notify } from "@/lib/notify";
import { useShareStore } from "./share";

// Avis reçus (« Un avis ? ») : réservé à l'administrateur, reconnu par son code. L'appli
// ouverte vérifie toutes les 3 minutes et prévient par une notification du système.

const KEY = "mp:avis-admin";
const CHECK_EVERY = 3 * 60 * 1000;

export const AVIS_KINDS: Record<AvisItem["kind"], string> = {
  bug: "Un problème",
  suggestion: "Suggestion",
  idee: "Une idée",
  avis: "Mon avis",
  autre: "Autre",
};

interface Saved {
  code: string;
  /** Date du plus récent avis déjà signalé (ms). */
  notified: number;
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Android : la vérification continue appli fermée (tâche de fond, environ toutes les heures). */
function androidWatch(base: string | null, saved: Saved | null) {
  try {
    if (base && saved) window.AndroidAvis?.watch(base, saved.code, saved.notified);
    else window.AndroidAvis?.stop();
  } catch {
    // ancienne activité Android
  }
}

export const useAvisStore = defineStore("avis", {
  state: () => ({
    saved: load(),
    items: [] as AvisItem[],
    fresh: 0,
    loading: false,
    error: null as string | null,
    images: {} as Record<string, string>,
  }),
  getters: {
    isAdmin: (state) => !!state.saved,
    base(): string | null {
      const r = useShareStore().relayInUse;
      return r ? relayBase(r) : null;
    },
  },
  actions: {
    persist() {
      try {
        if (this.saved) localStorage.setItem(KEY, JSON.stringify(this.saved));
        else localStorage.removeItem(KEY);
      } catch {
        // stockage indisponible : accès valable pour la session
      }
    },
    /** Accès administrateur : le code est vérifié par le relais avant d'être gardé. */
    async login(code: string): Promise<boolean> {
      this.error = null;
      if (!this.base) {
        this.error = "Aucun relais configuré (Réglages → Partage).";
        return false;
      }
      try {
        const res = await relay.avisCount(this.base, code.trim());
        this.saved = { code: code.trim(), notified: res.dernier?.at ?? 0 };
        this.fresh = res.nouveaux;
        this.persist();
        this.start();
        return true;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return false;
      }
    },
    logout() {
      this.saved = null;
      this.items = [];
      this.persist();
      this.stop();
      androidWatch(null, null);
    },
    async load() {
      if (!this.saved || !this.base) return;
      this.loading = true;
      this.error = null;
      try {
        this.items = (await relay.avisList(this.base, this.saved.code)).avis;
        this.fresh = this.items.filter((a) => a.statut === "nouveau").length;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },
    async image(id: string, n: number): Promise<string | null> {
      const key = `${id}:${n}`;
      if (this.images[key]) return this.images[key];
      if (!this.saved || !this.base) return null;
      try {
        const { data } = await relay.avisImage(this.base, this.saved.code, id, n);
        this.images[key] = data;
        return data;
      } catch {
        return null;
      }
    },
    async setStatus(item: AvisItem, statut: AvisItem["statut"]) {
      if (!this.saved || !this.base) return;
      await relay.avisStatus(this.base, this.saved.code, item.id, statut);
      item.statut = statut;
      this.fresh = this.items.filter((a) => a.statut === "nouveau").length;
    },
    async remove(item: AvisItem) {
      if (!this.saved || !this.base) return;
      await relay.avisDelete(this.base, this.saved.code, item.id);
      this.items = this.items.filter((a) => a.id !== item.id);
      this.fresh = this.items.filter((a) => a.statut === "nouveau").length;
    },
    /** Nouveaux avis depuis la dernière vérification : notification du système. */
    async check() {
      if (!this.saved || !this.base) return;
      try {
        const { nouveaux, dernier } = await relay.avisCount(this.base, this.saved.code);
        this.fresh = nouveaux;
        if (dernier && dernier.at > this.saved.notified) {
          const text = dernier.message.length > 90 ? `${dernier.message.slice(0, 90)}…` : dernier.message;
          await notify(nouveaux > 1 ? `${nouveaux} nouveaux avis sur Music Player` : "Nouvel avis sur Music Player", `${AVIS_KINDS[dernier.kind]} — ${text}`);
          this.saved = { ...this.saved, notified: dernier.at };
          this.persist();
          androidWatch(this.base, this.saved);
        }
      } catch {
        // hors ligne : à la prochaine vérification
      }
    },
    start() {
      if (timer || !this.saved) return;
      androidWatch(this.base, this.saved);
      void this.check();
      timer = setInterval(() => void this.check(), CHECK_EVERY);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  },
});
