// @vitest-environment jsdom
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { useTemplateGallery } from "../templates/store";
import type { Page, Workspace } from "../../types";
import { EmptyPagePrompts } from "./EmptyPagePrompts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let editor: Editor;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.spyOn(ipc, "pageGet").mockResolvedValue({ id: "page", kind: "page" } as Page);
  useWorkspace.setState({ workspace: { id: "workspace" } as Workspace });
  useTemplateGallery.setState({ open: false, busy: false });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  editor = new Editor({ extensions: [StarterKit, Node.create({ name: "calendar", group: "block", atom: true, renderHTML: () => ["div", { "data-calendar": "true" }] })], content: "<p></p>" });
});
afterEach(async () => { await act(async () => root.unmount()); editor.destroy(); host.remove(); vi.restoreAllMocks(); });
const render = async () => { await act(async () => root.render(<EmptyPagePrompts editor={editor} pageId="page" />)); };

it("shows only for an editable, blank ordinary page and latches dismissal after typing", async () => {
  await render();
  expect(host.querySelectorAll("button")).toHaveLength(3);
  await act(async () => { editor.commands.insertContent("Hello"); });
  expect(host.querySelector("button")).toBeNull();
  await act(async () => { editor.commands.setContent("<p></p>"); });
  expect(host.querySelector("button")).toBeNull();
});
it("dismisses at composition start without waiting for committed IME text", async () => {
  await render();
  await act(async () => { editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart")); });
  expect(host.querySelector("button")).toBeNull();
});
it("opens commands in its own editor and records the correct template destination", async () => {
  await render();
  await act(async () => { (host.querySelectorAll("button")[2] as HTMLButtonElement).click(); });
  expect(useTemplateGallery.getState()).toMatchObject({ open: true, targetPageId: "page", workspaceId: "workspace" });
  await act(async () => { (host.querySelectorAll("button")[0] as HTMLButtonElement).click(); });
  expect(editor.getText()).toBe("/");
});
it("adds a calendar to this page and hides prompts for non-text content", async () => {
  await render();
  await act(async () => { (host.querySelectorAll("button")[1] as HTMLButtonElement).click(); });
  expect(editor.state.doc.firstChild?.type.name).toBe("calendar");
  expect(host.querySelector("button")).toBeNull();
});
it("keeps prompts out of record pages and read-only editors", async () => {
  vi.mocked(ipc.pageGet).mockResolvedValue({ id: "page", kind: "record" } as Page);
  await render();
  expect(host.querySelector("button")).toBeNull();
  editor.setEditable(false);
  await render();
  expect(host.querySelector("button")).toBeNull();
});
