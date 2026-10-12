// Icônes d'application au choix (personnalisation) : dessinées ici en SVG, converties en PNG
// pour l'ordinateur (icône de fenêtre et aperçus, public/app-icons) et pour Android (icônes
// adaptatives par densité, src-tauri/icons/android-variants, copiées par android-patch.mjs).
// À relancer après avoir modifié un dessin : `node scripts/render-icons.mjs`. Les PNG
// produits sont versionnés : la CI n'a pas besoin de cet outil.

import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

// Note de musique (deux croches liées), dessinée autour de (0, 0), env. 530 × 480.
const NOTE = `
  <path d="M-120 -232 L240 -302 L240 -224 L-120 -154 Z"/>
  <rect x="-120" y="-232" width="46" height="336" rx="6"/>
  <rect x="194" y="-302" width="46" height="336" rx="6"/>
  <ellipse cx="-188" cy="110" rx="100" ry="74" transform="rotate(-22 -188 110)"/>
  <ellipse cx="126" cy="40" rx="100" ry="74" transform="rotate(-22 126 40)"/>`;
const note = (fill, extra = "") => `<g transform="translate(486 560)" fill="${fill}" ${extra}>${NOTE}</g>`;

// Étoiles à positions fixes (générateur pseudo-aléatoire graine fixe).
function stars(count, seed, maxR = 5) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  let out = "";
  for (let i = 0; i < count; i++) {
    out += `<circle cx="${(rnd() * 1024).toFixed(0)}" cy="${(rnd() * 1024).toFixed(0)}" r="${(1 + rnd() * maxR).toFixed(1)}" fill="#fff" opacity="${(0.35 + rnd() * 0.65).toFixed(2)}"/>`;
  }
  return out;
}

// Chaque variante : un fond plein cadre (bg) et un motif centré dans la zone sûre d'Android
// (fg, environ 620 px au centre).
const VARIANTS = [
  {
    id: "neon",
    label: "Néon",
    bg: `<defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#3a0c5c"/><stop offset="1" stop-color="#0b0614"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#g)"/>`,
    fg: `<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="16"/></filter></defs>
      <g transform="translate(14 12)" opacity="0.9">${note("#00f0ff", 'filter="url(#glow)"')}</g>
      <g transform="translate(14 12)">${note("none", 'stroke="#00f0ff" stroke-width="14"')}</g>
      <g opacity="0.95">${note("#ff2fd6", 'filter="url(#glow)"')}</g>
      ${note("none", 'stroke="#ffd6f6" stroke-width="16"')}`,
  },
  {
    id: "vinyle",
    label: "Vinyle",
    bg: `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a5a"/><stop offset="1" stop-color="#ff3d71"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#g)"/>`,
    fg: `<circle cx="512" cy="512" r="300" fill="#121214"/>
      ${[270, 240, 210, 180, 150].map((r) => `<circle cx="512" cy="512" r="${r}" fill="none" stroke="#2c2c31" stroke-width="5"/>`).join("")}
      <path d="M512 212 A300 300 0 0 1 772 362" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="22" stroke-linecap="round"/>
      <circle cx="512" cy="512" r="112" fill="#ffd23f"/>
      <circle cx="512" cy="512" r="112" fill="none" stroke="#f0a500" stroke-width="6"/>
      <circle cx="512" cy="512" r="16" fill="#121214"/>`,
  },
  {
    id: "onde",
    label: "Onde",
    bg: `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f6bff"/><stop offset="1" stop-color="#3fe0ff"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#g)"/>`,
    fg: [120, 260, 380, 520, 380, 260, 120]
      .map((h, i) => `<rect x="${242 + i * 82}" y="${512 - h / 2}" width="50" height="${h}" rx="25" fill="#fff"/>`)
      .join(""),
  },
  {
    id: "cassette",
    label: "Cassette",
    bg: `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4a261"/><stop offset="1" stop-color="#e76f51"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#g)"/>`,
    fg: `<rect x="222" y="322" width="580" height="380" rx="44" fill="#264653"/>
      <rect x="272" y="362" width="480" height="150" rx="18" fill="#e9c46a"/>
      <rect x="302" y="392" width="420" height="22" rx="11" fill="#264653" opacity="0.35"/>
      ${[400, 624].map((cx) => `<circle cx="${cx}" cy="590" r="62" fill="#f1faee"/><circle cx="${cx}" cy="590" r="22" fill="#264653"/>`).join("")}
      <rect x="456" y="566" width="112" height="48" rx="12" fill="#1b3440"/>
      <path d="M322 702 L362 642 L662 642 L702 702 Z" fill="#1b3440"/>`,
  },
  {
    id: "galaxie",
    label: "Galaxie",
    bg: `<defs><radialGradient id="g" cx="35%" cy="30%" r="90%"><stop offset="0" stop-color="#5b2bbd"/><stop offset="0.5" stop-color="#1a0f3f"/><stop offset="1" stop-color="#05020f"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#g)"/>${stars(70, 7)}`,
    fg: `<defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9ad5"/><stop offset="1" stop-color="#7b5cff"/></linearGradient></defs>
      <g transform="rotate(-18 512 512)"><ellipse cx="512" cy="512" rx="310" ry="80" fill="none" stroke="#ffd1f0" stroke-width="22" opacity="0.55"/></g>
      <circle cx="512" cy="512" r="190" fill="url(#p)"/>
      <g transform="rotate(-18 512 512)"><clipPath id="front"><rect x="0" y="512" width="1024" height="512"/></clipPath>
        <ellipse cx="512" cy="512" rx="310" ry="80" fill="none" stroke="#ffe6f6" stroke-width="22" clip-path="url(#front)"/></g>`,
  },
  {
    id: "sakura",
    label: "Sakura",
    bg: `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0f5"/><stop offset="1" stop-color="#ffb3cb"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#g)"/>`,
    fg: `${note("#e2507d")}
      <g transform="translate(700 300)">${[0, 72, 144, 216, 288].map((a) => `<ellipse cx="0" cy="-46" rx="30" ry="48" fill="#ff8fb1" transform="rotate(${a})"/>`).join("")}<circle r="16" fill="#ffd23f"/></g>`,
  },
  {
    id: "minimal",
    label: "Minimal",
    bg: `<rect width="1024" height="1024" fill="#f4f4f2"/>`,
    fg: note("#111114"),
  },
  {
    id: "or",
    label: "Noir & or",
    bg: `<defs><radialGradient id="g" cx="50%" cy="35%" r="80%"><stop offset="0" stop-color="#2a2418"/><stop offset="1" stop-color="#050505"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#g)"/>`,
    fg: `<defs><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbe7a8"/><stop offset="0.5" stop-color="#f4d58d"/><stop offset="1" stop-color="#b8862f"/></linearGradient></defs>${note("url(#gold)")}`,
  },
  {
    id: "arcade",
    label: "Arcade",
    bg: `<rect width="1024" height="1024" fill="#08081a"/>${stars(30, 3, 2)}`,
    // Croche en gros pixels (grille de 10 × 10 cases de 56 px).
    fg: (() => {
      const rows = [".....##...", ".....###..", ".....#.##.", ".....#..#.", ".....#....", ".....#....", "..####....", ".#####....", ".#####....", "..###....."];
      let out = "";
      rows.forEach((row, y) =>
        [...row].forEach((c, x) => {
          if (c === "#") out += `<rect x="${232 + x * 56}" y="${232 + y * 56}" width="56" height="56" fill="#39ff14"/>`;
        }),
      );
      return out;
    })(),
  },
];

const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${inner}</svg>`;
const png = (svgText, size) => new Resvg(svgText, { fitTo: { mode: "width", value: size } }).render().asPng();

const pcDir = path.resolve("public/app-icons");
const androidDir = path.resolve("src-tauri/icons/android-variants");
fs.mkdirSync(pcDir, { recursive: true });

// Icône de l'ordinateur : carré aux coins arrondis, fond + motif.
const rounded = (v) =>
  svg(`<defs><clipPath id="r"><rect width="1024" height="1024" rx="228"/></clipPath></defs><g clip-path="url(#r)">${v.bg}${v.fg}</g>`);

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const v of VARIANTS) {
  fs.writeFileSync(path.join(pcDir, `${v.id}.png`), png(rounded(v), 256));
  for (const [d, k] of Object.entries(DENSITIES)) {
    const dir = path.join(androidDir, `mipmap-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    // Calques adaptatifs : 108 dp ; icône classique (Android 7) : 48 dp, coins arrondis.
    fs.writeFileSync(path.join(dir, `ic_alt_${v.id}_bg.png`), png(svg(v.bg), Math.round(108 * k)));
    fs.writeFileSync(path.join(dir, `ic_alt_${v.id}_fg.png`), png(svg(v.fg), Math.round(108 * k)));
    fs.writeFileSync(path.join(dir, `ic_alt_${v.id}.png`), png(rounded(v), Math.round(48 * k)));
  }
}
// Icône d'origine : aperçu depuis la source du logo.
fs.writeFileSync(
  path.join(pcDir, "origine.png"),
  png(
    rounded({
      bg: `<image href="data:image/png;base64,${fs.readFileSync("src-tauri/icons/app-icon-source.png").toString("base64")}" width="1024" height="1024"/>`,
      fg: "",
    }),
    256,
  ),
);
fs.writeFileSync(
  path.join(pcDir, "variants.json"),
  JSON.stringify([{ id: "origine", label: "Original" }, ...VARIANTS.map(({ id, label }) => ({ id, label }))], null, 2) + "\n",
);
console.log(`${VARIANTS.length} variantes d'icône produites (ordinateur et Android).`);
