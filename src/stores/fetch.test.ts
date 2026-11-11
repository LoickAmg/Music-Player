import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import type { FetchJob, FetchJobUpdate } from "@/lib/types";

type Handlers = { queue: (jobs: FetchJob[]) => void; job: (u: FetchJobUpdate) => void; error: (m: string) => void };
let handlers: Handlers | null = null;
const off = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    fetchAvailability: vi.fn(async () => ({ spotdl: true, ytdlp: false })),
    fetchJobs: vi.fn(),
    fetchEnqueue: vi.fn(),
    fetchCancel: vi.fn(),
    fetchClearFinished: vi.fn(),
  },
  onFetchEvents: vi.fn(async (h: Handlers) => {
    handlers = h;
    return off;
  }),
}));

import { api } from "@/lib/api";
import { useFetchStore } from "@/stores/fetch";

function job(id: string, state: FetchJob["state"] = "queued"): FetchJob {
  return { id, wanted: { title: "Titre", artist: "Artiste" }, state, attempts: 0, last_error: null };
}

beforeEach(() => {
  setActivePinia(createPinia());
  handlers = null;
  vi.clearAllMocks();
});

describe("store de téléchargements", () => {
  it("charge l'état initial après s'être abonné", async () => {
    vi.mocked(api.fetchJobs).mockResolvedValue([job("a")]);
    const store = useFetchStore();
    await store.initialize();
    expect(handlers).not.toBeNull();
    expect(store.jobs.map((j) => j.id)).toEqual(["a"]);
    expect(store.availability.spotdl).toBe(true);
    expect(store.anyTool).toBe(true);
  });

  it("garde une file reçue pendant le chargement plutôt que l'instantané plus ancien", async () => {
    let resolve!: (jobs: FetchJob[]) => void;
    vi.mocked(api.fetchJobs).mockReturnValue(new Promise((r) => (resolve = r)));
    const store = useFetchStore();
    const done = store.initialize();
    await vi.waitFor(() => expect(handlers).not.toBeNull());
    handlers!.queue([job("a", "running")]);
    resolve([job("a", "queued")]);
    await done;
    expect(store.jobs[0].state).toBe("running");
  });

  it("applique les mises à jour de tâche et sépare actives et terminées", async () => {
    vi.mocked(api.fetchJobs).mockResolvedValue([job("a", "running"), job("b")]);
    const store = useFetchStore();
    await store.initialize();
    handlers!.job({ id: "a", state: "failed", error: "Introuvable" });
    expect(store.jobs[0].last_error).toBe("Introuvable");
    expect(store.active.map((j) => j.id)).toEqual(["b"]);
    expect(store.finished.map((j) => j.id)).toEqual(["a"]);
  });

  it("montre l'erreur du backend sans faire échouer l'appelant", async () => {
    vi.mocked(api.fetchCancel).mockRejectedValue("Cette tâche ne peut plus être annulée.");
    const store = useFetchStore();
    await store.cancel("a");
    expect(store.lastError).toBe("Cette tâche ne peut plus être annulée.");
  });

  it("n'appelle pas le backend pour une liste vide et se désabonne à la fin", async () => {
    vi.mocked(api.fetchJobs).mockResolvedValue([]);
    const store = useFetchStore();
    await store.initialize();
    expect(await store.enqueue([])).toEqual([]);
    expect(api.fetchEnqueue).not.toHaveBeenCalled();
    store.dispose();
    expect(off).toHaveBeenCalled();
  });
});
