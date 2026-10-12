<script setup lang="ts">
import { computed, ref } from "vue";
import { catalogFont, SYSTEM_FONT } from "@/lib/fonts";
import { BUILTIN_THEMES, cloneTheme, contrast, parseHex, parseThemeFile, themeFile, type FontRole, type Theme } from "@/lib/themes";
import { useAppearanceStore } from "@/stores/appearance";
import { useUiStore } from "@/stores/ui";
import FontPicker from "@/components/FontPicker.vue";
import Icon from "@/components/Icon.vue";

// Personnalisation : thèmes (prêts à l'emploi ou créés), éditeur de couleurs, polices de
// l'interface, des titres et des paroles, taille des paroles.
const appearance = useAppearanceStore();
const ui = useUiStore();

const s = computed(() => appearance.settings);
const current = computed(() => appearance.theme);
const editable = computed(() => !current.value.builtin);
const themeInput = ref<HTMLInputElement | null>(null);
// Android : pas de filtre (un .json téléchargé y a souvent un type générique).
const themeAccept = /Android/i.test(navigator.userAgent) ? undefined : ".json,application/json,text/plain";

// Police des titres de chaque thème, pour l'aperçu « Aa » de sa vignette.
for (const t of appearance.themes) if (t.fonts?.display) void appearance.loadFont(t.fonts.display);

const ROLES: { role: FontRole; label: string; hint: string; decorative: boolean; sample: string }[] = [
  { role: "ui", label: "Interface", hint: "Menus, listes, boutons", decorative: false, sample: "Morceaux · Albums 123" },
  { role: "display", label: "Titres", hint: "Titres des pages, albums, playlists", decorative: true, sample: "Mes playlists" },
  { role: "lyrics", label: "Paroles", hint: "Paroles synchronisées", decorative: true, sample: "Sous les néons de la ville" },
];
const openRole = ref<FontRole | null>(null);

function fontLabel(id: string): string {
  if (!id || id === SYSTEM_FONT) return "Police du système";
  if (id.startsWith("custom:")) return appearance.settings.customFonts.find((f) => f.id === id)?.label ?? "Police importée";
  return catalogFont(id)?.label ?? "Police du système";
}

const suggested = computed(() => {
  const f = current.value.fonts;
  if (!f) return null;
  const same = (["ui", "display", "lyrics"] as FontRole[]).every((r) => (f[r] ?? SYSTEM_FONT) === s.value.fonts[r]);
  return same ? null : Object.values(f).map(fontLabel).join(" · ");
});

function preview(t: Theme) {
  return {
    background: t.colors.bg,
    color: t.colors.text,
    borderRadius: `${Math.min(t.radius, 14)}px`,
  };
}

function customize() {
  const base = current.value;
  const copy = cloneTheme(base, base.builtin ? `${base.name} (perso)` : `${base.name} (copie)`);
  appearance.saveTheme(copy);
  ui.notify("Thème copié : modifiez-le à votre goût");
}

function update(patch: Partial<Theme>, colors?: Partial<Theme["colors"]>) {
  const t = current.value;
  if (t.builtin) return;
  appearance.saveTheme({ ...t, ...patch, colors: { ...t.colors, ...(colors ?? {}) } });
}

function remove() {
  const t = current.value;
  if (t.builtin || !window.confirm(`Supprimer le thème « ${t.name} » ?`)) return;
  appearance.deleteTheme(t.id);
}

const readability = computed(() => {
  const bg = parseHex(current.value.colors.bg);
  const text = parseHex(current.value.colors.text);
  return bg && text ? contrast(bg, text) : 21;
});

async function copyTheme() {
  try {
    await navigator.clipboard.writeText(themeFile(current.value));
    ui.notify("Thème copié dans le presse-papiers");
  } catch {
    ui.notify("Copie impossible sur cet appareil");
  }
}
async function pasteTheme() {
  try {
    importTheme(await navigator.clipboard.readText());
  } catch {
    ui.notify("Lecture du presse-papiers impossible : importez plutôt un fichier");
  }
}
function importTheme(text: string) {
  const theme = parseThemeFile(text);
  if (!theme) {
    ui.notify("Ce n'est pas un thème valide");
    return;
  }
  appearance.saveTheme(theme);
  ui.notify(`Thème « ${theme.name} » ajouté`);
}
async function onThemeFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) importTheme(await file.text());
}

function resetAll() {
  if (!window.confirm("Revenir à l'apparence d'origine (thème Nuit bleue, polices du système) ? Vos thèmes créés et polices importées sont conservés.")) return;
  appearance.reset();
}

const COLOR_FIELDS: { key: keyof Theme["colors"]; label: string }[] = [
  { key: "bg", label: "Fond" },
  { key: "surface", label: "Surfaces" },
  { key: "text", label: "Texte" },
  { key: "accent", label: "Accent" },
  { key: "accent2", label: "Halo" },
];
</script>

<template>
  <div class="page appearance">
    <div class="head">
      <h1 class="page-title">Personnalisation</h1>
      <button type="button" class="pill pill-ghost" @click="resetAll">Réinitialiser</button>
    </div>

    <section class="card">
      <h2>Thème</h2>
      <div class="themes">
        <button
          v-for="t in appearance.themes"
          :key="t.id"
          type="button"
          class="theme"
          :class="{ on: t.id === s.themeId }"
          :aria-pressed="t.id === s.themeId"
          @click="appearance.selectTheme(t.id)"
        >
          <span class="mock" :style="preview(t)">
            <span class="mock-side" :style="{ background: t.colors.surface }" />
            <span class="mock-body">
              <span class="mock-title" :style="{ fontFamily: appearance.fontStackFor(t.fonts?.display) }">Aa</span>
              <span class="mock-line" :style="{ background: t.colors.text }" />
              <span class="mock-line short" :style="{ background: t.colors.text }" />
              <span class="mock-pill" :style="{ background: t.colors.accent }" />
            </span>
          </span>
          <span class="theme-name">
            <Icon v-if="t.id === s.themeId" name="check" :size="13" class="tick" />
            {{ t.name }}
          </span>
        </button>
      </div>

      <div v-if="suggested" class="suggest">
        <span>Polices de ce thème : <strong>{{ suggested }}</strong></span>
        <button type="button" class="link" @click="appearance.selectTheme(s.themeId, true)">Les utiliser</button>
      </div>

      <div class="actions">
        <button type="button" class="pill pill-accent" @click="customize"><Icon name="brush" :size="15" /> {{ current.builtin ? "Personnaliser ce thème" : "Dupliquer" }}</button>
        <button type="button" class="pill pill-ghost" @click="themeInput?.click()">Importer un thème</button>
        <button type="button" class="pill pill-ghost" @click="pasteTheme">Coller un thème</button>
        <button type="button" class="pill pill-ghost" @click="copyTheme">Copier ce thème</button>
        <input ref="themeInput" type="file" :accept="themeAccept" hidden @change="onThemeFile" />
      </div>
    </section>

    <section v-if="editable" class="card">
      <h2>Modifier « {{ current.name }} »</h2>
      <label class="field">
        <span>Nom</span>
        <input :value="current.name" maxlength="40" @change="update({ name: ($event.target as HTMLInputElement).value.trim() || current.name })" />
      </label>
      <div class="colors">
        <label v-for="f in COLOR_FIELDS" :key="f.key" class="color">
          <input
            type="color"
            :value="current.colors[f.key] ?? current.colors.accent"
            :aria-label="f.label"
            @input="update({}, { [f.key]: ($event.target as HTMLInputElement).value })"
          />
          <span>{{ f.label }}</span>
        </label>
      </div>
      <p v-if="readability < 4.5" class="warn">Texte peu lisible sur ce fond (contraste {{ readability.toFixed(1) }} : 4,5 conseillé).</p>
      <label class="slider">
        <span>Arrondi des coins <em>{{ current.radius }} px</em></span>
        <input type="range" min="0" max="20" :value="current.radius" @input="update({ radius: +($event.target as HTMLInputElement).value })" />
      </label>
      <label class="slider">
        <span>Halos et lueurs <em>{{ Math.round(current.glow * 100) }} %</em></span>
        <input type="range" min="0" max="100" :value="Math.round(current.glow * 100)" @input="update({ glow: +($event.target as HTMLInputElement).value / 100 })" />
      </label>
      <div class="actions">
        <button type="button" class="pill pill-ghost danger" @click="remove"><Icon name="trash" :size="15" /> Supprimer ce thème</button>
      </div>
    </section>

    <section class="card">
      <h2>Polices</h2>
      <div v-for="r in ROLES" :key="r.role" class="role">
        <button type="button" class="role-head" :aria-expanded="openRole === r.role" @click="openRole = openRole === r.role ? null : r.role">
          <span class="role-text">
            <span class="role-label">{{ r.label }}</span>
            <span class="role-hint">{{ r.hint }}</span>
          </span>
          <span class="role-value" :style="{ fontFamily: appearance.fontStackFor(s.fonts[r.role], r.role === 'ui' ? 'ui' : 'display') }">{{ fontLabel(s.fonts[r.role]) }}</span>
          <span class="chev" :class="{ open: openRole === r.role }">›</span>
        </button>
        <FontPicker
          v-if="openRole === r.role"
          :model-value="s.fonts[r.role]"
          :decorative="r.decorative"
          :sample="r.sample"
          @update:model-value="(id) => appearance.setFont(r.role, id)"
        />
      </div>
    </section>

    <section class="card">
      <h2>Paroles et couleurs</h2>
      <label class="slider">
        <span>Taille des paroles <em>{{ Math.round(s.lyricsScale * 100) }} %</em></span>
        <input type="range" min="80" max="140" step="5" :value="Math.round(s.lyricsScale * 100)" @input="s.lyricsScale = +($event.target as HTMLInputElement).value / 100; appearance.changed()" />
      </label>
      <p class="lyrics-preview" :style="{ fontSize: `calc(22px * ${s.lyricsScale})` }">Sous les néons de la ville</p>
      <label class="toggle">
        <input type="checkbox" :checked="s.followArtwork" @change="s.followArtwork = ($event.target as HTMLInputElement).checked; appearance.changed()" />
        <span>
          Couleur d'accent tirée de la pochette en cours
          <small>Boutons et curseurs prennent la teinte du morceau qui joue.</small>
        </span>
      </label>
      <p v-if="appearance.saveError" class="warn">Enregistrement impossible : {{ appearance.saveError }}</p>
    </section>

    <p class="muted foot">{{ BUILTIN_THEMES.length }} thèmes fournis, 73 polices libres de droits livrées avec l'application (hors ligne).</p>
  </div>
</template>

<style scoped>
.appearance {
  max-width: 880px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.card {
  margin-bottom: 16px;
  padding: 18px 20px;
  border-radius: 12px;
  background: rgba(var(--fg-rgb), 0.04);
  box-shadow: inset 0 0 0 0.5px var(--separator);
}
h2 {
  margin: 0 0 14px;
  font-size: 15px;
}
.themes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 12px;
}
.theme {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px;
  border: 0;
  border-radius: 12px;
  background: none;
  text-align: left;
  -webkit-tap-highlight-color: transparent;
}
.theme:hover {
  background: rgba(var(--fg-rgb), 0.05);
}
.theme.on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px var(--accent);
}
.mock {
  display: flex;
  height: 78px;
  overflow: hidden;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3), inset 0 0 0 0.5px rgba(128, 128, 128, 0.3);
}
.mock-side {
  width: 24%;
}
.mock-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px;
}
.mock-title {
  font-size: 17px;
  font-weight: 800;
  line-height: 1;
}
.mock-line {
  height: 4px;
  width: 80%;
  border-radius: 2px;
  opacity: 0.5;
}
.mock-line.short {
  width: 50%;
  opacity: 0.3;
}
.mock-pill {
  margin-top: auto;
  width: 46%;
  height: 10px;
  border-radius: 5px;
}
.theme-name {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  padding: 0 2px 2px;
}
.tick {
  color: var(--accent);
}
.suggest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--accent-soft);
  font-size: 13px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.link {
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  font-weight: 600;
}
.danger {
  color: #ff6b7d;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 320px;
  margin-bottom: 14px;
}
.field span,
.slider span {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.field input {
  height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: rgba(var(--fg-rgb), 0.08);
  color: var(--text);
  outline: none;
}
.field input:focus {
  box-shadow: 0 0 0 2px var(--accent);
}
.colors {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 12px;
}
.color {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.color input {
  width: 52px;
  height: 52px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  cursor: pointer;
}
.color input::-webkit-color-swatch-wrapper {
  padding: 0;
}
.color input::-webkit-color-swatch {
  border: 2px solid rgba(var(--fg-rgb), 0.25);
  border-radius: 50%;
}
.warn {
  margin: 6px 0 10px;
  font-size: 12.5px;
  color: #ffb454;
}
.slider {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 420px;
  margin: 12px 0;
}
.slider em {
  font-style: normal;
  color: var(--text-3);
  margin-left: 6px;
}
.slider input {
  accent-color: var(--accent);
}
.role + .role {
  border-top: 1px solid var(--separator);
}
.role {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0 10px;
}
.role-head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 0 0;
  border: 0;
  background: none;
  text-align: left;
}
.role-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.role-label {
  font-weight: 600;
}
.role-hint {
  font-size: 12px;
  color: var(--text-3);
}
.role-value {
  font-size: 17px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 50%;
}
.chev {
  font-size: 20px;
  color: var(--text-3);
  transition: transform 0.2s;
}
.chev.open {
  transform: rotate(90deg);
}
.lyrics-preview {
  margin: 4px 0 16px;
  font-family: var(--font-lyrics);
  font-weight: 800;
  color: var(--text);
  line-height: 1.2;
}
.toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.toggle input {
  margin-top: 3px;
  accent-color: var(--accent);
  width: 18px;
  height: 18px;
}
.toggle small {
  display: block;
  font-size: 12px;
  color: var(--text-3);
}
.foot {
  margin: 8px 0 24px;
  font-size: 12px;
}
@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .themes {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .actions .pill {
    flex: 1 1 auto;
  }
}
</style>
