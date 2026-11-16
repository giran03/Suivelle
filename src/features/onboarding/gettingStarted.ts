import type { JSONContent } from "@tiptap/core";
import workspaceShotUrl from "../../../docs/images/workspace-dark.png?url";
import boardShotUrl from "../../../docs/images/project-board.png?url";
import dashboardShotUrl from "../../../docs/images/dashboard.png?url";
import { newId } from "../../lib/ids";
import { ipc } from "../../lib/ipc";
import type { Attachment, Page } from "../../types";
import { docToBlocks } from "../editor/convert";

/** The first page of a brand-new installation: a short checklist that teaches by doing. */
export const GETTING_STARTED = [
  { text: "Welcome to Suivelle. Everything here stays on this computer and works offline.", todo: false },
  { text: "Press Ctrl+P to find any page or run any command.", todo: true },
  { text: "Type / on an empty line to add headings, lists, tables, images and more.", todo: true },
  { text: "Write @ to mention another page, or #tag to group notes by topic.", todo: true },
  { text: "Press Ctrl+Alt+D to open today's note in your journal.", todo: true },
  { text: "Make a database with Ctrl+P, then New database, to track tasks or projects.", todo: true },
  { text: "From Ctrl+P, choose Remind me about this page to get a reminder later.", todo: true },
  { text: "Open Settings, then Data and backups, to keep a second copy of your backups on another drive.", todo: true },
  { text: "Delete this page whenever you like; you can always undo from the trash.", todo: false },
];

interface TourScreenshot {
  url: string;
  fileName: string;
  title: string;
  caption: string;
  alt: string;
}

const TOUR_SCREENSHOTS: TourScreenshot[] = [
  {
    url: workspaceShotUrl,
    fileName: "suivelle-workspace-tour.png",
    title: "Pages, nested sidebar, and fast navigation",
    caption: "Organize notes in nested pages, pin favorites, and drag pages into split panels or tabs.",
    alt: "Suivelle workspace showing nested pages in the sidebar and a formatted page",
  },
  {
    url: boardShotUrl,
    title: "Databases with boards, tables, and timelines",
    fileName: "suivelle-board-tour.png",
    caption: "Turn any database into a Kanban board, spreadsheet table, calendar, or pivot view.",
    alt: "Suivelle project board view with grouped task cards and status columns",
  },
  {
    url: dashboardShotUrl,
    fileName: "suivelle-dashboard-tour.png",
    title: "Live dashboards and charts",
    caption: "Combine charts, filtered database views, and notes in one live dashboard.",
    alt: "Suivelle dashboard combining charts and live database widgets",
  },
];

const textRun = (text: string, bold = false): JSONContent =>
  bold ? { type: "text", text, marks: [{ type: "bold" }] } : { type: "text", text };

const codeRun = (text: string): JSONContent => ({ type: "text", text, marks: [{ type: "code" }] });

const heading = (level: 2 | 3, text: string): JSONContent => ({
  type: "heading",
  attrs: { level, blockId: newId() },
  content: [textRun(text)],
});

const paragraph = (content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { blockId: newId() },
  content,
});

const taskItem = (content: JSONContent[]): JSONContent => ({
  type: "taskItem",
  attrs: { checked: false, blockId: newId() },
  content: [{ type: "paragraph", content }],
});

const bulletItem = (content: JSONContent[]): JSONContent => ({
  type: "listItem",
  attrs: { blockId: newId() },
  content: [{ type: "paragraph", content }],
});

async function importScreenshot(workspaceId: string, shot: TourScreenshot): Promise<Attachment | null> {
  if (typeof fetch !== "function" || typeof ipc.attachmentImportBytes !== "function") return null;
  try {
    const res = await fetch(shot.url);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength) return null;
    return await ipc.attachmentImportBytes(workspaceId, shot.fileName, bytes);
  } catch {
    return null;
  }
}

/** Adds the Getting started page to a new workspace and returns it. */
export async function seedGettingStarted(workspaceId: string): Promise<Page> {
  const page = await ipc.pageCreate(workspaceId, null, "Getting started");
  const imported = await Promise.all(TOUR_SCREENSHOTS.map((shot) => importScreenshot(workspaceId, shot)));

  const nodes: JSONContent[] = [
    {
      type: "callout",
      attrs: { tone: "note", blockId: newId() },
      content: [
        textRun("Welcome to Suivelle. ", true),
        textRun("Everything here lives locally on your computer and works offline. Edit, rearrange, or delete this page whenever you like — you can always restore it from the Trash."),
      ],
    },
    heading(2, "Quick tour"),
    {
      type: "taskList",
      content: [
        taskItem([textRun("Press "), codeRun("Ctrl+P"), textRun(" to jump to any page or run any command.")]),
        taskItem([textRun("Type "), codeRun("/"), textRun(" on an empty line to add headings, callouts, toggles, tables, equations, and images.")]),
        taskItem([textRun("Write "), codeRun("@"), textRun(" to mention another page, or "), codeRun("#tag"), textRun(" to group notes by topic.")]),
        taskItem([textRun("Press "), codeRun("Ctrl+Alt+D"), textRun(" to open today's note in your journal.")]),
        taskItem([textRun("Create a database with "), codeRun("Ctrl+P"), textRun(" → "), textRun("New database", true), textRun(" to track tasks, habits, or projects.")]),
        taskItem([textRun("From "), codeRun("Ctrl+P"), textRun(", choose "), textRun("Remind me about this page", true), textRun(" to set a reminder.")]),
        taskItem([textRun("Open "), textRun("Settings → Data and backups", true), textRun(" to keep automatic safety copies on another drive.")]),
      ],
    },
    heading(2, "What you can build"),
  ];

  TOUR_SCREENSHOTS.forEach((shot, index) => {
    const attachment = imported[index];
    nodes.push(heading(3, shot.title));
    if (attachment) {
      nodes.push({
        type: "image",
        attrs: {
          blockId: newId(),
          attachmentId: attachment.id,
          hash: attachment.hash,
          name: attachment.originalName,
          mime: attachment.mimeType,
          size: attachment.size,
          showName: false,
          presentation: {
            caption: shot.caption,
            alt: shot.alt,
          },
        },
      });
    } else {
      nodes.push(paragraph([textRun(shot.caption)]));
    }
  });

  nodes.push(
    heading(2, "Handy shortcuts"),
    {
      type: "details",
      attrs: { open: false, blockId: newId() },
      content: [
        { type: "detailsSummary", content: [textRun("Keyboard & mouse shortcuts at a glance", true)] },
        {
          type: "detailsContent",
          content: [
            {
              type: "bulletList",
              content: [
                bulletItem([codeRun("Ctrl+P"), textRun(" — Command palette & quick search")]),
                bulletItem([codeRun("Ctrl+\\"), textRun(" — Collapse or expand the sidebar")]),
                bulletItem([codeRun("Ctrl+Alt+D"), textRun(" — Open today's daily note")]),
                bulletItem([codeRun("Middle-click drag"), textRun(" — Smoothly pan and scroll pages, boards, and dropdowns")]),
                bulletItem([textRun("Drag tabs or sidebar pages"), textRun(" — Drop on a panel edge to open a split view")]),
              ],
            },
          ],
        },
      ],
    }
  );

  const rows = docToBlocks({ type: "doc", content: nodes });
  if (rows.length) {
    await ipc.blockApplyBatch({
      pageId: page.id,
      upserts: rows,
      deleteIds: [],
    });
  }

  return (await ipc.pageGet(page.id)) ?? page;
}
