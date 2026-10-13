import { LEGACY_NAME } from "../../../lib/legacy";
import type { Extensions } from "@tiptap/core";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { BlockId } from "./blockId";
import { Behaviors } from "./behaviors";
import { Callout } from "./callout";
import { Column, Columns } from "./columns";
import { DatabaseViewBlock } from "./databaseView";
import { SyncedBlock } from "./syncedBlock";
import { TableOfContents } from "./tableOfContents";
import { CodeBlock } from "./codeBlock";
import { Equation } from "./equation";
import { BlockFlash } from "./flash";
import { FindExtension } from "./find";
import { Intake } from "./intake";
import { PageMention } from "./mention";
import { MediaNodes } from "./media";
import { Quote } from "./quote";
import { Slash } from "./slash";
import { Tabs, TabPanel } from "./tabs";
import { ToneMark } from "./tone";
import { BlockSelection } from "../blockSelection";

/** `nested` builds the set for an editor that lives inside a synced block, which cannot hold another one. */
export function buildExtensions(options: { nested?: boolean } = {}): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Replaced by single-row block types below.
      blockquote: false,
      codeBlock: false,
      link: { openOnClick: false, autolink: true, protocols: ["suivelle", LEGACY_NAME] },
    }),
    TextStyle,
    ToneMark,
    BlockId,
    BlockSelection,
    BlockFlash,
    Behaviors,
    Intake,
    FindExtension,
    Quote,
    Callout,
    CodeBlock,
    Equation,
    Columns,
    Column,
    DatabaseViewBlock,
    TableOfContents,
    ...(options.nested ? [] : [SyncedBlock]),
    ...MediaNodes,
    PageMention,
    TaskList,
    TaskItem.configure({ nested: true }),
    Details.configure({ persist: true }),
    DetailsSummary.extend({
      addAttributes() { return { level: {
        default: 0,
        parseHTML: (el) => Math.max(0, Math.min(4, Number(el.getAttribute("data-level")) || 0)),
        renderHTML: ({ level }) => level ? { "data-level": level, role: "heading", "aria-level": level } : {},
      } }; },
    }),
    Tabs,
    TabPanel,
    DetailsContent,
    Table.configure({ resizable: false, renderWrapper: true }),
    TableRow,
    TableHeader,
    TableCell,
    Slash,
    Placeholder.configure({
      showOnlyCurrent: true,
      includeChildren: true,
      placeholder: ({ node }) => (node.type.name === "heading" ? "Heading" : "Type '/' for blocks"),
    }),
  ];
}
