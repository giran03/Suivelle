import { ipc } from "../../lib/ipc";
import type { DatabaseDetail } from "../../types";

export interface TaskDestination { propertyId: string; databaseId: string; projectDatabaseId: string; label: string; }

/** Relationships are identified by IDs, so renaming a database or property is harmless. */
export function taskDestinations(databases: DatabaseDetail[], paths: Record<string, string> = {}): TaskDestination[] {
  const titles = new Map(databases.map(d => [d.database.id, paths[d.page.id] || d.page.title || "Untitled database"]));
  return databases.flatMap(d => d.properties.filter(p => p.type === "relation" && p.config.targetDatabaseId !== d.database.id && titles.has(p.config.targetDatabaseId ?? "")).map(p => ({
    propertyId: p.id, databaseId: d.database.id, projectDatabaseId: p.config.targetDatabaseId!,
    label: `${titles.get(d.database.id)} → ${titles.get(p.config.targetDatabaseId!)} · ${p.name}`,
  })));
}

export function savedTaskRelations(settingsJson: string): string[] {
  try {
    const ids = JSON.parse(settingsJson).projectTaskRelationIds;
    return Array.isArray(ids) ? ids.filter(id => typeof id === "string") : [];
  } catch { return []; }
}

export async function rememberTaskDestination(workspaceId: string, propertyId: string) {
  const workspace = await ipc.workspaceGet(workspaceId);
  if (!workspace) throw new Error("This workspace is no longer available.");
  const settings = JSON.parse(workspace.settingsJson);
  settings.projectTaskRelationIds = [...new Set([...savedTaskRelations(workspace.settingsJson), propertyId])];
  return ipc.workspaceUpdateSettings(workspaceId, JSON.stringify(settings));
}
