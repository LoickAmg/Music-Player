// Ordinateur : avancement d'un envoi ou d'une réception sur l'icône de la barre des tâches,
// visible appli réduite ou derrière une autre fenêtre. (Android : notification de TransferService.)

let last: number | null | undefined;

/** `percent` : 0 à 100, -1 si inconnu (barre animée), null pour l'effacer. */
export function taskbarProgress(percent: number | null) {
  if (percent === last) return;
  last = percent;
  void (async () => {
    try {
      const { getCurrentWindow, ProgressBarStatus } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (percent === null) await win.setProgressBar({ status: ProgressBarStatus.None });
      else if (percent < 0) await win.setProgressBar({ status: ProgressBarStatus.Indeterminate });
      else await win.setProgressBar({ status: ProgressBarStatus.Normal, progress: Math.max(0, Math.min(100, Math.round(percent))) });
    } catch {
      // Android, mode démo, ou permission absente : rien à montrer.
    }
  })();
}
