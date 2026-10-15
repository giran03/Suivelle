import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// WebView2 always loads KaTeX's woff2 fonts, so the woff and ttf fallbacks only add weight to the installer.
const katexWoff2Only: Plugin = {
  name: "katex-woff2-only",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css/.test(id)) return;
    return code.replace(/,\s*url\([^)]+\.woff\)\s*format\("woff"\)\s*,\s*url\([^)]+\.ttf\)\s*format\("truetype"\)/g, "");
  },
};

export default defineConfig({
  plugins: [react(), katexWoff2Only],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: { port: 1430, strictPort: true },
  test: { environment: "node" },
});
