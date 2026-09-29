export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** « 12 morceaux, 48 min » / « 1 morceau, 3 min » / « 230 morceaux, 14 h 2 min ». */
export function formatCollection(count: number, totalSeconds: number): string {
  const tracks = `${count.toLocaleString("fr-FR")} morceau${count > 1 ? "x" : ""}`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${tracks}, ${minutes} min`;
  return `${tracks}, ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Tri alphabétique « à la française » (accents, casse, nombres naturels). */
export const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });

/** Couleur de repli stable pour un nom (pochettes absentes). */
export function hueFor(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}
