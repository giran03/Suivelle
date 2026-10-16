import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as PMNode, type NodeType, type Schema } from "@tiptap/pm/model";
import type { IconName } from "../../components/Icon";
import { emptyTable } from "./convert";
import { currentBlock, replaceBlock, unwrapLists } from "./commands";
import { BlockRangeSelection, blockRange } from "./blockSelection";
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
  /** Optional shortcut action id for menus and keybindings. */
  shortcut?: string;
  /** Text-like kinds can also be reached from "Turn into" on an existing block. */
  turnInto: boolean;
  /** Runs with the caret inside the block to convert, or inside the empty block to replace. */
  apply: (editor: Editor) => void | Promise<void>;
}

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
const LIST_ITEMS = new Set(["listItem", "taskItem"]);
const LIST_CONTAINERS = new Set(["bulletList", "orderedList", "taskList", "listItem", "taskItem"]);

export function canTurnInto(node: PMNode): boolean {
  return node.isTextblock || ["details", "listItem", "taskItem"].includes(node.type.name);
}

export interface SelectedBlockEntry {
  node: PMNode;
  pos: number;
  parentListType: NodeType | null;
}

export interface PartitionedBlockRange {
  replaceFrom: number;
  replaceTo: number;
  prefixNodes: PMNode[];
  suffixNodes: PMNode[];
  entries: SelectedBlockEntry[];
  prevSibling: { node: PMNode; pos: number } | null;
  nextSibling: { node: PMNode; pos: number } | null;
}

export function partitionSelectedBlocks(doc: PMNode, from: number, to: number): PartitionedBlockRange | null {
  const blocks = blockRange(doc, from, to);
  if (!blocks.length) return null;
  const selFrom = blocks[0].pos;
  const selTo = blocks[blocks.length - 1].pos + blocks[blocks.length - 1].node.nodeSize;
  const $from = doc.resolve(selFrom);
  const shared = $from.sharedDepth(selTo);
  let containerDepth = 0;
  for (let d = 1; d <= shared; d++) {
    if (LIST_CONTAINERS.has($from.node(d).type.name)) break;
    containerDepth = d;
  }
  const container = $from.node(containerDepth);
  if (!container.type.contentMatch.matchType(doc.type.schema.nodes.paragraph)) return null;
  const containerStart = containerDepth === 0 ? 0 : $from.start(containerDepth);

  function splitList(listNode: PMNode, listPos: number): { before: PMNode[]; after: PMNode[]; selected: SelectedBlockEntry[] } {
    const beforeItems: PMNode[] = [];
    const afterItems: PMNode[] = [];
    const extraAfter: PMNode[] = [];
    const selected: SelectedBlockEntry[] = [];
    listNode.forEach((item, itemOffset) => {
      const itemPos = listPos + 1 + itemOffset;
      const itemEnd = itemPos + item.nodeSize;
      if (itemEnd <= selFrom) {
        beforeItems.push(item);
      } else if (itemPos >= selTo) {
        afterItems.push(item);
      } else if (itemPos >= selFrom && itemEnd <= selTo) {
        selected.push({ node: item, pos: itemPos, parentListType: listNode.type });
      } else {
        const headChildren: PMNode[] = [];
        item.forEach((sub, subOffset) => {
          const subPos = itemPos + 1 + subOffset;
          const subEnd = subPos + sub.nodeSize;
          if (subEnd <= selFrom) {
            headChildren.push(sub);
          } else if (subPos >= selTo) {
            if (sub.type === listNode.type) sub.forEach((ti) => afterItems.push(ti));
            else if (LIST_TYPES.has(sub.type.name)) extraAfter.push(sub);
          } else if (LIST_TYPES.has(sub.type.name)) {
            const nested = splitList(sub, subPos);
            headChildren.push(...nested.before);
            selected.push(...nested.selected);
            for (const a of nested.after) {
              if (a.type === listNode.type) a.forEach((ti) => afterItems.push(ti));
              else extraAfter.push(a);
            }
          } else {
            headChildren.push(sub);
          }
        });
        if (headChildren.length) beforeItems.push(item.type.create(item.attrs, headChildren));
      }
    });
    return {
      before: beforeItems.length ? [listNode.type.create(listNode.attrs, beforeItems)] : [],
      after: [
        ...extraAfter,
        ...(afterItems.length ? [listNode.type.create(listNode.attrs, afterItems)] : []),
      ],
      selected,
    };
  }

  let replaceFrom = Infinity;
  let replaceTo = -Infinity;
  const prefixNodes: PMNode[] = [];
  const suffixNodes: PMNode[] = [];
  const entries: SelectedBlockEntry[] = [];
  let prevSibling: { node: PMNode; pos: number } | null = null;
  let nextSibling: { node: PMNode; pos: number } | null = null;

  container.forEach((child, offset) => {
    const childPos = containerStart + offset;
    const childEnd = childPos + child.nodeSize;
    if (childEnd <= selFrom) {
      prevSibling = { node: child, pos: childPos };
      return;
    }
    if (childPos >= selTo) {
      if (!nextSibling) nextSibling = { node: child, pos: childPos };
      return;
    }
    replaceFrom = Math.min(replaceFrom, childPos);
    replaceTo = Math.max(replaceTo, childEnd);
    if (LIST_TYPES.has(child.type.name)) {
      const split = splitList(child, childPos);
      prefixNodes.push(...split.before);
      entries.push(...split.selected);
      suffixNodes.push(...split.after);
    } else {
      entries.push({ node: child, pos: childPos, parentListType: null });
    }
  });

  if (!entries.length || replaceFrom > replaceTo) return null;
  return { replaceFrom, replaceTo, prefixNodes, suffixNodes, entries, prevSibling, nextSibling };
}

export function mergeAdjacentLists(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === node.type && LIST_TYPES.has(node.type.name)) {
      out[out.length - 1] = prev.type.create(prev.attrs, prev.content.append(node.content));
    } else {
      out.push(node);
    }
  }
  return out;
}

/** Wraps any bare listItem/taskItem runs back into their parent list container so the result is valid `block+` content. */
export function blocksAsContainerNodes(entries: SelectedBlockEntry[], schema: Schema): PMNode[] {
  const raw: PMNode[] = [];
  for (const entry of entries) {
    if (LIST_ITEMS.has(entry.node.type.name)) {
      const listType = entry.parentListType ?? (entry.node.type.name === "taskItem" ? schema.nodes.taskList : schema.nodes.bulletList);
      raw.push(listType.create(null, [entry.node]));
    } else {
      raw.push(entry.node);
    }
  }
  return mergeAdjacentLists(raw);
}

function inlineContentOf(node: PMNode, schema: Schema): Fragment {
  if (node.isTextblock) {
    if (node.type.name === "codeBlock") {
      return node.textContent ? Fragment.from(schema.text(node.textContent)) : Fragment.empty;
    }
    return node.content;
  }
  if (LIST_ITEMS.has(node.type.name)) {
    return node.firstChild?.type.name === "paragraph" ? node.firstChild.content : Fragment.empty;
  }
  if (node.type.name === "details") {
    return node.firstChild?.type.name === "detailsSummary" ? node.firstChild.content : Fragment.empty;
  }
  return Fragment.empty;
}

function nonEmptyDetailsBody(detailsNode: PMNode): PMNode[] {
  const body = detailsNode.lastChild;
  if (!body || body.type.name !== "detailsContent") return [];
  if (body.childCount === 1 && body.firstChild?.type.name === "paragraph" && body.firstChild.content.size === 0) {
    return [];
  }
  const nodes: PMNode[] = [];
  body.forEach((child) => nodes.push(child));
  return nodes;
}

function flattenConvertibleNodes(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  const visit = (node: PMNode) => {
    if (LIST_ITEMS.has(node.type.name)) {
      const first = node.firstChild;
      out.push(node.type.create(node.attrs, first ? [first] : []));
      node.forEach((child, _offset, index) => {
        if (index === 0) return;
        if (LIST_TYPES.has(child.type.name)) child.forEach(visit);
        else out.push(child);
      });
    } else {
      out.push(node);
    }
  };
  for (const n of nodes) visit(n);
  return out;
}

function collectCodeLines(nodes: PMNode[]): string[] {
  const lines: string[] = [];
  const visit = (node: PMNode) => {
    if (LIST_ITEMS.has(node.type.name)) {
      lines.push(node.firstChild?.textContent ?? "");
      node.forEach((child, _offset, index) => {
        if (index === 0) return;
        if (LIST_TYPES.has(child.type.name)) child.forEach(visit);
        else lines.push(child.textContent);
      });
    } else if (node.type.name === "details") {
      lines.push(node.firstChild?.textContent ?? "");
      for (const child of nonEmptyDetailsBody(node)) visit(child);
    } else {
      lines.push(node.textContent);
    }
  };
  for (const n of nodes) visit(n);
  return lines;
}

function convertToListItem(node: PMNode, listType: NodeType, itemType: NodeType, schema: Schema): PMNode {
  const id = (node.attrs.blockId as string | null | undefined) ?? null;
  const attrs = itemType.name === "taskItem"
    ? { blockId: id, checked: node.type.name === "taskItem" ? Boolean(node.attrs.checked) : false }
    : { blockId: id };
  const paragraph = schema.nodes.paragraph.create(null, inlineContentOf(node, schema));
  const extra: PMNode[] = [];
  if (LIST_ITEMS.has(node.type.name)) {
    node.forEach((child, _offset, index) => {
      if (index === 0) return;
      if (LIST_TYPES.has(child.type.name)) {
        const subItems: PMNode[] = [];
        child.forEach((subItem) => subItems.push(convertToListItem(subItem, listType, itemType, schema)));
        if (subItems.length) extra.push(listType.create(null, subItems));
      } else {
        extra.push(child);
      }
    });
  } else if (node.type.name === "details") {
    extra.push(...nonEmptyDetailsBody(node));
  }
  return itemType.create(attrs, [paragraph, ...extra]);
}

/** Converts all blocks in the active `BlockRangeSelection` to `kindId` in a single undoable step. */
export function turnSelectedBlocksInto(editor: Editor, kindId: string): boolean {
  const { selection, doc, schema } = editor.state;
  if (!editor.isEditable || !(selection instanceof BlockRangeSelection)) return false;
  const part = partitionSelectedBlocks(doc, selection.from, selection.to);
  if (!part || !part.entries.every((e) => canTurnInto(e.node))) return false;

  const sourceNodes = part.entries.map((e) => e.node);
  const tracked = new Set<PMNode>();
  let convertedNodes: PMNode[] = [];
  let { replaceFrom, replaceTo } = part;
  const prefixNodes = [...part.prefixNodes];
  const suffixNodes = [...part.suffixNodes];

  if (kindId === "code") {
    const id = (sourceNodes[0]?.attrs.blockId as string | null | undefined) ?? null;
    const language = (sourceNodes.find((n) => n.type.name === "codeBlock")?.attrs.language as string | null | undefined) ?? null;
    const text = collectCodeLines(sourceNodes).join("\n");
    const codeNode = schema.nodes.codeBlock.create(
      { blockId: id, language },
      text ? schema.text(text) : undefined,
    );
    tracked.add(codeNode);
    convertedNodes = [codeNode];
  } else if (kindId === "tabs") {
    const containerBlocks = blocksAsContainerNodes(part.entries, schema);
    const allEmpty = containerBlocks.length === 1 && containerBlocks[0].type.name === "paragraph" && containerBlocks[0].content.size === 0;
    const tab1Content = allEmpty ? [schema.nodes.paragraph.create()] : containerBlocks;
    const tabsNode = schema.nodes.tabs.create(null, [
      schema.nodes.tabPanel.create({ label: "Tab 1" }, tab1Content),
      schema.nodes.tabPanel.create({ label: "Tab 2" }, [schema.nodes.paragraph.create()]),
    ]);
    tracked.add(tabsNode);
    convertedNodes = [tabsNode];
  } else if (kindId === "bullet_list" || kindId === "numbered_list" || kindId === "todo") {
    const listType = kindId === "bullet_list" ? schema.nodes.bulletList : kindId === "numbered_list" ? schema.nodes.orderedList : schema.nodes.taskList;
    const itemType = kindId === "todo" ? schema.nodes.taskItem : schema.nodes.listItem;
    const items = sourceNodes.map((n) => {
      const item = convertToListItem(n, listType, itemType, schema);
      tracked.add(item);
      return item;
    });
    convertedNodes = [listType.create(null, items)];
    if (!prefixNodes.length && part.prevSibling?.node.type === listType) {
      replaceFrom = part.prevSibling.pos;
      prefixNodes.unshift(part.prevSibling.node);
    }
    if (!suffixNodes.length && part.nextSibling?.node.type === listType) {
      replaceTo = part.nextSibling.pos + part.nextSibling.node.nodeSize;
      suffixNodes.push(part.nextSibling.node);
    }
  } else if (kindId === "toggle" || kindId.startsWith("toggle_heading_")) {
    const level = kindId === "toggle" ? 0 : Number(kindId.slice(-1)) || 0;
    for (const n of sourceNodes) {
      const id = (n.attrs.blockId as string | null | undefined) ?? null;
      const open = n.type.name === "details" ? Boolean(n.attrs.open ?? true) : true;
      const summary = schema.nodes.detailsSummary.create({ level }, inlineContentOf(n, schema));
      const extraBody: PMNode[] = [];
      if ( n.type.name === "details" && n.lastChild?.type.name === "detailsContent") {
        n.lastChild.forEach((c) => extraBody.push(c));
      } else if (LIST_ITEMS.has(n.type.name)) {
        n.forEach((c, _o, idx) => { if (idx > 0) extraBody.push(c); });
      }
      const body = schema.nodes.detailsContent.create(
        null,
        extraBody.length ? extraBody : [schema.nodes.paragraph.create()],
      );
      const detailsNode = schema.nodes.details.create({ blockId: id, open }, [summary, body]);
      tracked.add(detailsNode);
      convertedNodes.push(detailsNode);
    }
  } else {
    for (const n of flattenConvertibleNodes(sourceNodes)) {
      const id = (n.attrs.blockId as string | null | undefined) ?? null;
      const content = inlineContentOf(n, schema);
      let block: PMNode;
      if (kindId === "paragraph") {
        block = schema.nodes.paragraph.create({ blockId: id }, content);
      } else if (kindId === "heading_1" || kindId === "heading_2" || kindId === "heading_3") {
        const level = Number(kindId.slice(-1));
        block = schema.nodes.heading.create({ level, blockId: id }, content);
      } else if (kindId === "quote") {
        block = schema.nodes.quote.create({ blockId: id }, content);
      } else if (kindId === "callout") {
        const tone = n.type.name === "callout" ? (n.attrs.tone ?? "note") : "note";
        block = schema.nodes.callout.create({ tone, blockId: id }, content);
      } else {
        return false;
      }
      tracked.add(block);
      convertedNodes.push(block);
      if (n.type.name === "details") {
        for (const extra of nonEmptyDetailsBody(n)) {
          tracked.add(extra);
          convertedNodes.push(extra);
        }
      }
    }
  }

  const finalNodes = mergeAdjacentLists([...prefixNodes, ...convertedNodes, ...suffixNodes]);
  const totalSize = finalNodes.reduce((sum, n) => sum + n.nodeSize, 0);
  const tr = closeHistory(editor.state.tr).replaceWith(replaceFrom, replaceTo, finalNodes);

  let selStart = Infinity;
  let selEnd = -Infinity;
  tr.doc.nodesBetween(replaceFrom, replaceFrom + totalSize, (node, pos) => {
    if (tracked.has(node)) {
      selStart = Math.min(selStart, pos);
      selEnd = Math.max(selEnd, pos + node.nodeSize);
      return false;
    }
    return true;
  });
  if (selStart <= selEnd) {
    tr.setSelection(BlockRangeSelection.create(tr.doc, selStart, selEnd));
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

const blockId = (editor: Editor) => (currentBlock(editor)?.node.attrs.blockId as string | null | undefined) ?? null;

/** Converts the current text block, keeping its id so history stays attached to one row. */
function convert(editor: Editor, kindId: string, run: (chain: ReturnType<Editor["chain"]>, id: string | null) => void) {
  if (editor.state.selection instanceof BlockRangeSelection) {
    turnSelectedBlocksInto(editor, kindId);
    return;
  }
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
    icon: "text", shortcut: "paragraph", turnInto: true,
    apply: (e) => convert(e, "paragraph", (c, id) => c.updateAttributes("paragraph", { blockId: id })),
  },
  {
    id: "heading_1", title: "Heading 1", description: "Large section heading", group: "Text", keywords: "h1 heading title # big",
    glyph: "H1", shortcut: "heading-1", turnInto: true,
    apply: (e) => convert(e, "heading_1", (c, id) => c.setNode("heading", { level: 1, blockId: id })),
  },
  {
    id: "heading_2", title: "Heading 2", description: "Medium section heading", group: "Text", keywords: "h2 heading ## subtitle",
    glyph: "H2", shortcut: "heading-2", turnInto: true,
    apply: (e) => convert(e, "heading_2", (c, id) => c.setNode("heading", { level: 2, blockId: id })),
  },
  {
    id: "heading_3", title: "Heading 3", description: "Small section heading", group: "Text", keywords: "h3 heading ###",
    glyph: "H3", shortcut: "heading-3", turnInto: true,
    apply: (e) => convert(e, "heading_3", (c, id) => c.setNode("heading", { level: 3, blockId: id })),
  },
  {
    id: "quote", title: "Quote", description: "Set apart a quotation", group: "Text", keywords: "quote blockquote citation >",
    icon: "quote", turnInto: true,
    apply: (e) => convert(e, "quote", (c, id) => c.setNode("quote", { blockId: id })),
  },
  {
    id: "callout", title: "Callout", description: "Highlight a note, tip or warning", group: "Text", keywords: "callout note tip warning alert info",
    icon: "note", turnInto: true,
    apply: (e) => convert(e, "callout", (c, id) => c.setNode("callout", { tone: "note", blockId: id })),
  },
  {
    id: "bullet_list", title: "Bulleted list", description: "A simple list of points", group: "Lists", keywords: "bullet list ul unordered - *",
    icon: "bullet", shortcut: "bullet-list", turnInto: true,
    apply: (e) => convert(e, "bullet_list", (c) => c.toggleBulletList()),
  },
  {
    id: "numbered_list", title: "Numbered list", description: "A list that counts", group: "Lists", keywords: "numbered ordered list ol 1.",
    glyph: "1.", shortcut: "ordered-list", turnInto: true,
    apply: (e) => convert(e, "numbered_list", (c) => c.toggleOrderedList()),
  },
  {
    id: "todo", title: "To-do list", description: "Track tasks with checkboxes", group: "Lists", keywords: "todo task checkbox check [] checklist",
    icon: "todo", shortcut: "task-list", turnInto: true,
    apply: (e) => convert(e, "todo", (c) => c.toggleTaskList()),
  },
  ...[0, 1, 2, 3, 4].map((level): BlockKind => {
    const id = level ? `toggle_heading_${level}` : "toggle";
    return {
      id,
      title: level ? `Toggle heading ${level}` : "Toggle list",
      description: level ? "A collapsible section heading" : "Show or hide nested blocks",
      group: "Structure", keywords: `toggle collapse details expand fold h${level}`,
      icon: "toggle", turnInto: true,
      apply: (e) => {
        if (e.state.selection instanceof BlockRangeSelection) {
          turnSelectedBlocksInto(e, id);
          return;
        }
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
    };
  }),
  {
    id: "tabs", title: "Tabs", description: "Organize content in switchable panels", group: "Structure",
    keywords: "tabs tab panels sections", icon: "columns", turnInto: true,
    apply: (e) => {
      if (e.state.selection instanceof BlockRangeSelection) {
        turnSelectedBlocksInto(e, "tabs");
        return;
      }
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
    icon: "code", shortcut: "code-block", turnInto: true,
    apply: (e) => convert(e, "code", (c, id) => c.setNode("codeBlock", { blockId: id })),
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
  { id: "calendar", title: "Calendar", description: "Plan events, database dates and linked blocks", group: "Advanced", keywords: "calendar schedule event planner day week month agenda", icon: "calendar", turnInto: false, apply: (e) => replaceBlock(e, { type: "calendar" }) },
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
