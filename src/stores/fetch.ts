// File de téléchargements (spotDL puis yt-dlp) tenue par le backend. Le store n'en garde
// qu'un reflet : les événements de la file d'abord, l'état initial ensuite.

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, onFetchEvents } from "@/lib/api";
import type { FetchAvailability, FetchJob, FetchWanted } from "@/lib/types";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useFetchStore = defineStore("fetch", () => {
  const jobs = ref<FetchJob[]>([]);
  const availability = ref<FetchAvailability>({ spotdl: false, ytdlp: false });
  const initialized = ref(false);
  const loading = ref(false);
  const lastError = ref<string | null>(null);

  const active = computed(() => jobs.value.filter((job) => job.state === "queued" || job.state === "running"));
  const finished = computed(() => jobs.value.filter((job) => job.state !== "queued" && job.state !== "running"));
  const anyTool = computed(() => availability.value.spotdl || availability.value.ytdlp);

  let stop: (() => void) | null = null;
  let pending: Promise<void> | null = null;

  function initialize(): Promise<void> {
    if (initialized.value) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      loading.value = true;
      lastError.value = null;
      // Une file reçue pendant le chargement est plus récente que l'instantané demandé.
      let fresher = false;
      try {
        stop = await onFetchEvents({
          queue: (list) => {
            fresher = true;
            jobs.value = list;
          },
          job: (update) => {
            const job = jobs.value.find((item) => item.id === update.id);
            if (!job) return;
            job.state = update.state;
            job.last_error = update.error;
          },
          error: (text) => {
            lastError.value = text;
          },
        });
        const [tools, list] = await Promise.all([api.fetchAvailability(), api.fetchJobs()]);
        // Mode démo du navigateur : les commandes inconnues y renvoient null.
        availability.value = tools ?? { spotdl: false, ytdlp: false };
        if (!fresher) jobs.value = Array.isArray(list) ? list : [];
        initialized.value = true;
      } catch (error) {
        lastError.value = message(error);
        stop?.();
        stop = null;
      } finally {
        loading.value = false;
        pending = null;
      }
    })();
    return pending;
  }

  /** Relit les outils installés (après une installation, sans redémarrer la vue). */
  async function refreshAvailability(): Promise<void> {
    try {
      availability.value = (await api.fetchAvailability()) ?? { spotdl: false, ytdlp: false };
    } catch (error) {
      lastError.value = message(error);
    }
  }

  async function run<T>(action: () => Promise<T>, fallback: T): Promise<T> {
    lastError.value = null;
    try {
      return await action();
    } catch (error) {
      lastError.value = message(error);
      return fallback;
    }
  }

  const enqueue = async (wanted: FetchWanted[]) => (wanted.length ? ((await run(() => api.fetchEnqueue(wanted), [] as string[])) ?? []) : []);
  const cancel = (id: string) => run(() => api.fetchCancel(id), undefined);
  const clearFinished = async () => (await run(() => api.fetchClearFinished(), 0)) ?? 0;

  function dispose(): void {
    stop?.();
    stop = null;
    initialized.value = false;
  }

  return { jobs, availability, initialized, loading, lastError, active, finished, anyTool, initialize, refreshAvailability, enqueue, cancel, clearFinished, dispose };
});
