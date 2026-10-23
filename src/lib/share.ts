// Après un export réussi (.mpshare) : feuille de partage native sur Android, sinon le
// fichier est montré dans son dossier (ordinateur), pour l'envoyer avec n'importe quelle
// autre application (messagerie, e-mail, nuage…).

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { shareFile } from "./androidMedia";

const ON_ANDROID = /Android/i.test(navigator.userAgent);

/** Message à afficher, ou null si la feuille de partage / le dossier s'est bien ouvert. */
export async function revealOrShare(path: string): Promise<string | null> {
  if (ON_ANDROID) {
    return shareFile(path) ? null : "Archive prête, mais la feuille de partage d'Android n'a pas pu s'ouvrir.";
  }
  try {
    await revealItemInDir(path);
    return null;
  } catch {
    return `Archive enregistrée : ${path}`;
  }
}
