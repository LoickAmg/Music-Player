// Carte à partager (récap, extrait de paroles) : feuille de partage sur Android (WhatsApp,
// Instagram…), image enregistrée et montrée dans son dossier sur ordinateur.

import { api } from "./api";
import { canvasToPng } from "./recapCard";
import { revealOrShare } from "./share";

const ON_ANDROID = /Android/i.test(navigator.userAgent);

/** Message à afficher en cas de souci, sinon null. */
export async function shareCanvas(canvas: HTMLCanvasElement, name: string): Promise<string | null> {
  const png = await canvasToPng(canvas);
  const path = ON_ANDROID ? await api.shareImage(png, name) : await api.saveImage(png, name);
  return revealOrShare(path);
}
