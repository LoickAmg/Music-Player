import type { Palette, Rgb } from "./palette";
import { formatListening, minutesLabel, type Recap } from "./recap";

/** Carte récapitulative à partager (format story 1080 × 1920), dessinée sur un canevas. */
export const CARD_W = 1080;
export const CARD_H = 1920;

const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, sans-serif';

function rgb([r, g, b]: Rgb, a = 1) {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Texte tronqué avec « … » pour tenir dans `max` pixels. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

export async function drawRecapCard(recap: Recap, palette: Palette | null, coverUrl: string | null): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d")!;
  const c1: Rgb = palette?.glow ?? [120, 90, 255];
  const c2: Rgb = palette?.secondary ?? [255, 80, 160];
  const base: Rgb = palette?.base ?? [16, 12, 30];

  // Fond : la teinte de la pochette n°1, en grands halos sur un fond sombre.
  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  for (const [x, y, r, c, a] of [
    [150, 220, 900, c1, 0.75],
    [980, 1250, 950, c2, 0.55],
    [300, 1800, 700, c1, 0.35],
  ] as Array<[number, number, number, Rgb, number]>) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgb(c, a));
    g.addColorStop(1, rgb(c, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
  }

  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 40px ${FONT}`;
  ctx.globalAlpha = 0.8;
  ctx.fillText(recap.period.kind === "year" ? "MON ANNÉE EN MUSIQUE" : "MON MOIS EN MUSIQUE", 90, 150);
  ctx.globalAlpha = 1;
  ctx.font = `900 120px ${FONT}`;
  ctx.fillText(recap.period.kind === "year" ? String(recap.period.year) : fit(ctx, recap.label.replace(/^./, (c) => c.toUpperCase()), 900), 86, 280);

  // Pochette du morceau phare, légèrement inclinée.
  const cover = await loadImage(coverUrl);
  const size = 560;
  ctx.save();
  ctx.translate(CARD_W / 2, 650);
  ctx.rotate(-0.04);
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 24;
  roundRect(ctx, -size / 2, -size / 2, size, size, 36);
  ctx.fillStyle = rgb(c1, 0.9);
  ctx.fill();
  ctx.shadowColor = "transparent";
  if (cover) {
    ctx.clip();
    ctx.drawImage(cover, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = "#fff";
    ctx.font = `900 220px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("♪", 0, 80);
    ctx.textAlign = "left";
  }
  ctx.restore();

  // Deux colonnes : artistes et morceaux.
  const colY = 1040;
  const colW = 430;
  const columns: Array<[string, string[]]> = [
    ["Top artistes", recap.topArtists.slice(0, 5).map((a) => a.label)],
    ["Top morceaux", recap.topTracks.slice(0, 5).map((t) => t.label)],
  ];
  columns.forEach(([title, items], col) => {
    const x = 90 + col * (colW + 70);
    ctx.font = `700 34px ${FONT}`;
    ctx.globalAlpha = 0.75;
    ctx.fillText(title, x, colY);
    ctx.globalAlpha = 1;
    items.forEach((item, i) => {
      const y = colY + 70 + i * 66;
      ctx.font = `800 40px ${FONT}`;
      ctx.globalAlpha = 0.55;
      ctx.fillText(String(i + 1), x, y);
      ctx.globalAlpha = 1;
      ctx.font = `700 40px ${FONT}`;
      ctx.fillText(fit(ctx, item, colW - 50), x + 44, y);
    });
  });

  // Chiffres clés.
  const statsY = 1530;
  const stats: Array<[string, string]> = [
    ["Minutes d'écoute", minutesLabel(recap.totalSecs)],
    ["Profil", recap.personality.title],
  ];
  stats.forEach(([label, value], col) => {
    const x = 90 + col * (colW + 70);
    ctx.font = `700 34px ${FONT}`;
    ctx.globalAlpha = 0.75;
    ctx.fillText(label, x, statsY);
    ctx.globalAlpha = 1;
    // Texte long (« Fan inconditionnel ») : la taille diminue avant de couper.
    let size = 72;
    ctx.font = `900 ${size}px ${FONT}`;
    while (size > 40 && ctx.measureText(value).width > colW) {
      size -= 4;
      ctx.font = `900 ${size}px ${FONT}`;
    }
    ctx.fillText(fit(ctx, value, colW), x, statsY + 84);
  });
  ctx.font = `600 30px ${FONT}`;
  ctx.globalAlpha = 0.7;
  ctx.fillText(`${formatListening(recap.totalSecs)} · ${recap.plays.toLocaleString("fr-FR")} écoutes · ${recap.artistCount} artistes`, 90, 1760);
  ctx.globalAlpha = 0.9;
  ctx.font = `800 34px ${FONT}`;
  ctx.fillText("Music Player", 90, 1840);
  ctx.globalAlpha = 1;
  return canvas;
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("Image impossible à produire."));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}
