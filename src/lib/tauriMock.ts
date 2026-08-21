// Mock de `window.__TAURI_INTERNALS__.invoke`, chargé UNIQUEMENT par
// `main.ts` quand on tourne en `vite dev` hors du webview Tauri (donc
// jamais dans le vrai build de l'app). Sert à faire de la QA visuelle du
// frontend dans un Chrome classique (Playwright) sans avoir besoin d'un
// périphérique audio ni de vrais fichiers musicaux : la lecture est
// simulée par un minuteur qui avance `position_secs`, sans son réel.
//
// Volontairement séparé, importé dynamiquement (`import.meta.env.DEV`
// statiquement faux en prod ⇒ tree-shaké par Rollup) pour ne jamais
// atterrir dans le bundle livré à l'utilisateur.

import type { InitialState, Playlist, PlaybackStatus, QueueView, RepeatMode, Track } from "./types";

function makeTrack(i: number, overrides: Partial<Track> = {}): Track {
  const albums = ["Nuit Blanche", "Horizon", "Petites Machines", "Chambre 12"];
  const artists = ["Les Ondes", "Camille R.", "Studio Sud", "Aurore Vasseur"];
  return {
    id: `mock-${i}`,
    path: `/musique/demo/track-${i}.mp3`,
    title: `Piste ${i}`,
    artist: artists[i % artists.length],
    album: albums[i % albums.length],
    track_no: (i % 12) + 1,
    duration_secs: 150 + ((i * 37) % 120),
    has_cover: i % 3 !== 0,
    ...overrides,
  };
}

export function installTauriMock() {
  const library: Track[] = Array.from({ length: 18 }, (_, i) => makeTrack(i + 1));

  let queue: QueueView = { track_ids: [], position: null, shuffle: false, repeat: "off" };
  let volume = 1;
  let isPaused = true;
  let positionSecs = 0;
  let eqGains: [number, number, number] = [0, 0, 0];
  const playlists: Playlist[] = [
    { id: "pl-1", name: "Favoris", track_ids: [library[0].id, library[3].id, library[7].id] },
  ];

  let ticker: ReturnType<typeof setInterval> | null = null;
  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (isPaused) return;
      const current = currentTrack();
      if (!current) return;
      positionSecs += 1;
      if (positionSecs >= current.duration_secs) {
        positionSecs = 0;
      }
    }, 1000);
  }

  function currentTrack(): Track | null {
    if (queue.position === null) return null;
    const id = queue.track_ids[queue.position];
    return library.find((t) => t.id === id) ?? null;
  }

  function startTrack(id: string | null) {
    positionSecs = 0;
    isPaused = id === null;
    if (id === null) return;
    ensureTicker();
  }

  const handlers: Record<string, (args: any) => unknown> = {
    pick_library_folder: () => "/musique/demo",
    scan_library: () => library,
    get_library: () => library,
    get_cover: () => null,

    play_queue: ({ trackIds, startId }) => {
      queue = { ...queue, track_ids: trackIds, position: trackIds.length ? 0 : null };
      const start = startId ?? trackIds[0] ?? null;
      if (start) queue.position = trackIds.indexOf(start);
      startTrack(currentTrack()?.id ?? null);
      return currentTrack();
    },
    play_track_now: ({ trackId }) => {
      const idx = queue.track_ids.indexOf(trackId);
      if (idx === -1) {
        queue = { ...queue, track_ids: [trackId], position: 0 };
      } else {
        queue = { ...queue, position: idx };
      }
      startTrack(trackId);
      return currentTrack();
    },
    toggle_play_pause: () => {
      if (!currentTrack()) throw new Error("Aucune piste chargée.");
      isPaused = !isPaused;
      if (!isPaused) ensureTicker();
      return isPaused;
    },
    next_track: () => {
      if (queue.position === null || queue.position + 1 >= queue.track_ids.length) {
        if (queue.repeat === "all" && queue.track_ids.length) {
          queue.position = 0;
        } else {
          queue.position = null;
          startTrack(null);
          return null;
        }
      } else {
        queue.position += 1;
      }
      startTrack(currentTrack()?.id ?? null);
      return currentTrack();
    },
    previous_track: () => {
      if (queue.position === null) return null;
      queue.position = Math.max(0, queue.position - 1);
      startTrack(currentTrack()?.id ?? null);
      return currentTrack();
    },
    seek: ({ positionSecs: p }) => {
      positionSecs = p;
    },
    set_volume: ({ volume: v }) => {
      volume = v;
    },
    set_shuffle: ({ on }) => {
      queue = { ...queue, shuffle: on };
    },
    set_repeat: ({ mode }) => {
      queue = { ...queue, repeat: mode as RepeatMode };
    },
    remove_from_queue: ({ index }) => {
      queue.track_ids.splice(index, 1);
    },
    get_queue: () => queue,
    get_playback_status: (): PlaybackStatus => ({
      current_track: currentTrack(),
      position_secs: positionSecs,
      is_paused: isPaused,
      volume,
    }),
    poll_auto_advance: () => null,

    list_playlists: () => playlists,
    create_playlist: ({ name }) => {
      const id = `pl-${playlists.length + 1}`;
      playlists.push({ id, name, track_ids: [] });
      return id;
    },
    delete_playlist: ({ id }) => {
      const idx = playlists.findIndex((p) => p.id === id);
      if (idx !== -1) playlists.splice(idx, 1);
    },
    rename_playlist: ({ id, name }) => {
      const pl = playlists.find((p) => p.id === id);
      if (pl) pl.name = name;
    },
    add_to_playlist: ({ playlistId, trackId }) => {
      const pl = playlists.find((p) => p.id === playlistId);
      if (pl && !pl.track_ids.includes(trackId)) pl.track_ids.push(trackId);
    },
    remove_from_playlist: ({ playlistId, trackId }) => {
      const pl = playlists.find((p) => p.id === playlistId);
      if (pl) pl.track_ids = pl.track_ids.filter((t) => t !== trackId);
    },
    move_track_in_playlist: ({ playlistId, from, to }) => {
      const pl = playlists.find((p) => p.id === playlistId);
      if (pl) {
        const [t] = pl.track_ids.splice(from, 1);
        pl.track_ids.splice(to, 0, t);
      }
    },

    set_eq_gains: ({ gains }) => {
      eqGains = gains;
    },
    get_eq_gains: () => eqGains,

    get_initial_state: (): InitialState => ({
      library_root: "/musique/demo",
      library,
      queue,
      current_track: currentTrack(),
      position_secs: positionSecs,
      volume,
      eq_gains: eqGains,
      playlists,
    }),
    save_session: () => undefined,
  };

  (window as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: any = {}) => {
      const handler = handlers[cmd];
      if (!handler) {
        console.warn(`[tauriMock] commande non simulée : ${cmd}`);
        return null;
      }
      const result = handler(args);
      // Le vrai pont Tauri sérialise chaque retour en JSON (IPC) : le
      // frontend ne reçoit donc jamais la même référence d'objet deux fois
      // de suite. On reproduit ça ici pour éviter des bugs de réactivité
      // Pinia (assignation d'une référence inchangée = pas de déclenchement)
      // qui n'existeraient pas dans la vraie app.
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    },
  };

  console.info("[tauriMock] Mode démo activé (hors webview Tauri) : données et lecture simulées.");
}
