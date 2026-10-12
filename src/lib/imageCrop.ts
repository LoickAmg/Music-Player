// Recadrage d'images (photo de profil, icône, raccourci Android) : même calcul pour l'aperçu
// et pour l'image enregistrée, l'utilisateur obtient exactement ce qu'il a cadré.

export interface Crop {
  /** Position du cadrage, de 0 à 100 % sur chaque axe. */
  x: number;
  y: number;
  /** Zoom, 1 = l'image couvre juste le carré. */
  zoom: number;
}

export const DEFAULT_CROP: Crop = { x: 50, y: 50, zoom: 1 };

/** Place de l'image (taille naturelle w × h) dans un carré de côté `size`. */
export function placement(w: number, h: number, size: number, crop: Crop) {
  const scale = Math.max(size / w, size / h) * crop.zoom;
  const dw = w * scale;
  const dh = h * scale;
  return { left: ((size - dw) * crop.x) / 100, top: ((size - dh) * crop.y) / 100, width: dw, height: dh };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = src;
  });
}

export interface RenderOptions {
  /** Côté de l'image produite, en pixels. */
  size: number;
  /** Arrondi des coins (fraction du côté : 0,5 = cercle), fond transparent autour. */
  round?: number;
  /** Image réduite au centre (fraction du côté), le reste rempli de la même image floutée :
   *  icône adaptative d'Android, dont le lanceur ne montre que le centre. */
  inset?: number;
  type?: "image/png" | "image/jpeg";
}

export async function renderCrop(src: string, crop: Crop, opts: RenderOptions): Promise<Blob> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = opts.size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Dessin impossible");
  const inner = opts.size * (opts.inset ?? 1);
  const offset = (opts.size - inner) / 2;
  if (opts.inset && opts.inset < 1) {
    const back = placement(img.naturalWidth, img.naturalHeight, opts.size, { x: 50, y: 50, zoom: 1.2 });
    ctx.filter = "blur(24px) brightness(0.8)";
    ctx.drawImage(img, back.left, back.top, back.width, back.height);
    ctx.filter = "none";
  }
  ctx.save();
  if (opts.round) {
    const r = opts.size * opts.round;
    ctx.beginPath();
    ctx.roundRect(0, 0, opts.size, opts.size, r);
    ctx.clip();
  }
  const p = placement(img.naturalWidth, img.naturalHeight, inner, crop);
  ctx.drawImage(img, offset + p.left, offset + p.top, p.width, p.height);
  ctx.restore();
  const type = opts.type ?? (opts.round ? "image/png" : "image/jpeg");
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.9));
  if (!blob) throw new Error("Image non produite");
  return blob;
}
