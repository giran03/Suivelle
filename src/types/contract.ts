/**
 * Compile-time check that the hand-written IPC types still match the Rust ones.
 *
 * `src/types/generated` is written by `cargo test` (ts-rs) from the Rust structs. For each type,
 * both sides must have the same field names, and every hand-written field must fit the Rust one
 * (narrowing a string to a union of known values is fine; renaming, dropping or retyping a field
 * is not). `npm run typecheck` fails on drift. Nothing here exists at runtime.
 */
import type { Workspace as RustWorkspace } from "./generated/Workspace";
import type { Page as RustPage } from "./generated/Page";
import type { Block as RustBlock } from "./generated/Block";
import type { Attachment as RustAttachment } from "./generated/Attachment";
import type { PageTitle as RustPageTitle } from "./generated/PageTitle";
import type { Backlink as RustBacklink } from "./generated/Backlink";
import type { SearchHit as RustSearchHit } from "./generated/SearchHit";
import type { TagCount as RustTagCount } from "./generated/TagCount";
import type { Reminder as RustReminder } from "./generated/Reminder";
import type { Health as RustHealth } from "./generated/Health";
import type { Sweep as RustSweep } from "./generated/Sweep";
import type * as App from "./index";

type SameKeys<A, B> = [Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>] extends [never] ? true : { onlyInApp: Exclude<keyof A, keyof B>; onlyInRust: Exclude<keyof B, keyof A> };
type Fits<A, B> = [A] extends [B] ? true : { field: { [K in keyof A & keyof B]: [A[K]] extends [B[K]] ? never : K }[keyof A & keyof B] };
type Contract<A, B> = SameKeys<A, B> extends true ? Fits<A, B> : SameKeys<A, B>;
type Holds<T extends true> = T;

export type Checked = [
  Holds<Contract<App.Workspace, RustWorkspace>>,
  Holds<Contract<App.Page, RustPage>>,
  Holds<Contract<App.Block, RustBlock>>,
  Holds<Contract<App.Attachment, RustAttachment>>,
  Holds<Contract<App.PageTitle, RustPageTitle>>,
  Holds<Contract<App.Backlink, RustBacklink>>,
  Holds<Contract<App.SearchHit, RustSearchHit>>,
  Holds<Contract<App.TagCount, RustTagCount>>,
  Holds<Contract<App.Reminder, RustReminder>>,
  Holds<Contract<App.Health, RustHealth>>,
  Holds<Contract<App.Sweep, RustSweep>>,
];
