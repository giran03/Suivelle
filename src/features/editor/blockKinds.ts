import type { Editor } from "@tiptap/core";
import type { IconName } from "../../components/Icon";
import { emptyTable } from "./convert";
import { currentBlock, replaceBlock, unwrapLists } from "./commands";
import { insertColumns } from "./extensions/columns";
import { pickAttachment } from "./extensions/media";
import { useWorkspace } from "../../stores/workspace";
import type { AttachmentKind } from "../../types";

export type KindGroup = "Text" | "Lists" | "Structure" | "Media" | "Advanced";

export interface BlockKind {
  id: string;
  title: string;
  description: string;
  group: KindGroup;
  keywords: string;
  /** Drawn icon, or a short typographic label when the block is best recognised by its glyph. */
  icon?: IconName;
  glyph?: string;
  /** Text-like kinds can also be reached from "Turn into" on an existing block. */
  turnInto: boolean;
  /** Runs with the caret inside the block to convert, or inside the empty block to replace. */
  apply: (editor: Editor) => void | Promise<void>;
}

const blockId = (editor: Editor) => (currentBlock(editor)?.node.attrs.blockId as string | null | undefined) ?? null;

/** Converts the current text block, keeping its id so history stays attached to one row. */
function convert(editor: Editor, run: (chain: ReturnType<Editor["chain"]>, id: string | null) => void) {
  const id = blockId(editor);
  if (currentBlock(editor)?.node.type.name === "details") editor.commands.unsetDetails();
  unwrapLists(editor);
  const chain = editor.chain().focus().clearNodes();
  run(chain, id);
  chain.run();
}

const media = (kind: AttachmentKind, title: string, description: string, icon: IconName, keywords: string): BlockKind => ({
  id: kind,
  title,
  description,
  group: "Media",
  keywords,
  icon,
  turnInto: false,
  apply: async (editor) => {
    const attrs = await pickAttachment(kind);
    if (attrs) replaceBlock(editor, { type: kind, attrs });
  },
});

export const BLOCK_KINDS: BlockKind[] = [
  {
    id: "paragraph", title: "Text", description: "Plain paragraph", group: "Text", keywords: "paragraph text plain",
    icon: "text", turnInto: true,
    apply: (e) => convert(e, (c, id) => c.updateAttributes("paragraph", { blockId: id })),
  },
  {
    id: "heading_1", title: "Heading 1", description: "Large section heading", group: "Text", keywords: "h1 heading title # big",
    glyph: "H1", turnInto: true,
    apply: (e) => convert(e, (c, id) => c.setNode("heading", { level: 1, blockId: id })),
  },
  {
    id: "heading_2", title: "Heading 2", description: "Medium section heading", group: "Text", keywords: "h2 heading ## subtitle",
    glyph: "H2", turnInto: true,
    apply: (e) => convert(e, (c, id) => c.setNode("heading", { level: 2, blockId: id })),
  },
  {
    id: "heading_3", title: "Heading 3", description: "Small section heading", group: "Text", keywords: "h3 heading ###",
    glyph: "H3", turnInto: true,
    apply: (e) => convert(e, (c, id) => c.setNode("heading", { level: 3, blockId: id })),
  },
  {
    id: "quote", title: "Quote", description: "Set apart a quotation", group: "Text", keywords: "quote blockquote citation >",
    icon: "quote", turnInto: true,
    apply: (e) => convert(e, (c, id) => c.setNode("quote", { blockId: id })),
  },
  {
    id: "callout", title: "Callout", description: "Highlight a note, tip or warning", group: "Text", keywords: "callout note tip warning alert info",
    icon: "note", turnInto: true,
    apply: (e) => convert(e, (c, id) => c.setNode("callout", { tone: "note", blockId: id })),
  },
  {
    id: "bullet_list", title: "Bulleted list", description: "A simple list of points", group: "Lists", keywords: "bullet list ul unordered - *",
    icon: "bullet", turnInto: true,
    apply: (e) => convert(e, (c) => c.toggleBulletList()),
  },
  {
    id: "numbered_list", title: "Numbered list", description: "A list that counts", group: "Lists", keywords: "numbered ordered list ol 1.",
    glyph: "1.", turnInto: true,
    apply: (e) => convert(e, (c) => c.toggleOrderedList()),
  },
  {
    id: "todo", title: "To-do list", description: "Track tasks with checkboxes", group: "Lists", keywords: "todo task checkbox check [] checklist",
    icon: "todo", turnInto: true,
    apply: (e) => convert(e, (c) => c.toggleTaskList()),
  },
  ...[0, 1, 2, 3, 4].map((level): BlockKind => ({
    id: level ? `toggle_heading_${level}` : "toggle",
    title: level ? `Toggle heading ${level}` : "Toggle list",
    description: level ? "A collapsible section heading" : "Show or hide nested blocks",
    group: "Structure", keywords: `toggle collapse details expand fold h${level}`,
    icon: "toggle", turnInto: true,
    apply: (e) => {
      unwrapLists(e);
      const b = currentBlock(e);
      if (!b || (!b.node.isTextblock && b.node.type.name !== "details")) return;
      const old = b.node.toJSON();
      const summary = old.type === "details" ? old.content?.[0]?.content : old.content;
      const body = old.type === "details" ? old.content?.[1]?.content : [{ type: "paragraph" }];
      e.chain().focus().insertContentAt({ from: b.pos, to: b.pos + b.node.nodeSize }, {
        type: "details", attrs: { blockId: b.node.attrs.blockId, open: old.attrs?.open ?? true },
        content: [
          { type: "detailsSummary", attrs: { level }, content: summary ?? [] },
          { type: "detailsContent", content: body ?? [{ type: "paragraph" }] },
        ],
      }).setTextSelection(b.pos + 2).run();
    },
  })),
  {
    id: "tabs", title: "Tabs", description: "Organize content in switchable panels", group: "Structure",
    keywords: "tabs tab panels sections", icon: "columns", turnInto: true,
    apply: (e) => {
      unwrapLists(e);
      const b = currentBlock(e);
      if (!b) return;
      const empty = b.node.type.name === "paragraph" && !b.node.content.size;
      const tabs = { type: "tabs", content: [1, 2].map((i) => ({
        type: "tabPanel", attrs: { label: `Tab ${i}` },
        content: i === 1 && !empty ? [b.node.toJSON()] : [{ type: "paragraph" }],
      })) };
      if (empty) replaceBlock(e, tabs);
      else e.chain().focus().insertContentAt({ from: b.pos, to: b.pos + b.node.nodeSize }, tabs).setTextSelection(b.pos + 3).run();
    },
  },
  {
    id: "divider", title: "Divider", description: "A line between sections", group: "Structure", keywords: "divider rule hr line separator ---",
    icon: "divider", turnInto: false,
    apply: (e) => replaceBlock(e, { type: "horizontalRule" }),
  },
  {
    id: "table", title: "Table", description: "Simple rows and columns", group: "Structure", keywords: "table grid rows columns",
    icon: "table", turnInto: false,
    apply: (e) => replaceBlock(e, emptyTable()),
  },
  {
    id: "code", title: "Code", description: "Code with syntax highlighting", group: "Advanced", keywords: "code snippet pre ``` programming",
    icon: "code", turnInto: true,
    apply: (e) => convert(e, (c, id) => c.setNode("codeBlock", { blockId: id })),
  },
  {
    id: "equation", title: "Equation", description: "Math written in LaTeX", group: "Advanced", keywords: "equation math latex formula katex",
    icon: "sigma", turnInto: false,
    apply: (e) => replaceBlock(e, { type: "equation", attrs: { latex: "" } }, { select: true }),
  },
  {
    id: "columns_2", title: "2 columns", description: "Put blocks side by side", group: "Structure", keywords: "columns layout side by side split two 2",
    icon: "columns", turnInto: false,
    apply: (e) => void insertColumns(e, 2),
  },
  {
    id: "columns_3", title: "3 columns", description: "Three blocks side by side", group: "Structure", keywords: "columns layout side by side split three 3",
    icon: "columns", turnInto: false,
    apply: (e) => void insertColumns(e, 3),
  },
  {
    id: "table_of_contents", title: "Table of contents", description: "List this page's headings", group: "Structure", keywords: "table of contents toc outline headings navigation index",
    icon: "bullet", turnInto: false,
    apply: (e) => replaceBlock(e, { type: "tableOfContents" }),
  },
  {
    id: "synced_block", title: "Synced block", description: "One block of content shown in many pages", group: "Advanced", keywords: "synced sync shared reusable linked duplicate footer snippet",
    icon: "duplicate", turnInto: false,
    apply: (e) => {
      if (!e.schema.nodes.syncedBlock) {
        useWorkspace.getState().notify("A synced block cannot go inside another synced block.");
        return;
      }
      replaceBlock(e, { type: "syncedBlock", attrs: { pageId: null } });
    },
  },
  {
    id: "database_view", title: "Database view", description: "Show a database right here", group: "Advanced", keywords: "database view table board embed linked inline records gallery calendar",
    icon: "table", turnInto: false,
    apply: (e) => replaceBlock(e, { type: "databaseView", attrs: { pageId: null, viewId: null, height: null } }),
  },
  { id: "embed", title: "Embed", description: "YouTube, Google Maps, and website links", group: "Media", keywords: "embed youtube maps iframe website link pdf", icon: "open", turnInto: false, apply: (e) => replaceBlock(e, { type: "embed" }) },
  media("image", "Image", "Upload a picture", "image", "image picture photo png jpg"),
  media("audio", "Audio", "Upload a sound file", "audio", "audio sound music mp3"),
  media("video", "Video", "Upload a video", "video", "video movie clip mp4"),
  media("pdf", "PDF", "Embed a PDF document", "page", "pdf document"),
  media("file", "File", "Attach any file", "page", "file attachment upload"),
];

export const TURN_INTO = BLOCK_KINDS.filter((k) => k.turnInto);

/** Ranks by title prefix, then keyword match; empty query returns everything in catalog order. */
export function filterKinds(query: string): BlockKind[] {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCK_KINDS;
  const score = (k: BlockKind) => {
    const title = k.title.toLowerCase();
    if (title.startsWith(q)) return 0;
    if (title.split(" ").some((w) => w.startsWith(q))) return 1;
    if (k.keywords.split(" ").some((w) => w.startsWith(q))) return 2;
    if (title.includes(q) || k.keywords.includes(q)) return 3;
    return -1;
  };
  return BLOCK_KINDS.map((k) => ({ k, s: score(k) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.k);
}
