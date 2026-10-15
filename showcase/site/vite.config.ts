import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { wikiLayout } from "./layout.mjs";

// The public site: home page and wiki. It builds into showcase/dist; the read-only demo app
// (showcase/vite.config.ts) builds afterwards into showcase/dist/demo.
const wiki = fs.readdirSync(path.resolve(import.meta.dirname, "wiki")).filter(f => f.endsWith(".html"));

export default defineConfig({
  root: import.meta.dirname,
  publicDir: path.resolve(import.meta.dirname, "public"),
  plugins: [wikiLayout()],
  base: "./",
  server: { port: 1490, strictPort: true, fs: { allow: [path.resolve(import.meta.dirname, "../..")] } },
  preview: { port: 1490 },
  build: {
    outDir: path.resolve(import.meta.dirname, "../dist"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        home: path.resolve(import.meta.dirname, "index.html"),
        ...Object.fromEntries(wiki.map(f => [`wiki-${f.slice(0, -5)}`, path.resolve(import.meta.dirname, "wiki", f)])),
      },
    },
  },
  clearScreen: false,
});
