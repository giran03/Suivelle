import "../../lib/legacy";
import type { Workspace, WorkspaceColor } from "../../types";
import { normalizeHex } from "../../lib/color";
export const WORKSPACE_COLORS: WorkspaceColor[] = ["violet", "gray", "blue", "green", "orange", "red"];
export const WORKSPACE_SYMBOLS = ["page", "layers", "table", "dashboard", "code", "star", "todo", "calendar", "image", "note", "hash", "tag"] as const;
export function workspaceOptions(workspace: Pick<Workspace, "settingsJson"> | null) {
  let value: Record<string, unknown> = {};
  try { const json = JSON.parse(workspace?.settingsJson ?? "{}"); if (json && typeof json === "object" && !Array.isArray(json)) value = json; } catch { /* Legacy defaults. */ }
  const accent: WorkspaceColor = normalizeHex(value.accent) ?? (WORKSPACE_COLORS.includes(value.accent as WorkspaceColor) ? value.accent as WorkspaceColor : "violet");
  return { description: typeof value.description === "string" ? value.description : "", accent, sidebarDensity: value.sidebarDensity === "compact" ? "compact" as const : value.sidebarDensity === "normal" ? "normal" as const : "comfortable" as const, raw: value };
}
export const workspaceColor = (color: WorkspaceColor) => color.startsWith("#") ? color : `var(--tone-${color})`;
const ACTIVE = "suivelle.workspace";
export function rememberedWorkspace() { try { return localStorage.getItem(ACTIVE); } catch { return null; } }
export function rememberWorkspace(id: string) { try { localStorage.setItem(ACTIVE, id); } catch { /* Convenience only. */ } }
export function rememberedPage(id: string) { try { return localStorage.getItem(`suivelle.page.${id}`); } catch { return null; } }
export function rememberPage(workspaceId: string, id: string | null) { try { if (id) localStorage.setItem(`suivelle.page.${workspaceId}`, id); else localStorage.removeItem(`suivelle.page.${workspaceId}`); } catch { /* Convenience only. */ } }
