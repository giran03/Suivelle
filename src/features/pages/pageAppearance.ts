import { create } from "zustand";
import { isIconName, type IconName } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import type { Page } from "../../types";

/**
 * A page's `icon` and `cover` are plain strings in the database:
 *   icon:  "🚀" (an emoji), "icon:star" (a built-in line icon), or "image:<attachment hash>"
 *   cover: "gradient:dusk" (a preset) or "image:<attachment hash>" (an uploaded picture)
 * An empty string means "none", because the backend treats a missing field as "leave unchanged".
 */
export type Glyph = { kind: "emoji"; value: string } | { kind: "icon"; name: IconName } | { kind: "image"; hash: string };
export type Cover = { kind: "gradient"; id: string } | { kind: "image"; hash: string };

export function parseIcon(icon: string | null | undefined): Glyph | null {
  if (!icon) return null;
  if (icon.startsWith("image:")) {
    const hash = icon.slice(6);
    return /^[a-f0-9]{64}$/.test(hash) ? { kind: "image", hash } : null;
  }
  if (icon.startsWith("icon:")) {
    const name = icon.slice(5);
    return isIconName(name) ? { kind: "icon", name } : null;
  }
  return { kind: "emoji", value: icon };
}

export const GRADIENTS = [
  { id: "dusk", name: "Dusk", css: "linear-gradient(120deg, #2b2358 0%, #5a45b8 100%)" },
  { id: "tide", name: "Tide", css: "linear-gradient(120deg, #123a4a 0%, #2f7f93 100%)" },
  { id: "moss", name: "Moss", css: "linear-gradient(120deg, #173627 0%, #45805c 100%)" },
  { id: "ember", name: "Ember", css: "linear-gradient(120deg, #4a2417 0%, #b5643c 100%)" },
  { id: "rose", name: "Rose", css: "linear-gradient(120deg, #4a1f3a 0%, #b4577f 100%)" },
  { id: "slate", name: "Slate", css: "linear-gradient(120deg, #1d2029 0%, #4a5163 100%)" },
  { id: "sand", name: "Sand", css: "linear-gradient(120deg, #4a4030 0%, #b9a47c 100%)" },
  { id: "ink", name: "Ink", css: "linear-gradient(120deg, #0b0c10 0%, #262a38 100%)" },
] as const;

export function parseCover(cover: string | null | undefined): Cover | null {
  if (!cover) return null;
  if (cover.startsWith("gradient:")) {
    const id = cover.slice(9);
    return GRADIENTS.some((g) => g.id === id) ? { kind: "gradient", id } : null;
  }
  if (cover.startsWith("image:")) return { kind: "image", hash: cover.slice(6) };
  return null;
}

export const gradientCss = (id: string) => GRADIENTS.find((g) => g.id === id)?.css ?? GRADIENTS[0].css;

/** Saves a page's icon and/or cover (null clears) and mirrors the result into the workspace store. */
export async function setAppearance(page: Page, patch: { icon?: string | null; cover?: string | null }) {
  try {
    const updated = await ipc.pageUpdate({
      id: page.id,
      ...(patch.icon !== undefined ? { icon: patch.icon ?? "" } : {}),
      ...(patch.cover !== undefined ? { cover: patch.cover ?? "" } : {}),
    });
    const apply = (p: Page) => (p.id === page.id ? { ...p, icon: updated.icon, cover: updated.cover, revision: updated.revision } : p);
    useWorkspace.setState((s) => ({
      children: Object.fromEntries(Object.entries(s.children).map(([k, v]) => [k, v.map(apply)])),
      favorites: s.favorites.map(apply),
      ancestors: s.ancestors.map(apply),
      selectedPage: s.selectedPage?.id === page.id ? { ...s.selectedPage, icon: updated.icon, cover: updated.cover, revision: updated.revision } : s.selectedPage,
      pageTitles: s.pageTitles[page.id] ? { ...s.pageTitles, [page.id]: { ...s.pageTitles[page.id], icon: updated.icon } } : s.pageTitles,
    }));
    return true;
  } catch (e) {
    useWorkspace.getState().setError(toAppError(e).message);
    return false;
  }
}

/** Lets the palette (and the header buttons) ask the page header to open a picker. */
interface AppearanceUi {
  open: "icon" | "cover" | null;
  show: (kind: "icon" | "cover") => void;
  hide: () => void;
}

export const useAppearanceUi = create<AppearanceUi>((set) => ({
  open: null,
  show: (open) => set({ open }),
  hide: () => set({ open: null }),
}));

export const LINE_ICONS: IconName[] = [
  "page", "text", "bullet", "todo", "quote", "code", "table", "dashboard", "chart", "calendar", "clock", "star",
  "tag", "hash", "link", "mail", "phone", "image", "video", "audio", "note", "tip", "warning", "bolt",
  "layers", "columns", "timeline", "feed", "form", "function", "sigma", "filter", "eye", "play", "download", "duplicate",
];
