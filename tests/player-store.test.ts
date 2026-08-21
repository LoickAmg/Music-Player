import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { usePlayerStore } from "@/stores/player";
import { api } from "@/lib/api";
import type { Track } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  api: {
    playQueue: vi.fn(),
    playTrackNow: vi.fn(),
    togglePlayPause: vi.fn(),
    nextTrack: vi.fn(),
    previousTrack: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setShuffle: vi.fn(),
    setRepeat: vi.fn(),
    removeFromQueue: vi.fn(),
    getQueue: vi.fn(),
    getPlaybackStatus: vi.fn(),
    pollAutoAdvance: vi.fn(),
  },
}));

function track(id: string): Track {
  return {
    id,
    path: `/musique/${id}.mp3`,
    title: id,
    artist: "Artiste",
    album: "Album",
    track_no: 1,
    duration_secs: 200,
    has_cover: false,
  };
}

describe("player store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.getQueue).mockResolvedValue({ track_ids: [], position: null, shuffle: false, repeat: "off" });
  });

  it("playQueue met à jour la piste courante et réinitialise la position", async () => {
    const store = usePlayerStore();
    vi.mocked(api.playQueue).mockResolvedValueOnce(track("a"));
    vi.mocked(api.getQueue).mockResolvedValueOnce({
      track_ids: ["a", "b"],
      position: 0,
      shuffle: false,
      repeat: "off",
    });

    await store.playQueue(["a", "b"]);

    expect(store.currentTrack?.id).toBe("a");
    expect(store.positionSecs).toBe(0);
    expect(store.isPaused).toBe(false);
    expect(store.queueIds).toEqual(["a", "b"]);
  });

  it("togglePlayPause propage l'erreur si aucune piste n'est chargée", async () => {
    const store = usePlayerStore();
    vi.mocked(api.togglePlayPause).mockRejectedValueOnce(new Error("Aucune piste chargée."));

    await store.togglePlayPause();
    expect(store.error).toContain("Aucune piste chargée");
  });

  it("pollTick avance automatiquement à la piste suivante quand la précédente est finie", async () => {
    const store = usePlayerStore();
    vi.mocked(api.pollAutoAdvance).mockResolvedValueOnce(track("b"));
    vi.mocked(api.getQueue).mockResolvedValueOnce({
      track_ids: ["a", "b"],
      position: 1,
      shuffle: false,
      repeat: "off",
    });

    await store.pollTick();

    expect(store.currentTrack?.id).toBe("b");
    expect(store.positionSecs).toBe(0);
    expect(api.getPlaybackStatus).not.toHaveBeenCalled();
  });

  it("pollTick se contente de rafraîchir le statut quand rien n'a changé", async () => {
    const store = usePlayerStore();
    vi.mocked(api.pollAutoAdvance).mockResolvedValueOnce(null);
    vi.mocked(api.getPlaybackStatus).mockResolvedValueOnce({
      current_track: track("a"),
      position_secs: 42,
      is_paused: false,
      volume: 0.8,
    });

    await store.pollTick();

    expect(store.positionSecs).toBe(42);
    expect(store.volume).toBe(0.8);
  });

  it("seek met à jour positionSecs de façon optimiste après confirmation de l'appel", async () => {
    const store = usePlayerStore();
    vi.mocked(api.seek).mockResolvedValueOnce(undefined);
    await store.seek(75);
    expect(store.positionSecs).toBe(75);
    expect(api.seek).toHaveBeenCalledWith(75);
  });

  it("setShuffle répercute l'état et rafraîchit la file", async () => {
    const store = usePlayerStore();
    vi.mocked(api.setShuffle).mockResolvedValueOnce(undefined);
    vi.mocked(api.getQueue).mockResolvedValueOnce({
      track_ids: ["b", "a"],
      position: 0,
      shuffle: true,
      repeat: "off",
    });

    await store.setShuffle(true);

    expect(store.shuffle).toBe(true);
    expect(store.queueIds).toEqual(["b", "a"]);
  });
});
