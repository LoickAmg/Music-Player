// Après un export réussi (.mpshare) : feuille de partage native sur Android, sinon le
// fichier est montré dans son dossier (ordinateur), pour l'envoyer avec n'importe quelle
// autre application (messagerie, e-mail, nuage…).

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { shareFile } from "./androidMedia";

export async function revealOrShare(path: string | null): Promise<void> {
  if (!path) return; // boîte de dialogue « Enregistrer sous » annulée (ordinateur)
  if (shareFile(path)) return;
  try {
    await revealItemInDir(path);
  } catch {
    // mode démo du navigateur, ou ouverture refusée : rien d'autre à proposer
  }
}
