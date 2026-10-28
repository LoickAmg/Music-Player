<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { loadImage } from "@/lib/imageCrop";
import { relay, relayBase } from "@/lib/friendsApi";
import { useShareStore } from "@/stores/share";
import { useUiStore } from "@/stores/ui";
import Icon from "./Icon.vue";

// « Un avis ? » : problème, suggestion, idée… gardé par le relais de l'appli (avec jusqu'à 3
// captures d'écran) et lu par le développeur dans « Avis reçus », qui en est notifié.
const KINDS = [
  { id: "bug", label: "Un problème", hint: "Quelque chose ne marche pas" },
  { id: "suggestion", label: "Suggestion", hint: "Une amélioration, un réglage" },
  { id: "idee", label: "Une idée", hint: "Une envie, une nouveauté" },
  { id: "avis", label: "Mon avis", hint: "Ce que vous aimez (ou pas)" },
  { id: "autre", label: "Autre", hint: "Tout le reste" },
] as const;
const MAX = 3000;
const MAX_IMAGES = 3;

const ui = useUiStore();
const share = useShareStore();
const kind = ref<string>("bug");
const message = ref("");
const name = ref("");
const contact = ref("");
const images = ref<{ url: string; type: string; data: string }[]>([]);
const sending = ref(false);
const error = ref<string | null>(null);
const sent = ref(false);
/** Écran d'où l'avis est envoyé (joint automatiquement). */
const screen = ref("");

watch(
  () => ui.feedback,
  (open) => {
    if (!open) return;
    screen.value = ui.route.name;
    sent.value = false;
    error.value = null;
  },
);

const platform = computed(() => {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac/i.test(ua)) return "macOS";
  return "Linux";
});

async function appVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "";
  }
}

/** Capture réduite (1 600 px au plus, JPEG) : légère à envoyer, lisible à l'écran. */
async function shrink(file: File): Promise<{ url: string; type: string; data: string }> {
  const src = URL.createObjectURL(file);
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.82);
    return { url, type: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
  } finally {
    URL.revokeObjectURL(src);
  }
}

async function addImages(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])].filter((f) => f.type.startsWith("image/"));
  input.value = "";
  for (const file of files.slice(0, MAX_IMAGES - images.value.length)) {
    try {
      images.value.push(await shrink(file));
    } catch {
      error.value = `« ${file.name} » n'est pas une image lisible.`;
    }
  }
}

async function send() {
  error.value = null;
  if (message.value.trim().length < 5) {
    error.value = "Écrivez au moins quelques mots.";
    return;
  }
  const base = share.relayInUse ? relayBase(share.relayInUse) : null;
  if (!base) {
    error.value = "Aucun relais configuré (Réglages → Partage).";
    return;
  }
  sending.value = true;
  try {
    await relay.sendAvis(base, {
      kind: kind.value,
      message: message.value,
      name: name.value,
      contact: contact.value,
      screen: screen.value,
      version: await appVersion(),
      platform: platform.value,
      images: images.value.map(({ type, data }) => ({ type, data })),
    });
    sent.value = true;
    message.value = "";
    images.value = [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <Transition name="dialog">
    <div v-if="ui.feedback" class="scrim" @click.self="ui.feedback = false">
      <section class="card" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <header>
          <div>
            <p class="kicker">Un avis ?</p>
            <h2 id="feedback-title">{{ sent ? "Merci !" : "Votre retour sur Music Player" }}</h2>
          </div>
          <button type="button" class="icon-btn" aria-label="Fermer" @click="ui.feedback = false"><Icon name="close" :size="18" /></button>
        </header>

        <div v-if="sent" class="done" role="status">
          <Icon name="check" :size="28" />
          <p>Votre retour est bien arrivé : il sera lu avec attention. Chaque retour aide Music Player à grandir.</p>
          <button type="button" class="pill pill-ghost" @click="sent = false">Envoyer un autre retour</button>
        </div>

        <form v-else class="form" novalidate @submit.prevent="send">
          <fieldset>
            <legend>C'est plutôt…</legend>
            <div class="kinds">
              <label v-for="k in KINDS" :key="k.id" class="kind" :class="{ on: kind === k.id }">
                <input v-model="kind" type="radio" name="kind" :value="k.id" />
                <span class="kind-label">{{ k.label }}</span>
                <span class="kind-hint">{{ k.hint }}</span>
              </label>
            </div>
          </fieldset>

          <label class="field">
            <span>Votre message</span>
            <textarea
              v-model="message"
              class="fieldbox"
              rows="5"
              :maxlength="MAX"
              placeholder="Ce qui vous a plu, ce qui vous a gêné, ce qui manque… Pour un problème : ce que vous faisiez et ce qui s'est passé."
            />
            <small class="counter">{{ message.length }} / {{ MAX }}</small>
          </label>

          <div class="field">
            <span>Captures d'écran (facultatif, {{ MAX_IMAGES }} au plus)</span>
            <div class="shots">
              <div v-for="(img, i) in images" :key="i" class="shot">
                <img :src="img.url" alt="" />
                <button type="button" class="remove" :aria-label="`Retirer la capture ${i + 1}`" @click="images.splice(i, 1)">
                  <Icon name="close" :size="13" />
                </button>
              </div>
              <label v-if="images.length < MAX_IMAGES" class="add-shot">
                <Icon name="image" :size="20" />
                <span>Ajouter</span>
                <input type="file" accept="image/*" multiple @change="addImages" />
              </label>
            </div>
          </div>

          <div class="two">
            <label class="field">
              <span>Votre nom (facultatif)</span>
              <input v-model="name" class="fieldbox" maxlength="60" autocomplete="name" />
            </label>
            <label class="field">
              <span>E-mail pour une réponse (facultatif)</span>
              <input v-model="contact" class="fieldbox" type="email" maxlength="160" autocomplete="email" />
            </label>
          </div>

          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <div class="foot">
            <p class="muted small">Sans e-mail, votre retour reste anonyme. L'écran actuel et la version de l'appli sont joints.</p>
            <button type="submit" class="pill pill-accent" :disabled="sending">{{ sending ? "Envoi…" : "Envoyer mon retour" }}</button>
          </div>
        </form>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: calc(var(--safe-top) + 16px) calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 16px)
    calc(var(--safe-left) + 16px);
  background: rgba(2, 6, 20, 0.6);
}
.card {
  width: min(100%, 520px);
  max-height: 100%;
  overflow-y: auto;
  padding: 20px 20px 16px;
  border-radius: 18px;
  background: rgba(var(--surface-rgb), 0.98);
  box-shadow: var(--shadow), inset 0 0 0 0.5px rgba(var(--fg-rgb), 0.12);
  color: var(--text);
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.kicker {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
h2 {
  margin: 2px 0 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
}
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
fieldset {
  margin: 0;
  padding: 0;
  border: 0;
}
legend,
.field > span {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
}
.kinds {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-2);
}
.kind {
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: rgba(var(--fg-rgb), 0.05);
  box-shadow: inset 0 0 0 1px rgba(var(--fg-rgb), 0.08);
  cursor: pointer;
}
.kind.on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}
.kind input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.kind-label {
  font-size: 13px;
  font-weight: 600;
}
.kind-hint {
  font-size: 11.5px;
  color: var(--text-2);
}
.field {
  display: flex;
  flex-direction: column;
}
.field textarea,
.field input {
  padding: 9px 11px;
  border: 0;
  border-radius: var(--radius-sm);
  background: rgba(var(--fg-rgb), 0.07);
  font-size: 14px;
  line-height: 1.5;
  user-select: text;
}
.field textarea {
  resize: vertical;
}
.counter {
  align-self: flex-end;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-3);
}
.shots {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.shot,
.add-shot {
  position: relative;
  width: 76px;
  height: 76px;
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.shot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.remove {
  position: absolute;
  top: 3px;
  right: 3px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
}
.add-shot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1.5px dashed rgba(var(--fg-rgb), 0.25);
  color: var(--text-2);
  font-size: 11.5px;
  cursor: pointer;
}
.add-shot input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
@media (max-width: 480px) {
  .two {
    grid-template-columns: 1fr;
  }
}
.error {
  margin: 0;
  color: var(--danger-text);
  font-size: 13px;
}
.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.small {
  margin: 0;
  max-width: 260px;
  font-size: 11.5px;
}
.done {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) 0;
  text-align: center;
  color: var(--success);
}
.done p {
  margin: 0;
  max-width: 340px;
  color: var(--text-2);
  line-height: 1.5;
}
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity 0.2s ease;
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
</style>
