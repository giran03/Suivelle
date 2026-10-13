/**
 * Maps between the ProseMirror document and the flat `block` rows stored in SQLite.
 *
 * - Every block (including each list item and toggle) is one row; nesting uses `parentBlockId`.
 * - Positions are fractional so inserting a block only writes that block.
 * - Block data is versioned (`BLOCK_SCHEMA_VERSION`); older rows are upgraded on load by
 *   `migrateBlockData`, which is independent from the SQLite migrations.
 */
import type { JSONContent } from "@tiptap/core";
import { imagePresentation } from "./imageModel";
import { newId } from "../../lib/ids";
import type { Block, BlockType } from "../../types";

export const BLOCK_SCHEMA_VERSION = 2;

export interface BlockRow {
  id: string;
  parentBlockId: string | null;
  type: BlockType;
  position: number;
  dataJson: string;
  schemaVersion: number;
}

export type BlockData = Record<string, unknown>;

export const rowFromBlock = (b: Block): BlockRow => ({
  id: b.id,
  parentBlockId: b.parentBlockId,
  type: b.type,
  position: b.position,
  dataJson: b.dataJson,
  schemaVersion: b.schemaVersion,
});

/** Content migration for block data. v1 (Phase 0) stored plain `{text}`; v2 stores rich `{content}`. */
export function migrateBlockData(schemaVersion: number, dataJson: string): BlockData {
  let data: BlockData;
  try {
    const parsed: unknown = JSON.parse(dataJson);
    data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as BlockData) } : {};
  } catch {
    data = {};
  }
  if (schemaVersion < 2) {
    const text = typeof data.text === "string" ? data.text : "";
    delete data.text;
    data.content = text ? [{ type: "text", text }] : [];
  }
  return data;
}

const asArray = (v: unknown): JSONContent[] => (Array.isArray(v) ? (v as JSONContent[]) : []);
const withContent = (type: string, attrs: Record<string, unknown>, content: JSONContent[]): JSONContent => ({
  type,
  attrs,
  ...(content.length ? { content } : {}),
});

const MEDIA = new Set<BlockType>(["image", "audio", "video", "file", "pdf"]);
const LISTS = {
  bullet_list: { list: "bulletList", item: "listItem" },
  numbered_list: { list: "orderedList", item: "listItem" },
  todo: { list: "taskList", item: "taskItem" },
} as const;

export function emptyTable(): JSONContent {
  const cell = (type: string): JSONContent => ({ type, content: [{ type: "paragraph" }] });
  const row = (type: string): JSONContent => ({ type: "tableRow", content: [cell(type), cell(type), cell(type)] });
  return { type: "table", content: [row("tableHeader"), row("tableCell"), row("tableCell")] };
}

// ---------------------------------------------------------------------------------------------
// rows -> document
// ---------------------------------------------------------------------------------------------

export function blocksToDoc(rows: BlockRow[]): JSONContent {
  const ids = new Set(rows.map((r) => r.id));
  const byParent = new Map<string | null, BlockRow[]>();
  for (const r of rows) {
    // A row whose parent is missing is treated as top level rather than dropped.
    const key = r.parentBlockId && ids.has(r.parentBlockId) ? r.parentBlockId : null;
    const siblings = byParent.get(key);
    if (siblings) siblings.push(r);
    else byParent.set(key, [r]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const build = (parent: string | null, guard = 0, parentType: BlockType | null = null): JSONContent[] => {
    if (guard > 64) return [];
    const out: JSONContent[] = [];
    for (const row of byParent.get(parent) ?? []) {
      const data = migrateBlockData(row.schemaVersion, row.dataJson);
      const content = asArray(data.content);
      const kids = build(row.id, guard + 1, row.type);
      const attrs = { blockId: row.id };

      if (row.type in LISTS) {
        const { list, item } = LISTS[row.type as keyof typeof LISTS];
        const itemAttrs = row.type === "todo" ? { ...attrs, checked: data.checked === true } : attrs;
        const node: JSONContent = {
          type: item,
          attrs: itemAttrs,
          content: [withContent("paragraph", {}, content), ...kids],
        };
        const last = out[out.length - 1];
        if (last?.type === list) last.content!.push(node);
        else out.push({ type: list, content: [node] });
        continue;
      }

      switch (row.type) {
        case "heading_1":
        case "heading_2":
        case "heading_3":
          out.push(withContent("heading", { ...attrs, level: Number(row.type.slice(-1)) }, content));
          break;
        case "toggle":
          out.push({
            type: "details",
            attrs: { ...attrs, open: data.open === true },
            content: [
              withContent("detailsSummary", { level: Math.max(0, Math.min(4, Number(data.level) || 0)) }, content),
              { type: "detailsContent", content: kids.length ? kids : [{ type: "paragraph" }] },
            ],
          });
          continue; // children already placed inside the toggle
        case "tabs":
          out.push({ type: "tabs", attrs, content: kids.length ? kids : [{ type: "tabPanel", attrs: { label: "Tab 1" }, content: [{ type: "paragraph" }] }] });
          continue;
        case "tab_panel":
          if (parentType === "tabs") out.push({ type: "tabPanel", attrs: { ...attrs, label: typeof data.label === "string" ? data.label : "Tab" }, content: kids.length ? kids : [{ type: "paragraph" }] });
          else out.push(...kids);
          continue;
        case "columns": {
          const columns = kids.filter((k) => k.type === "column");
          const others = kids.filter((k) => k.type !== "column");
          const blank = (): JSONContent => ({ type: "column", content: [{ type: "paragraph" }] });
          while (columns.length < 2) columns.push(blank());
          out.push({ type: "columns", attrs, content: columns });
          out.push(...others); // never drop content that is not inside a column
          continue; // children already placed inside the columns
        }
        case "column":
          // A column only means something inside columns; elsewhere its content is kept as plain blocks.
          if (parentType === "columns") out.push({ type: "column", attrs, content: kids.length ? kids : [{ type: "paragraph" }] });
          else out.push(...kids);
          continue;
        case "table_of_contents":
          out.push({ type: "tableOfContents", attrs });
          break;
        case "synced_block":
          out.push({ type: "syncedBlock", attrs: { ...attrs, pageId: typeof data.pageId === "string" ? data.pageId : null } });
          break;
        case "database_view":
          out.push({
            type: "databaseView",
            attrs: {
              ...attrs,
              pageId: typeof data.pageId === "string" ? data.pageId : null,
              viewId: typeof data.viewId === "string" ? data.viewId : null,
              height: typeof data.height === "number" ? data.height : null,
            },
          });
          break;
        case "quote":
          out.push(withContent("quote", attrs, content));
          break;
        case "callout":
          out.push(withContent("callout", { ...attrs, tone: typeof data.tone === "string" ? data.tone : "note" }, content));
          break;
        case "divider":
          out.push({ type: "horizontalRule", attrs });
          break;
        case "code": {
          const text = typeof data.text === "string" ? data.text : "";
          out.push({
            type: "codeBlock",
            attrs: { ...attrs, language: typeof data.language === "string" ? data.language : null },
            ...(text ? { content: [{ type: "text", text }] } : {}),
          });
          break;
        }
        case "equation":
          out.push({ type: "equation", attrs: { ...attrs, latex: typeof data.latex === "string" ? data.latex : "" } });
          break;
        case "simple_table": {
          const table = (data.table as JSONContent | undefined) ?? emptyTable();
          out.push({ ...table, attrs: { ...(table.attrs ?? {}), ...attrs } });
          break;
        }
        default:
          if (MEDIA.has(row.type)) {
            const a = (data.attachment ?? {}) as Record<string, unknown>;
            out.push({
              type: row.type,
              attrs: {
                ...attrs,
                attachmentId: a.id ?? null,
                hash: a.hash ?? null,
                name: a.name ?? null,
                mime: a.mime ?? null,
                size: typeof a.size === "number" ? a.size : null,
                showName: a.showName === true,
                ...(row.type === "image" ? { presentation: imagePresentation(data.presentation) } : {}),
              },
            });
          } else {
            out.push(withContent("paragraph", attrs, content));
          }
      }
      // Types that cannot hold children keep any stray children as following siblings.
      out.push(...kids);
    }
    return out;
  };

  const content = build(null);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

// ---------------------------------------------------------------------------------------------
// document -> rows
// ---------------------------------------------------------------------------------------------

interface Desc {
  id: string;
  type: BlockType;
  data: BlockData;
  children: JSONContent[];
}

function stripBlockIds(node: JSONContent): JSONContent {
  const { attrs, content, ...rest } = node;
  const cleanAttrs = attrs ? Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== "blockId")) : undefined;
  return {
    ...rest,
    ...(cleanAttrs && Object.keys(cleanAttrs).length ? { attrs: cleanAttrs } : {}),
    ...(content ? { content: content.map(stripBlockIds) } : {}),
  };
}

const idOf = (n: JSONContent) => (typeof n.attrs?.blockId === "string" && n.attrs.blockId ? (n.attrs.blockId as string) : newId());

function collect(n: JSONContent, out: Desc[]): void {
  const content = n.content ?? [];
  switch (n.type) {
    case "paragraph":
      out.push({ id: idOf(n), type: "paragraph", data: { content }, children: [] });
      break;
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(n.attrs?.level) || 1));
      out.push({ id: idOf(n), type: `heading_${level}` as BlockType, data: { content }, children: [] });
      break;
    }
    case "quote":
      out.push({ id: idOf(n), type: "quote", data: { content }, children: [] });
      break;
    case "callout":
      out.push({ id: idOf(n), type: "callout", data: { content, tone: n.attrs?.tone ?? "note" }, children: [] });
      break;
    case "horizontalRule":
      out.push({ id: idOf(n), type: "divider", data: {}, children: [] });
      break;
    case "codeBlock":
      out.push({
        id: idOf(n),
        type: "code",
        data: { language: n.attrs?.language ?? null, text: content.map((c) => c.text ?? "").join("") },
        children: [],
      });
      break;
    case "equation":
      out.push({ id: idOf(n), type: "equation", data: { latex: n.attrs?.latex ?? "" }, children: [] });
      break;
    case "table":
      out.push({ id: idOf(n), type: "simple_table", data: { table: stripBlockIds(n) }, children: [] });
      break;
    case "tabs":
      out.push({ id: idOf(n), type: "tabs", data: {}, children: content });
      break;
    case "tabPanel":
      out.push({ id: idOf(n), type: "tab_panel", data: { label: n.attrs?.label ?? "Tab" }, children: content });
      break;
    case "columns":
      out.push({ id: idOf(n), type: "columns", data: {}, children: content });
      break;
    case "column":
      out.push({ id: idOf(n), type: "column", data: {}, children: content });
      break;
    case "tableOfContents":
      out.push({ id: idOf(n), type: "table_of_contents", data: {}, children: [] });
      break;
    case "syncedBlock":
      out.push({ id: idOf(n), type: "synced_block", data: { pageId: n.attrs?.pageId ?? null }, children: [] });
      break;
    case "databaseView":
      out.push({
        id: idOf(n),
        type: "database_view",
        data: { pageId: n.attrs?.pageId ?? null, viewId: n.attrs?.viewId ?? null, height: n.attrs?.height ?? null },
        children: [],
      });
      break;
    case "details": {
      const [summary, body] = content;
      out.push({
        id: idOf(n),
        type: "toggle",
        data: { content: summary?.content ?? [], open: n.attrs?.open === true, ...(summary?.attrs?.level ? { level: summary.attrs.level } : {}) },
        children: body?.content ?? [],
      });
      break;
    }
    case "bulletList":
    case "orderedList":
    case "taskList": {
      const type: BlockType = n.type === "bulletList" ? "bullet_list" : n.type === "orderedList" ? "numbered_list" : "todo";
      for (const item of content) {
        const [first, ...rest] = item.content ?? [];
        const hasText = first?.type === "paragraph";
        const data: BlockData = { content: hasText ? (first.content ?? []) : [] };
        if (type === "todo") data.checked = item.attrs?.checked === true;
        out.push({ id: idOf(item), type, data, children: hasText ? rest : (item.content ?? []) });
      }
      break;
    }
    default:
      // A block whose file is still being stored is not content yet; it is saved once the file is in.
      if (MEDIA.has(n.type as BlockType) && !n.attrs?.pending) {
        const a = n.attrs ?? {};
        out.push({
          id: idOf(n),
          type: n.type as BlockType,
          data: {
            ...(n.type === "image" && Object.keys(imagePresentation(a.presentation)).length ? { presentation: imagePresentation(a.presentation) } : {}),
            attachment: a.attachmentId
              ? { id: a.attachmentId, hash: a.hash, name: a.name, mime: a.mime, size: a.size, ...(a.showName ? { showName: true } : {}) }
              : null,
          },
          children: [],
        });
      }
  }
}

/** Keeps existing positions where order is unchanged and slots new/moved ids between neighbours. */
export function assignPositions(ids: string[], prev: ReadonlyMap<string, number>): number[] {
  const out: (number | undefined)[] = new Array(ids.length).fill(undefined);
  let last = -Infinity;
  ids.forEach((id, i) => {
    const p = prev.get(id);
    if (p !== undefined && p > last) {
      out[i] = p;
      last = p;
    }
  });
  let i = 0;
  while (i < ids.length) {
    if (out[i] !== undefined) {
      i++;
      continue;
    }
    let j = i;
    while (j < ids.length && out[j] === undefined) j++;
    const lo = i > 0 ? (out[i - 1] as number) : undefined;
    const hi = j < ids.length ? (out[j] as number) : undefined;
    const n = j - i;
    for (let k = 0; k < n; k++) {
      out[i + k] =
        lo !== undefined && hi !== undefined
          ? lo + ((hi - lo) * (k + 1)) / (n + 1)
          : lo !== undefined
            ? lo + k + 1
            : hi !== undefined
              ? hi - (n - k)
              : k;
    }
    i = j;
  }
  const result = out as number[];
  // Midpoint splitting eventually runs out of float precision; renumber the whole list if so.
  for (let k = 1; k < result.length; k++) {
    if (result[k] - result[k - 1] < 1e-7) return result.map((_, idx) => idx);
  }
  return result;
}

export function docToBlocks(doc: JSONContent, prev: ReadonlyMap<string, number> = new Map()): BlockRow[] {
  const rows: BlockRow[] = [];
  const emit = (nodes: JSONContent[], parentId: string | null, guard = 0) => {
    if (guard > 64) return;
    const sibs: Desc[] = [];
    nodes.forEach((n) => collect(n, sibs));
    const positions = assignPositions(
      sibs.map((s) => s.id),
      prev,
    );
    sibs.forEach((s, i) => {
      rows.push({
        id: s.id,
        parentBlockId: parentId,
        type: s.type,
        position: positions[i],
        dataJson: JSON.stringify(s.data),
        schemaVersion: BLOCK_SCHEMA_VERSION,
      });
      emit(s.children, s.id, guard + 1);
    });
  };
  emit(doc.content ?? [], null);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------------------------

export interface BlockChanges {
  upserts: BlockRow[];
  deleteIds: string[];
}

const same = (a: BlockRow, b: BlockRow) =>
  a.parentBlockId === b.parentBlockId &&
  a.type === b.type &&
  a.position === b.position &&
  a.dataJson === b.dataJson &&
  a.schemaVersion === b.schemaVersion;

export function diffBlocks(saved: ReadonlyMap<string, BlockRow>, next: BlockRow[]): BlockChanges {
  const nextIds = new Set(next.map((r) => r.id));
  return {
    upserts: next.filter((r) => {
      const old = saved.get(r.id);
      return !old || !same(old, r);
    }),
    deleteIds: [...saved.keys()].filter((id) => !nextIds.has(id)),
  };
}

export const positionsOf = (rows: Iterable<BlockRow>): Map<string, number> =>
  new Map([...rows].map((r) => [r.id, r.position]));
