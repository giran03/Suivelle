import { create } from "zustand";
import { emptyTheme, sanitizeTheme, type ThemeConfig, type ThemeProfile } from "./theme";
import type { ThemeSetting } from "../../types";

const KEY = "suivelle.themes.v1";
function read(): { config: ThemeConfig; profiles: ThemeProfile[] } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { config: sanitizeTheme(raw.config), profiles: Array.isArray(raw.profiles) ? raw.profiles.slice(0, 100).filter((p: ThemeProfile) => p && typeof p.id === "string" && typeof p.name === "string").map((p: ThemeProfile) => ({ id: p.id, name: p.name.slice(0, 80), config: sanitizeTheme(p.config) })) : [] };
  } catch { return { config: emptyTheme(), profiles: [] }; }
}
interface ThemeState {
  config: ThemeConfig;
  profiles: ThemeProfile[];
  preview: ThemeConfig | null;
  previewMode: ThemeSetting | null;
  setPreview: (preview: ThemeConfig | null, mode?: ThemeSetting | null) => void;
  apply: (config: ThemeConfig) => void;
  saveProfile: (name: string, config: ThemeConfig) => string;
  deleteProfile: (id: string) => void;
}
export const useThemes = create<ThemeState>((set, get) => {
  const persist = (config: ThemeConfig, profiles: ThemeProfile[]) => {
    // Save before changing committed state: a failed write leaves the draft available to retry/export.
    localStorage.setItem(KEY, JSON.stringify({ config, profiles }));
    set({ config, profiles });
  };
  return {
    ...read(), preview: null, previewMode: null,
    setPreview: (preview, mode = null) => set({ preview, previewMode: preview ? mode : null }),
    apply: (config) => { persist(sanitizeTheme(config), get().profiles); set({ preview: null, previewMode: null }); },
    saveProfile: (name, config) => {
      if (!name.trim()) throw new Error("Give this theme a name.");
      if (get().profiles.length >= 100) throw new Error("Remove a saved theme before adding another (limit: 100).");
      const id = crypto.randomUUID();
      persist(get().config, [...get().profiles, { id, name: name.trim().slice(0, 80), config: sanitizeTheme(config) }]);
      return id;
    },
    deleteProfile: (id) => persist(get().config, get().profiles.filter((p) => p.id !== id)),
  };
});
