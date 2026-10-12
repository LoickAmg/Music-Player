import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { applyCachedAppearance } from "./stores/appearance";
import "./style.css";

async function bootstrap() {
  // Le mock n'est chargé qu'en dev hors du webview Tauri : `import.meta.env.DEV` est résolu
  // statiquement par Vite, cette branche disparaît donc du bundle de production.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installTauriMock } = await import("./lib/tauriMock");
    installTauriMock();
  }

  // Thème du dernier lancement posé avant le premier rendu (pas d'éclair de couleurs).
  applyCachedAppearance();
  createApp(App).use(createPinia()).mount("#app");
}

void bootstrap();
