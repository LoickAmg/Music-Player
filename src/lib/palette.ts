// Couleurs d'ambiance tirées de la pochette : l'image est réduite à 48 × 48 px dans un
// canvas, puis les pixels sont regroupés par teinte. La teinte la plus présente (pondérée
// par la saturation) donne la couleur principale, une teinte éloignée la secondaire.

import { hueFor } from "./format";

export type Rgb = [number, number, number];

export interface Palette {
  /** Couleur dominante, telle qu'elle apparaît sur la pochette. */
  primary: Rgb;
  /** Deuxième teinte marquante (ou variante de la première si la pochette est unie). */
  secondary: Rgb;
  /** Version lumineuse et saturée de la dominante : halos, lueurs des paroles. */
  glow: Rgb;
  /** Fond très sombre teinté par la dominante. */
  base: Rgb;
  /** 0 = pochette sombre et terne, 1 = pochette vive et lumineuse. */
  energy: number;
}

export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Construit la palette à partir de pixels RGBA (sortie de `getImageData`). */
export function paletteFromPixels(data: Uint8ClampedArray): Palette {
  const BUCKETS = 24;
  const weight = new Float64Array(BUCKETS);
  const sums = Array.from({ length: BUCKETS }, () => [0, 0, 0, 0]);
  let satTotal = 0;
  let lumTotal = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const rgb: Rgb = [data[i], data[i + 1], data[i + 2]];
    const [h, s, l] = rgbToHsl(rgb);
    count++;
    satTotal += s;
    lumTotal += l;
    // Les pixels presque noirs ou presque blancs ne disent rien de la teinte.
    if (l < 0.08 || l > 0.94) continue;
    const w = s * s * (1 - Math.abs(l - 0.5));
    const k = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
    weight[k] += w;
    const acc = sums[k];
    acc[0] += rgb[0] * w;
    acc[1] += rgb[1] * w;
    acc[2] += rgb[2] * w;
    acc[3] += w;
  }
  const avgSat = count ? satTotal / count : 0;
  const avgLum = count ? lumTotal / count : 0.3;

  const order = [...weight.keys()].sort((a, b) => weight[b] - weight[a]);
  const mean = (k: number): Rgb => {
    const [r, g, b, w] = sums[k];
    return w ? [r / w, g / w, b / w] : [90, 90, 100];
  };
  const totalWeight = weight.reduce((a, b) => a + b, 0);
  const grey = totalWeight < 0.5 || avgSat < 0.08;

  let primary: Rgb = grey ? [120, 120, 130] : mean(order[0]);
  const [ph, ps] = rgbToHsl(primary);
  // Teinte secondaire : la plus présente parmi celles éloignées d'au moins 45°.
  const far = order.find((k) => {
    if (weight[k] < totalWeight * 0.06) return false;
    const dh = Math.abs(k * 15 + 7.5 - ph);
    return Math.min(dh, 360 - dh) >= 45;
  });
  let secondary: Rgb = far !== undefined && !grey ? mean(far) : hslToRgb(ph + 35, clamp(ps, 0.25, 0.7), 0.4);
  if (grey) {
    primary = hslToRgb(ph, 0.08, 0.45);
    secondary = hslToRgb(ph + 30, 0.06, 0.3);
  }

  const glowSat = grey ? 0.15 : clamp(ps * 1.2, 0.6, 0.95);
  const glow = hslToRgb(ph, glowSat, grey ? 0.8 : 0.66);
  const base = hslToRgb(ph, grey ? 0.05 : clamp(ps, 0.25, 0.55), 0.09);
  const energy = clamp(avgSat * 1.3 * 0.6 + avgLum * 0.7, 0, 1);
  return { primary: primary.map(Math.round) as Rgb, secondary: secondary.map(Math.round) as Rgb, glow, base, energy };
}

/** Palette de repli, stable pour un même album, quand il n'y a pas de pochette. */
export function paletteFromText(text: string): Palette {
  const h = hueFor(text || "?");
  return {
    primary: hslToRgb(h, 0.5, 0.42),
    secondary: hslToRgb(h + 50, 0.45, 0.32),
    glow: hslToRgb(h, 0.8, 0.68),
    base: hslToRgb(h, 0.35, 0.09),
    energy: 0.5,
  };
}

const cache = new Map<string, Promise<Palette | null>>();

/** Palette d'une image (URL), mise en cache. `null` si l'image ne se charge pas. */
export function paletteFromImage(url: string): Promise<Palette | null> {
  let pending = cache.get(url);
  if (!pending) {
    pending = new Promise<Palette | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => {
        try {
          const size = 48;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) return resolve(null);
          ctx.drawImage(img, 0, 0, size, size);
          resolve(paletteFromPixels(ctx.getImageData(0, 0, size, size).data));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    cache.set(url, pending);
  }
  return pending;
}

export const css = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`;
