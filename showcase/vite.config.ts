import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import pkg from "../package.json" with { type: "json" };

// The real Suivelle frontend, with the Tauri bridge swapped for an in-memory mock backend.
// It builds into showcase/dist/demo, under the public site built by showcase/site/vite.config.ts.
export default defineConfig({
  root: __dirname,
  publicDir: path.resolve(__dirname, "../public"),
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), "import.meta.env.VITE_SHOWCASE_READ_ONLY": JSON.stringify("true") },
  resolve: { alias: { "@tauri-apps/api/core": path.resolve(__dirname, "mock/tauri-core.ts") } },
  server: { port: 1488, strictPort: true, fs: { allow: [path.resolve(__dirname, "..")] } },
  build: { outDir: path.resolve(__dirname, "dist/demo"), emptyOutDir: true, rollupOptions: { input: path.resolve(__dirname, "index.html") } },
  base: "./",
  clearScreen: false,
});
