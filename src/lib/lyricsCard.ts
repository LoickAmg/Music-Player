import type { Palette, Rgb } from "./palette";
import { FONT, fit, loadImage, rgb, roundRect } from "./recapCard";

/** Carte d'un extrait de paroles à partager (1080 × 1350, format des réseaux). */
export const LYRICS_W = 1080;
export const LYRICS_H = 1350;
/** Lignes qu'une carte peut montrer sans devenir illisible. */
export const MAX_LINES = 6;

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

export async function drawLyricsCard(input: { lines: string[]; title: string; artist: string; coverUrl: string | null; palette: Palette | null }): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = LYRICS_W;
  canvas.height = LYRICS_H;
  const ctx = canvas.getContext("2d")!;
  const c1: Rgb = input.palette?.glow ?? [120, 90, 255];
  const c2: Rgb = input.palette?.secondary ?? [255, 80, 160];
  const base: Rgb = input.palette?.base ?? [16, 12, 30];
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, LYRICS_W, LYRICS_H);
  for (const [x, y, r, c, a] of [
    [120, 160, 820, c1, 0.75],
    [980, 1180, 860, c2, 0.6],
  ] as Array<[number, number, number, Rgb, number]>) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgb(c, a));
    g.addColorStop(1, rgb(c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, LYRICS_W, LYRICS_H);
  }

  // Paroles : la taille s'adapte pour que tout tienne entre l'en-tête et le pied de carte.
  const left = 90;
  const width = LYRICS_W - left * 2;
  const top = 300;
  const bottom = LYRICS_H - 150;
  let size = 84;
  let rows: string[] = [];
  for (; size >= 36; size -= 4) {
    ctx.font = `800 ${size}px ${FONT}`;
    rows = input.lines.flatMap((l) => wrap((t) => ctx.measureText(t).width, l, width));
    if (rows.length * size * 1.28 <= bottom - top) break;
  }
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 ${size}px ${FONT}`;
  const height = rows.length * size * 1.28;
  let y = top + Math.max(0, (bottom - top - height) / 2) + size;
  for (const row of rows) {
    if (y > bottom + size) break;
    ctx.fillText(fit(ctx, row, width), left, y);
    y += size * 1.28;
  }

  // En-tête : pochette, titre, artiste.
  const cover = await loadImage(input.coverUrl);
  const coverSize = 150;
  if (cover) {
    ctx.save();
    roundRect(ctx, left, 90, coverSize, coverSize, 18);
    ctx.clip();
    ctx.drawImage(cover, left, 90, coverSize, coverSize);
    ctx.restore();
  }
  const textLeft = cover ? left + coverSize + 32 : left;
  const textWidth = LYRICS_W - textLeft - left;
  ctx.fillStyle = "#fff";
  ctx.font = `800 46px ${FONT}`;
  ctx.fillText(fit(ctx, input.title, textWidth), textLeft, 150);
  ctx.globalAlpha = 0.78;
  ctx.font = `600 36px ${FONT}`;
  ctx.fillText(fit(ctx, input.artist, textWidth), textLeft, 204);
  ctx.globalAlpha = 0.8;
  ctx.font = `800 34px ${FONT}`;
  ctx.fillText("Music Player", left, LYRICS_H - 70);
  ctx.globalAlpha = 1;
  return canvas;
}
