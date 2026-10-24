// Pont avec la notification de lecture Android (écran verrouillé, volet de notifications,
// casque Bluetooth). L'activité Android expose `window.AndroidMedia` ; ses commandes
// reviennent par `window.__mpMedia`. Sans effet ailleurs (ordinateur, navigateur).

import { watch } from "vue";
import { api } from "./api";
import type { usePlayerStore } from "@/stores/player";

interface AndroidMediaBridge {
  update(json: string): void;
  clear(): void;
  keepScreenOn(on: boolean): void;
  insets?(): string;
  takeOpenedFile?(): string;
}

interface AndroidUpdateBridge {
  download(url: string, version: string): void;
  openInBrowser(url: string): void;
  backgroundAllowed?(): boolean;
  openBatterySettings?(): void;
}

/** Apparence côté Android : icône de l'écran d'accueil, raccourci avec photo, mode sombre
 *  du système. */
interface AndroidLookBridge {
  systemDark?(): boolean;
  currentIcon?(): string;
  setIcon?(id: string): boolean;
  canPinShortcut?(): boolean;
  pinShortcut?(label: string, path: string): boolean;
}

/** Feuille de partage du système (WhatsApp, Bluetooth, e-mail, Drive…), sur un fichier déjà
 *  exporté par l'appli (archive .mpshare dans le dossier « partages/ »). */
interface AndroidShareBridge {
  share(path: string): boolean;
  shareText?(text: string): boolean;
  /** Service de premier plan (notification) pendant un partage : Android ne coupe pas l'appli. */
  transferNotice?(text: string, percent: number): void;
  transferDone?(): void;
}

/** Suppression de musique du téléphone, avec l'accord demandé par le système. */
interface AndroidFilesBridge {
  deleteFiles(json: string): boolean;
  openDefaultApps?(): boolean;
}

declare global {
  interface Window {
    AndroidLook?: AndroidLookBridge;
    AndroidShare?: AndroidShareBridge;
    AndroidFiles?: AndroidFilesBridge;
    __mpDeleted?: (ok: boolean) => void;
    __mpSystemDark?: (dark: boolean) => void;
    AndroidMedia?: AndroidMediaBridge;
    AndroidUpdate?: AndroidUpdateBridge;
    __mpMedia?: (command: string, arg: number) => void;
    __mpUpdate?: (stage: string, value: number | string) => void;
    __mpInsets?: (insets: Partial<Record<"top" | "bottom" | "left" | "right", number>>) => void;
    __mpOpenFile?: () => void;
    __mpLibraryChanged?: () => void;
  }
}

/** Marges réelles des barres système et de l'encoche, transmises par l'activité Android
 *  (au démarrage, puis à chaque rotation, pliage ou dépliage) : variables --sa-* utilisées
 *  par --safe-* (style.css). */
export function installInsets() {
  const apply: NonNullable<Window["__mpInsets"]> = (insets) => {
    const root = document.documentElement.style;
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const v = insets[side];
      if (typeof v === "number" && Number.isFinite(v)) root.setProperty(`--sa-${side}`, `${v}px`);
    }
  };
  window.__mpInsets = apply;
  try {
    const initial = window.AndroidMedia?.insets?.();
    if (initial) apply(JSON.parse(initial));
  } catch {
    // ancienne activité Android : les marges du navigateur (env) s'appliquent seules
  }
}

/** « Ouvrir avec Music Player » (fichier audio venant d'une autre appli) et musique du
 *  téléphone modifiée (téléchargement, copie, suppression). */
export function installAndroidFiles(handlers: { open: (path: string) => void; libraryChanged: () => void }) {
  const take = () => {
    try {
      const path = window.AndroidMedia?.takeOpenedFile?.();
      if (path) handlers.open(path);
    } catch {
      // ancienne activité Android
    }
  };
  window.__mpOpenFile = take;
  window.__mpLibraryChanged = handlers.libraryChanged;
  take(); // fichier reçu au lancement de l'appli
}

/** Lance la feuille de partage d'Android sur un fichier déjà exporté par l'appli ; faux
 *  (ou pas d'effet) ailleurs qu'Android, ou si Android a refusé (rare). */
export function shareFile(path: string): boolean {
  try {
    return window.AndroidShare?.share(path) ?? false;
  } catch {
    return false;
  }
}

/** Feuille de partage d'Android pour un texte (code de partage à envoyer par messagerie) ;
 *  faux ailleurs qu'Android. */
export function shareText(text: string): boolean {
  try {
    return window.AndroidShare?.shareText?.(text) ?? false;
  } catch {
    return false;
  }
}

let noticeShown = false;
let lastNotice = "";

/** Android : notification « partage en cours » (percent : 0 à 100, ou -1 si inconnu), qui
 *  garde l'appli en vie écran éteint ou en arrière-plan. Sans effet ailleurs. */
export function transferNotice(text: string, percent: number) {
  // Une mise à jour par changement visible (Android limite le rythme des notifications).
  const key = `${percent}|${text}`;
  if (noticeShown && key === lastNotice) return;
  lastNotice = key;
  try {
    window.AndroidShare?.transferNotice?.(text, percent);
    noticeShown = true;
  } catch {
    // ancienne activité Android
  }
}

export function transferNoticeDone() {
  if (!noticeShown) return;
  noticeShown = false;
  lastNotice = "";
  try {
    window.AndroidShare?.transferDone?.();
  } catch {
    // ancienne activité Android
  }
}

/** Empêche (vrai) ou rend possible (faux) la mise en veille de l'écran du téléphone. */
export function keepScreenOn(on: boolean) {
  try {
    window.AndroidMedia?.keepScreenOn(on);
  } catch {
    // ancienne version de l'activité Android : sans effet
  }
}

type Player = ReturnType<typeof usePlayerStore>;

export function installAndroidMedia(player: Player) {
  const bridge = window.AndroidMedia;
  if (!bridge) return;

  window.__mpMedia = (command, arg) => {
    if (!player.currentTrack) return;
    switch (command) {
      case "play":
        if (player.isPaused) void player.togglePlayPause();
        break;
      case "pause":
        if (!player.isPaused) void player.togglePlayPause();
        break;
      case "toggle":
        void player.togglePlayPause();
        break;
      case "next":
        void player.next();
        break;
      case "previous":
        void player.previous();
        break;
      case "seek":
        void player.seek(arg / 1000);
        break;
    }
  };

  let coverFor = "";
  let coverPath = "";
  async function publish() {
    const track = player.currentTrack;
    if (!track) {
      bridge!.clear();
      return;
    }
    if (coverFor !== track.id) {
      coverFor = track.id;
      coverPath = "";
      if (track.has_cover) {
        try {
          coverPath = (await api.getCover(track.path, track.id)) ?? "";
        } catch {
          // pas de pochette : la notification s'en passe
        }
      }
    }
    bridge!.update(
      JSON.stringify({
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: Math.round(track.duration_secs * 1000),
        positionMs: Math.round(player.positionAt(performance.now()) * 1000),
        playing: !player.isPaused,
        cover: coverPath,
      }),
    );
  }

  watch(
    () => [player.currentTrack?.id, player.isPaused],
    () => void publish(),
    { immediate: true },
  );
  // Position de la barre de progression de l'écran verrouillé après un saut.
  player.$onAction(({ name, after }) => {
    if (name === "seek") after(() => void publish());
  });
}

/** Android : demande au système d'effacer ces fichiers audio (fenêtre d'accord). Vrai si la
 *  personne a accepté ; null hors Android ou si la demande n'a pas pu être faite. */
export function deleteAudioFiles(paths: string[]): Promise<boolean | null> {
  const bridge = window.AndroidFiles;
  if (!bridge) return Promise.resolve(null);
  return new Promise((resolve) => {
    window.__mpDeleted = (ok) => {
      window.__mpDeleted = undefined;
      resolve(ok);
    };
    let started: boolean;
    try {
      started = bridge.deleteFiles(JSON.stringify(paths));
    } catch {
      started = false;
    }
    if (!started) {
      window.__mpDeleted = undefined;
      resolve(null);
    }
  });
}

/** Android : ouvre les réglages « Applis par défaut » du téléphone ; faux ailleurs. */
export function openDefaultApps(): boolean {
  try {
    return window.AndroidFiles?.openDefaultApps?.() ?? false;
  } catch {
    return false;
  }
}
