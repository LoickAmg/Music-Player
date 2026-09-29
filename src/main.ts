import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./style.css";

async function bootstrap() {
  // Le mock n'est chargé qu'en dev hors du webview Tauri : `import.meta.env.DEV` est résolu
  // statiquement par Vite, cette branche disparaît donc du bundle de production.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installTauriMock } = await import("./lib/tauriMock");
    installTauriMock();
  }

  createApp(App).use(createPinia()).mount("#app");
}

void bootstrap();
