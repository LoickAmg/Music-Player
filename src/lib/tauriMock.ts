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

// Démonstration : une intro, un pont instrumental, et une ligne minutée mot par mot (LRC enrichi).
const DEMO_LYRICS: Lyrics = {
  synced: [
    ...[
      [6000, "Sous les néons de la ville"],
      [9500, "Je compte les heures qui filent"],
      [13000, "Et la nuit me répond"],
      [16500, "Par des échos sans nom"],
      [30000, "Minuit passé, je reste là"],
      [33500, "À écouter battre le monde"],
      [37000, "Encore une fois"],
    ].map(([time_ms, text]) => ({ time_ms: time_ms as number, text: text as string })),
    {
      time_ms: 40500,
      text: "Encore une fois",
      words: [
        { time_ms: 40500, text: "En" },
        { time_ms: 40900, text: "core " },
        { time_ms: 41600, text: "une " },
        { time_ms: 42300, text: "fois" },
      ],
    },
  ],
  plain: null,
  instrumental: false,
  source: "démonstration",
};

export function installTauriMock() {
  const library: Track[] = [
    ...Array.from({ length: 60 }, (_, i) => makeTrack(i)),
    // Fichiers abîmés, pour la rubrique « Fichiers illisibles » des Réglages.
    ...["02 - Laisse-moi tranquille", "07 - Schéma"].map((title, i) =>
      makeTrack(100 + i, {
        title,
        artist: "Artiste inconnu",
        album: "Album inconnu",
        path: `/musique/demo/Damso - J'ai Menti/${title}.flac`,
        duration_secs: 0,
        damage: "Début du fichier vide : téléchargement inachevé ?",
      }),
    ),
  ];

  let queue: QueueView = { track_ids: [], position: null, shuffle: false, repeat: "off" };
  let volume = 1;
  let isPaused = true;
  let positionSecs = 0;
  let eqGains: [number, number, number] = [0, 0, 0];
  const dismissedLyrics = new Set<string>();
  // Personnalisation : réglages et fichiers importés (adresses blob) le temps de la session.
  let appearance: unknown = null;
  const assets = new Map<string, string>();
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

  const handlers: Record<string, (args: any, options?: unknown) => unknown> = {
    pick_library_folder: () => "/musique/demo",
    scan_library: () => library,
    get_library: () => library,
    get_cover: ({ trackId }) => demoCover(Number(String(trackId).replace("mock-", "")) || 0),
    get_lyrics: ({ trackId }) => (dismissedLyrics.has(trackId) ? null : DEMO_LYRICS),
    lyrics_query: ({ trackId }) => {
      const t = library.find((x) => x.id === trackId);
      return t ? `${t.artist} ${t.title}` : "";
    },
    search_lyrics: ({ query }) =>
      String(query).trim()
        ? [1, 2, 3].map((n) => ({
            id: n,
            title: n === 1 ? String(query) : `${query} (version ${n})`,
            artist: "Artiste démo",
            album: n === 2 ? null : "Album démo",
            duration: 200 + n * 7,
            synced: n !== 3,
            instrumental: false,
            preview: "Première ligne des paroles / deuxième ligne",
          }))
        : [],
    choose_lyrics: ({ trackId }) => {
      dismissedLyrics.delete(trackId);
      return DEMO_LYRICS;
    },
    dismiss_lyrics: ({ trackId }) => {
      dismissedLyrics.add(trackId);
    },

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
    queue_play_next: ({ trackIds }) => {
      const current = currentTrack()?.id ?? null;
      const ids = (trackIds as string[]).filter((id) => id !== current);
      if (!current) {
        queue = { ...queue, track_ids: ids, position: 0 };
        startTrack(ids[0] ?? null);
        return currentTrack();
      }
      const rest = queue.track_ids.filter((id) => !ids.includes(id) || id === current);
      const at = rest.indexOf(current) + 1;
      queue = { ...queue, track_ids: [...rest.slice(0, at), ...ids, ...rest.slice(at)], position: at - 1 };
      return null;
    },
    queue_append: ({ trackIds }) => {
      const current = currentTrack()?.id ?? null;
      const ids = (trackIds as string[]).filter((id) => id !== current);
      const rest = queue.track_ids.filter((id) => !ids.includes(id) || id === current);
      queue = { ...queue, track_ids: [...rest, ...ids], position: current ? rest.indexOf(current) : rest.length };
      if (!current) {
        startTrack(ids[0] ?? null);
        return currentTrack();
      }
      return null;
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
    set_playlist_style: ({ id, style }) => {
      const pl = playlists.find((p) => p.id === id);
      if (pl) pl.style = style;
    },
    set_appearance: ({ value }) => {
      appearance = value;
    },
    sync_app_icon: () => null,
    save_image: ({ name }) => `C:/Users/Moi/Pictures/Music Player/${name}`,
    // Trois mois d'écoutes inventées (soirées surtout), pour voir la rétrospective.
    get_listens: () => {
      const out = [];
      const now = Date.now();
      let seed = 7;
      const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
      for (let day = 0; day < 95; day++) {
        const count = Math.floor(rnd() * 14);
        for (let k = 0; k < count; k++) {
          const t = library[Math.floor(Math.pow(rnd(), 2.2) * 40)];
          const hour = rnd() < 0.55 ? 20 + Math.floor(rnd() * 5) : 8 + Math.floor(rnd() * 11);
          const started = new Date(now - day * 86_400_000);
          started.setHours(hour % 24, Math.floor(rnd() * 60));
          out.push({ track_id: t.id, title: t.title, artist: t.artist, album: t.album, genre: t.genre, started: Math.floor(started.getTime() / 1000), secs: rnd() < 0.15 ? 15 : t.duration_secs * (0.6 + rnd() * 0.4), duration_secs: t.duration_secs });
        }
      }
      return out.sort((a, b) => a.started - b.started);
    },
    import_asset: (body, options) => {
      // Ordinateur : octets bruts et en-têtes ; Android : { kind, ext, data } en base64.
      const headers = (options as { headers?: Record<string, string> } | undefined)?.headers;
      const json = headers ? null : (body as { kind: string; ext: string; data: string });
      const kind = headers?.["x-kind"] ?? json?.kind;
      const ext = headers?.["x-ext"] ?? json?.ext;
      const bytes = json ? Uint8Array.from(atob(json.data), (c) => c.charCodeAt(0)) : (body as Uint8Array);
      const name = `${kind}-${assets.size + 1}.${ext}`;
      assets.set(name, URL.createObjectURL(new Blob([bytes as BlobPart])));
      return name;
    },
    delete_asset: ({ name }) => {
      assets.delete(name);
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
      appearance,
      custom_dir: "/custom",
    }),
    save_session: () => undefined,
  };

  (window as any).__TAURI_INTERNALS__ = {
    // Fichiers importés pendant la session : servis par leur adresse blob.
    convertFileSrc: (path: string) => assets.get(path.split("/").pop() ?? "") ?? path,
    invoke: async (cmd: string, args: any = {}, options?: unknown) => {
      const handler = handlers[cmd];
      if (!handler) {
        console.warn(`[tauriMock] commande non simulée : ${cmd}`);
        return null;
      }
      const result = handler(args, options);
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
