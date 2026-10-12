import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Polices de la personnalisation (@fontsource) : chaque @font-face cite un .woff2 puis un
// .woff de secours, inutile ici (toutes les vues web lisent le woff2). On retire le secours
// pour ne pas livrer chaque police en double (environ 2,5 Mo d'économisés).
const woff2Only = {
  name: "fontsource-woff2-only",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.includes("@fontsource") || !id.endsWith(".css")) return null;
    return code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, "");
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [woff2Only, vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
