import { useEffect, useState } from "react";
import { rgbToHex } from "../../lib/color";
import { NODE_COLORS } from "./model";
import { analogousPalette } from "./colors";

export function useNodePalette() {
  const [palettes, setPalettes] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const probe = document.createElement("span"); probe.hidden = true; document.body.append(probe);
    const update = () => {
      const bases: Record<string, string> = {};
      for (const [kind, token] of Object.entries(NODE_COLORS)) {
        probe.style.color = `var(${token})`;
        const rgb = getComputedStyle(probe).color.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
        if (rgb) bases[kind] = rgbToHex(rgb.slice(1, 4).map(Number));
      }
      // Each family's spread depends on the others, so the theme's tones decide how wide every fan can be.
      const all = Object.values(bases);
      const next = Object.fromEntries(Object.entries(bases).map(([kind, base]) => [kind, analogousPalette(base, all)]));
      setPalettes(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    const scheme = matchMedia("(prefers-color-scheme: dark)"); scheme.addEventListener("change", update);
    update();
    return () => { observer.disconnect(); scheme.removeEventListener("change", update); probe.remove(); };
  }, []);
  return palettes;
}
