import { ipc } from "../../lib/ipc";
import { appendToPage } from "../capture/capture";
import type { Page } from "../../types";

/** The first page of a brand-new installation: a short checklist that teaches by doing. */
export const GETTING_STARTED = [
  { text: "Welcome to Suivelle. Everything here stays on this computer and works offline.", todo: false },
  { text: "Press Ctrl+K to find any page or run any command.", todo: true },
  { text: "Type / on an empty line to add headings, lists, tables, images and more.", todo: true },
  { text: "Write @ to mention another page, or #tag to group notes by topic.", todo: true },
  { text: "Press Ctrl+Alt+D to open today's note in your journal.", todo: true },
  { text: "Make a database with Ctrl+K, then New database, to track tasks or projects.", todo: true },
  { text: "From Ctrl+K, choose Remind me about this page to get a reminder later.", todo: true },
  { text: "Open Settings, then Data and backups, to keep a second copy of your backups on another drive.", todo: true },
  { text: "Delete this page whenever you like; you can always undo from the trash.", todo: false },
];

/** Adds the Getting started page to a new workspace and returns it. */
export async function seedGettingStarted(workspaceId: string): Promise<Page> {
  const page = await ipc.pageCreate(workspaceId, null, "Getting started");
  await appendToPage(page, GETTING_STARTED);
  return page;
}
