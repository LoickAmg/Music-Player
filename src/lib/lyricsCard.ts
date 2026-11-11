import type { Palette, Rgb } from "./palette";
import { FONT, fit, loadImage, rgb, roundRect } from "./recapCard";

/** Carte d'un extrait de paroles à partager : plusieurs styles et formats (réseaux, stories). */
export const LYRICS_W = 1080;
/** Lignes qu'une carte peut montrer sans devenir illisible. */
export const MAX_LINES = 6;

export type CardStyle = "halo" | "bulles" | "pochette" | "papier";
export type CardFormat = "carre" | "portrait" | "story";

export const CARD_STYLES: { id: CardStyle; label: string }[] = [
  { id: "halo", label: "Halo" },
  { id: "bulles", label: "Bulles" },
  { id: "pochette", label: "Pochette" },
  { id: "papier", label: "Papier" },
];
export const CARD_FORMATS: { id: CardFormat; label: string; height: number }[] = [
  { id: "carre", label: "Carré", height: 1080 },
  { id: "portrait", label: "Portrait", height: 1350 },
  { id: "story", label: "Story", height: 1920 },
];

/** Découpe un texte en lignes qui tiennent dans `max` pixels. */
export function wrap(measure: (text: string) => number, text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > max) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out;
}

/** Lumière perçue (0 à 1) : pour choisir un texte sombre ou clair sur une couleur. */
export function luminance([r, g, b]: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Couleur vive tirée de la pochette, assez claire pour servir de fond aux bulles. */
function bright(c: Rgb): Rgb {
  const lift = luminance(c) < 0.45 ? 0.45 - luminance(c) : 0;
  return c.map((v) => Math.round(v + (255 - v) * lift * 1.6)) as Rgb;
}

interface Input {
  lines: string[];
  title: string;
  artist: string;
  coverUrl: string | null;
  palette: Palette | null;
  style?: CardStyle;
  format?: CardFormat;
}

export async function drawLyricsCard(input: Input): Promise<HTMLCanvasElement> {
  const style = input.style ?? "halo";
  const height = CARD_FORMATS.find((f) => f.id === (input.format ?? "portrait"))!.height;
  const canvas = document.createElement("canvas");
  canvas.width = LYRICS_W;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const c1: Rgb = input.palette?.glow ?? [120, 90, 255];
  const c2: Rgb = input.palette?.secondary ?? [255, 80, 160];
  const base: Rgb = input.palette?.base ?? [16, 12, 30];
  const cover = await loadImage(input.coverUrl);

  // ---------------------------------------------------------------- fond
  let ink = "#fff";
  let sub = "rgba(255,255,255,0.78)";
  if (style === "halo") {
    ctx.fillStyle = rgb(base);
    ctx.fillRect(0, 0, LYRICS_W, height);
    for (const [x, y, r, c, a] of [
      [120, height * 0.12, 820, c1, 0.75],
      [980, height * 0.88, 860, c2, 0.6],
    ] as Array<[number, number, number, Rgb, number]>) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgb(c, a));
      g.addColorStop(1, rgb(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, LYRICS_W, height);
    }
  } else if (style === "bulles") {
    const bg = bright(c1);
    ctx.fillStyle = rgb(bg);
    ctx.fillRect(0, 0, LYRICS_W, height);
    ink = luminance(bg) > 0.6 ? "#0b0b10" : "#fff";
    sub = luminance(bg) > 0.6 ? "rgba(10,10,16,0.7)" : "rgba(255,255,255,0.8)";
  } else if (style === "pochette") {
    ctx.fillStyle = rgb(base);
    ctx.fillRect(0, 0, LYRICS_W, height);
    if (cover) {
      // Pochette en plein cadre, floutée et assombrie : les paroles restent lisibles.
      const side = Math.max(LYRICS_W, height) * 1.15;
      ctx.save();
      ctx.filter = "blur(36px) saturate(1.25)";
      ctx.drawImage(cover, (LYRICS_W - side) / 2, (height - side) / 2, side, side);
      ctx.restore();
    }
    const shade = ctx.createLinearGradient(0, 0, 0, height);
    shade.addColorStop(0, "rgba(0,0,0,0.35)");
    shade.addColorStop(1, "rgba(0,0,0,0.6)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, LYRICS_W, height);
  } else {
    ctx.fillStyle = "#f4efe6";
    ctx.fillRect(0, 0, LYRICS_W, height);
    ink = "#1b1712";
    sub = "rgba(27,23,18,0.66)";
  }

  // ---------------------------------------------------------------- en-tête
  const left = 90;
  const coverSize = height >= 1900 ? 170 : 150;
  const headTop = height >= 1900 ? 170 : 90;
  if (cover) {
    ctx.save();
    roundRect(ctx, left, headTop, coverSize, coverSize, 18);
    ctx.clip();
    ctx.drawImage(cover, left, headTop, coverSize, coverSize);
    ctx.restore();
  }
  const textLeft = cover ? left + coverSize + 32 : left;
  const textWidth = LYRICS_W - textLeft - left;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ink;
  ctx.font = `800 46px ${FONT}`;
  ctx.fillText(fit(ctx, input.title, textWidth), textLeft, headTop + 60);
  ctx.fillStyle = sub;
  ctx.font = `600 36px ${FONT}`;
  ctx.fillText(fit(ctx, input.artist, textWidth), textLeft, headTop + 114);

  // ---------------------------------------------------------------- paroles
  const pad = style === "bulles" ? 34 : 0;
  const width = LYRICS_W - left * 2 - pad * 2;
  const top = headTop + coverSize + 70;
  const bottom = height - (height >= 1900 ? 240 : 150);
  const gapRatio = 1.28;
  /** Bulles : interligne serré dans la bulle, marge haute et basse autour du texte. */
  const bubbleLine = 1.18;
  const bubblePad = 0.34;
  let size = style === "papier" ? 76 : 84;
  let rows: string[][] = [];
  const weight = style === "papier" ? "700" : "800";
  const family = style === "papier" ? `Georgia, "Times New Roman", serif` : FONT;
  for (; size >= 34; size -= 4) {
    ctx.font = `${weight} ${size}px ${family}`;
    rows = input.lines.map((l) => wrap((t) => ctx.measureText(t).width, l, width));
    const count = rows.reduce((s, r) => s + r.length, 0);
    const needed =
      style === "bulles"
        ? count * size * bubbleLine + rows.length * size * bubblePad * 2 + (rows.length - 1) * size * 0.3
        : count * size * gapRatio;
    if (needed <= bottom - top) break;
  }
  ctx.font = `${weight} ${size}px ${family}`;
  const count = rows.reduce((s, r) => s + r.length, 0);
  const blockGap = style === "bulles" ? size * 0.3 : 0;
  const total =
    style === "bulles"
      ? count * size * bubbleLine + rows.length * size * bubblePad * 2 + (rows.length - 1) * blockGap
      : count * size * gapRatio;
  let y = top + Math.max(0, (bottom - top - total) / 2);

  if (style === "papier") {
    // Guillemet d'ouverture, en couleur de la pochette.
    ctx.fillStyle = rgb(c1);
    ctx.font = `700 ${size * 2.2}px ${family}`;
    ctx.fillText("«", left - 10, y + size * 0.9);
    ctx.font = `${weight} ${size}px ${family}`;
    y += size * 0.6;
  }

  for (const block of rows) {
    if (style === "bulles") {
      // Chaque ligne choisie dans sa bulle sombre, le texte de la couleur du fond.
      const lineH = size * bubbleLine;
      const padY = size * bubblePad;
      const h = block.length * lineH + padY * 2;
      const w = Math.min(LYRICS_W - left * 2, Math.max(...block.map((r) => ctx.measureText(r).width)) + pad * 2);
      if (y + h > bottom + size) break;
      ctx.fillStyle = ink === "#fff" ? "rgba(0,0,0,0.55)" : "#0b0b10";
      roundRect(ctx, left, y, w, h, Math.min(44, size * 0.6));
      ctx.fill();
      ctx.fillStyle = ink === "#fff" ? "#fff" : rgb(bright(c1));
      // Ligne de base : la hauteur visible des lettres (≈ 0,72 × taille) centrée dans sa ligne.
      let ry = y + padY + lineH / 2 + size * 0.36;
      for (const row of block) {
        ctx.fillText(fit(ctx, row, width), left + pad, ry);
        ry += lineH;
      }
      y += h + blockGap;
      continue;
    }
    ctx.fillStyle = ink;
    for (const row of block) {
      y += size * gapRatio;
      if (y > bottom + size) break;
      ctx.fillText(fit(ctx, row, width), left, y - size * (gapRatio - 1));
    }
  }

  // ---------------------------------------------------------------- signature
  ctx.fillStyle = sub;
  ctx.font = `800 34px ${FONT}`;
  ctx.fillText("Music Player", left, height - (height >= 1900 ? 150 : 70));
  return canvas;
}
