// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import { NodeSelection } from "@tiptap/pm/state";
import { buildExtensions } from "./extensions";
import { blockAtPoint, blockDragKey, blockDragPlugin, moveDraggedBlock } from "./blockDrag";

let editor: Editor;
afterEach(() => { editor?.destroy(); vi.unstubAllGlobals(); });
const p = (text: string) => ({ type: "paragraph", attrs: { blockId: text }, content: [{ type: "text", text }] });
function make(content: object[]) { editor = new Editor({ extensions: buildExtensions(), content: { type: "doc", content } }); return editor; }

it("moves the exact block with its ID, maps downward insertion, and undoes in one step", () => {
  const e = make([p("one"), p("two"), p("three")]);
  const from = e.state.doc.firstChild!.nodeSize;
  const selection = NodeSelection.create(e.state.doc, from);
  const id = selection.node.attrs.blockId;
  const tr = moveDraggedBlock(e.state, from, selection.to, selection.content(), e.state.doc.content.size)!;
  e.view.dispatch(tr);
  expect(e.state.doc.textContent).toBe("onethreetwo");
  expect(e.state.doc.lastChild!.attrs.blockId).toBe(id);
  expect(e.commands.undo()).toBe(true);
  expect(e.state.doc.textContent).toBe("onetwothree");
});

it("reorders a task row with its nested children and rejects dropping inside itself", () => {
  const task = (text: string, children?: object[]) => ({ type: "taskItem", attrs: { checked: true }, content: [p(text), ...(children ?? [])] });
  const e = make([{ type: "taskList", content: [task("parent", [{ type: "taskList", content: [task("child")] }]), task("second")] }]);
  const selection = NodeSelection.create(e.state.doc, 1);
  expect(moveDraggedBlock(e.state, 1, selection.to, selection.content(), 3)).toBeNull();
  const end = e.state.doc.firstChild!.nodeSize - 1;
  e.view.dispatch(moveDraggedBlock(e.state, 1, selection.to, selection.content(), end)!);
  expect(e.state.doc.textContent).toBe("secondparentchild");
  expect(e.state.doc.firstChild!.lastChild!.attrs.checked).toBe(true);
});

it("resolves the second nested row from the left gutter and keeps tables whole", () => {
  const e = make([p("top"), { type: "taskList", content: [
    { type: "taskItem", content: [p("first")] }, { type: "taskItem", content: [p("second")] },
  ] }, { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p("cell")] }] }] }]);
  e.view.dom.getBoundingClientRect = () => new DOMRect(100, 0, 600, 180);
  let item = 0;
  e.state.doc.descendants((node, pos) => {
    const dom = e.view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    let top = 0, height = 30;
    if (node.type.name === "taskList") { top = 30; height = 60; }
    else if (node.type.name === "taskItem") top = 30 + item++ * 30;
    else if (["table", "tableRow", "tableCell"].includes(node.type.name) || node.textContent === "cell") { top = 100; height = 80; }
    else if (node.textContent === "first") top = 30;
    else if (node.textContent === "second") top = 60;
    dom.getBoundingClientRect = () => new DOMRect(100, top, 600, height);
  });
  expect(blockAtPoint(e.view, 55, 75)?.node.textContent).toBe("second");
  expect(blockAtPoint(e.view, 55, 140)?.node.type.name).toBe("table");
});

it("keeps the skeleton out of saved content and clears a stale drag on a document edit", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const e = make([p("one"), p("two")]);
  e.registerPlugin(blockDragPlugin(() => {}));
  const selection = NodeSelection.create(e.state.doc, 0);
  const before = e.getJSON();
  e.view.dispatch(e.state.tr.setMeta(blockDragKey, {
    from: 0, to: selection.to, slice: selection.content(), height: 90, target: e.state.doc.content.size,
  }).setMeta("addToHistory", false));
  expect(e.view.dom.querySelector(".block-drop-skeleton")?.getAttribute("style")).toContain("90px");
  expect(e.getJSON()).toEqual(before);
  e.commands.insertContentAt(2, "!");
  expect(blockDragKey.getState(e.state)).toBeNull();
  expect(e.view.dom.querySelector(".block-drop-skeleton")).toBeNull();
});
