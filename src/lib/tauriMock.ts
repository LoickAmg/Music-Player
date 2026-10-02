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

import type { InitialState, Lyrics, Playlist, PlaybackStatus, QueueView, RepeatMode, Track } from "./types";

const DEMO_ALBUMS = [
  { album: "Nuit Blanche", artist: "Les Ondes", year: 2021, colors: ["#1b1f4a", "#6a3cff", "#ff4fa3"] },
  { album: "Horizon", artist: "Camille R.", year: 2019, colors: ["#ffb347", "#ff5e3a", "#6b1d3a"] },
  { album: "Petites Machines", artist: "Studio Sud", year: 2023, colors: ["#0f3d3e", "#23c9a8", "#e8ffcf"] },
  { album: "Chambre 12", artist: "Aurore Vasseur", year: 2018, colors: ["#2a0f12", "#c0283a", "#f2c6b4"] },
  { album: "Lumière d'hiver", artist: "Les Ondes", year: 2024, colors: ["#dfe9f5", "#7fa8d9", "#1f3552"] },
  { album: "Grand Large", artist: "Nils & Iris", year: 2022, colors: ["#04263f", "#0f7fb8", "#f5d76e"] },
];

/** Pochette de démonstration : un petit SVG coloré propre à chaque album. */
function demoCover(i: number): string {
  const [a, b, c] = DEMO_ALBUMS[i % DEMO_ALBUMS.length].colors;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="68" cy="36" r="22" fill="${c}"/><rect x="10" y="70" width="80" height="6" fill="${c}" opacity=".7"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
const DEMO_TITLES = [
  "Ouverture", "Rivière", "Minuit passé", "Les néons", "Ce qu'il reste", "Aube", "Sable", "Tempête douce",
  "Vertige", "Lettre ouverte", "Boulevard", "Encore une fois",
];

function makeTrack(i: number, overrides: Partial<Track> = {}): Track {
  const a = DEMO_ALBUMS[i % DEMO_ALBUMS.length];
  return {
    id: `mock-${i}`,
    path: `/musique/demo/track-${i}.mp3`,
    title: DEMO_TITLES[Math.floor(i / DEMO_ALBUMS.length) % DEMO_TITLES.length],
    artist: a.artist,
    album: a.album,
    album_artist: a.artist,
    track_no: Math.floor(i / DEMO_ALBUMS.length) + 1,
    disc_no: 1,
    year: a.year,
    genre: "Pop",
    duration_secs: 150 + ((i * 37) % 120),
    has_cover: i % 7 !== 6,
    added_secs: 1_700_000_000 + i * 3600,
    ...overrides,
  };
}

const DEMO_LYRICS: Lyrics = {
  synced: [
    "Sous les néons de la ville", "Je compte les heures qui filent", "", "Et la nuit me répond",
    "Par des échos sans nom", "Minuit passé, je reste là", "À écouter battre le monde", "", "Encore une fois",
    "Encore une fois",
  ].map((text, i) => ({ time_ms: 2000 + i * 3500, text })),
  plain: null,
  instrumental: false,
  source: "démonstration",
};

export function installTauriMock() {
  const library: Track[] = Array.from({ length: 60 }, (_, i) => makeTrack(i));

  let queue: QueueView = { track_ids: [], position: null, shuffle: false, repeat: "off" };
  let volume = 1;
  let isPaused = true;
  let positionSecs = 0;
  let eqGains: [number, number, number] = [0, 0, 0];
  const playlists: Playlist[] = [
    { id: "pl-1", name: "Favoris", track_ids: [library[0].id, library[3].id, library[7].id], theme: "sunset" },
    { id: "pl-2", name: "Soirée d'été entre amis", track_ids: [library[1].id], theme: "midnight" },
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
    get_cover: ({ trackId }) => demoCover(Number(String(trackId).replace("mock-", "")) || 0),
    get_lyrics: () => DEMO_LYRICS,

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
    create_playlist: ({ name, theme }) => {
      const id = `pl-${playlists.length + 1}`;
      playlists.push({ id, name, track_ids: [], theme: theme ?? "aurora" });
      return id;
    },
    set_playlist_theme: ({ id, theme }) => {
      const pl = playlists.find((p) => p.id === id);
      if (pl) pl.theme = theme;
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
    add_tracks_to_playlist: ({ playlistId, trackIds }) => {
      const pl = playlists.find((p) => p.id === playlistId);
      if (!pl) throw new Error("Playlist introuvable.");
      const before = pl.track_ids.length;
      for (const id of trackIds as string[]) if (!pl.track_ids.includes(id)) pl.track_ids.push(id);
      return pl.track_ids.length - before;
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
      scanning: false,
    }),
    save_session: () => undefined,
  };

  (window as any).__TAURI_INTERNALS__ = {
    convertFileSrc: (path: string) => path,
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

  (window as unknown as { __MP_DEMO__?: boolean }).__MP_DEMO__ = true;
  console.info("[tauriMock] Mode démo activé (hors webview Tauri) : données et lecture simulées.");
}
