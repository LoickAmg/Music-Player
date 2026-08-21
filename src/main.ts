import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./style.css";

async function bootstrap() {
  // Ne charge le mock que hors du webview Tauri, en dev (voir tauriMock.ts) :
  // `import.meta.env.DEV` est résolu statiquement par Vite, donc cette
  // branche entière est éliminée du bundle de production.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installTauriMock } = await import("./lib/tauriMock");
    installTauriMock();
  }

  createApp(App).use(createPinia()).mount("#app");
}

void bootstrap();
