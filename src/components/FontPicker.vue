<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { FONT_CATEGORIES, FONTS, type FontCategory } from "@/lib/fontCatalog";
import { probeFontFile, SYSTEM_FONT } from "@/lib/fonts";
import { useAppearanceStore } from "@/stores/appearance";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// Choix d'une police : catégories (Simples, Cyber, Espace, Japonais…), recherche, aperçu de
// chaque police dans sa propre typographie (chargée quand elle apparaît à l'écran), polices
// importées par l'utilisateur.
const props = withDefaults(
  defineProps<{
    modelValue: string | null | undefined;
    /** Inclure les polices décoratives (titres, paroles, jaquettes). */
    decorative?: boolean;
    /** Texte des aperçus. */
    sample?: string;
    /** Libellé du choix « par défaut ». */
    systemLabel?: string;
  }>(),
  { decorative: true, sample: "Aa Bonjour 123", systemLabel: "Police du système" },
);
const emit = defineEmits<{ (e: "update:modelValue", id: string): void }>();

const appearance = useAppearanceStore();
const ui = useUiStore();
const category = ref<FontCategory | "all" | "mine">("all");
const query = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const list = ref<HTMLElement | null>(null);
// Android : pas de filtre par extension (une police téléchargée y a souvent un type de
// fichier générique et serait grisée) ; le fichier est vérifié après coup.
const fontAccept = /Android/i.test(navigator.userAgent) ? undefined : ".ttf,.otf,.woff,.woff2,font/*";

type Item = { id: string; label: string; tag?: string };

const items = computed<Item[]>(() => {
  const q = query.value.trim().toLowerCase();
  const mine: Item[] = appearance.settings.customFonts.map((f) => ({ id: f.id, label: f.label, tag: "Importée" }));
  const catalog: Item[] = FONTS.filter((f) => props.decorative || !f.displayOnly)
    .filter((f) => category.value === "all" || f.category === category.value)
    .map((f) => ({ id: f.id, label: f.label, tag: f.displayOnly ? "Titres" : undefined }));
  let out: Item[] =
    category.value === "mine" ? mine : category.value === "all" ? [{ id: SYSTEM_FONT, label: props.systemLabel }, ...mine, ...catalog] : catalog;
  if (q) out = out.filter((i) => i.label.toLowerCase().includes(q));
  return out;
});

// Aperçus chargés à l'apparition à l'écran : jamais 73 polices d'un coup. (Observateur
// créé tout de suite : les premières cartes s'enregistrent avant le montage.)
const observer =
  typeof IntersectionObserver === "undefined"
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            void appearance.loadFont((e.target as HTMLElement).dataset.font);
            observer?.unobserve(e.target);
          }
        },
        { rootMargin: "120px" },
      );
function observe(el: Element | null, id: string) {
  if (!el) return;
  if (!observer) {
    void appearance.loadFont(id);
    return;
  }
  (el as HTMLElement).dataset.font = id;
  observer.observe(el);
}
onBeforeUnmount(() => observer?.disconnect());
watch([category, query], () => {
  if (list.value) list.value.scrollTop = 0;
});

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  importing.value = true;
  try {
    if (!(await probeFontFile(file))) {
      ui.notify("Ce fichier n'est pas une police lisible (.ttf, .otf, .woff, .woff2).");
      return;
    }
    const id = await appearance.importFont(file);
    category.value = "mine";
    emit("update:modelValue", id);
    ui.notify(`Police « ${file.name} » importée`);
  } catch (e) {
    ui.notify(`Import impossible : ${e}`);
  } finally {
    importing.value = false;
  }
}

async function remove(id: string) {
  if (!window.confirm("Supprimer cette police importée ?")) return;
  await appearance.removeCustomFont(id);
  if (props.modelValue === id) emit("update:modelValue", SYSTEM_FONT);
}
</script>

<template>
  <div class="font-picker">
    <div class="bar">
      <label class="search">
        <Icon name="search" :size="15" />
        <input v-model="query" type="search" placeholder="Chercher une police" aria-label="Chercher une police" />
      </label>
      <button type="button" class="pill pill-ghost small" :disabled="importing" @click="fileInput?.click()">
        <Icon name="plus" :size="14" /> {{ importing ? "Import…" : "Importer" }}
      </button>
      <input ref="fileInput" type="file" :accept="fontAccept" hidden @change="onFile" />
    </div>
    <div class="cats" role="tablist">
      <button type="button" role="tab" :class="{ on: category === 'all' }" @click="category = 'all'">Toutes</button>
      <button v-for="c in FONT_CATEGORIES" :key="c.id" type="button" role="tab" :class="{ on: category === c.id }" @click="category = c.id">{{ c.label }}</button>
      <button v-if="appearance.settings.customFonts.length" type="button" role="tab" :class="{ on: category === 'mine' }" @click="category = 'mine'">Mes polices</button>
    </div>
    <div ref="list" class="grid">
      <p v-if="!items.length" class="empty muted">Aucune police trouvée.</p>
      <div
        v-for="item in items"
        :key="item.id"
        :ref="(el) => observe(el as Element | null, item.id)"
        class="font"
        :class="{ on: (modelValue ?? SYSTEM_FONT) === item.id }"
        role="button"
        tabindex="0"
        :aria-pressed="(modelValue ?? SYSTEM_FONT) === item.id"
        @click="emit('update:modelValue', item.id)"
        @keydown.enter.prevent="emit('update:modelValue', item.id)"
        @keydown.space.prevent="emit('update:modelValue', item.id)"
      >
        <span class="sample" :style="{ fontFamily: appearance.fontStackFor(item.id) }">{{ sample }}</span>
        <span class="name">
          {{ item.label }}
          <em v-if="item.tag" class="tag">{{ item.tag }}</em>
        </span>
        <button v-if="item.id.startsWith('custom:')" type="button" class="del" aria-label="Supprimer cette police" @click.stop="remove(item.id)">
          <Icon name="trash" :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.font-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.bar {
  display: flex;
  gap: 8px;
}
.search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 10px;
  border-radius: 9px;
  background: rgba(var(--fg-rgb), 0.07);
  color: var(--text-2);
}
.search:focus-within {
  box-shadow: 0 0 0 2px var(--accent);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  outline: none;
  color: var(--text);
  font-size: 14px;
}
.pill.small {
  height: 36px;
  padding: 0 12px;
  font-size: 13px;
}
.cats {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}
.cats::-webkit-scrollbar {
  display: none;
}
.cats button {
  flex: none;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 15px;
  background: rgba(var(--fg-rgb), 0.07);
  font-size: 12.5px;
  color: var(--text-2);
}
.cats button.on {
  background: var(--accent);
  color: var(--on-accent);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  max-height: 340px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 2px;
}
.empty {
  grid-column: 1 / -1;
  text-align: center;
  padding: 20px;
}
.font {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 12px;
  border-radius: 10px;
  background: rgba(var(--fg-rgb), 0.05);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.font:hover {
  background: rgba(var(--fg-rgb), 0.09);
}
.font.on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px var(--accent);
}
.sample {
  font-size: 20px;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
.name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag {
  flex: none;
  padding: 0 6px;
  border-radius: 6px;
  background: rgba(var(--fg-rgb), 0.08);
  font-style: normal;
  font-size: 10.5px;
}
.del {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 50%;
  background: rgba(var(--fg-rgb), 0.08);
  color: var(--text-2);
}
@media (max-width: 760px), (pointer: coarse) and (max-width: 1100px) {
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-height: 50vh;
  }
  .sample {
    font-size: 18px;
  }
}
</style>
