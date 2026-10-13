// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { TableMap, selectedRect } from "@tiptap/pm/tables";
import { afterEach, expect, it } from "vitest";
import { buildExtensions } from "./extensions";
import { insertTableAfter } from "./commands";
import { installInputRouter } from "../shortcuts/runtime";
import { useShortcuts } from "../shortcuts/store";
import { key } from "../shortcuts/bindings";

const editors: Editor[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach(stop => stop()); editors.splice(0).forEach(e => e.destroy());
  useShortcuts.setState({ overrides: {}, recording: false }); document.body.replaceChildren();
});
function make(html = '<table><tr><th>Service</th><th>Date</th></tr><tr><td>Discord</td><td>12th</td></tr><tr><td>Spotify</td><td>Monthly</td></tr></table>', nested = false) {
  const element = document.createElement("div"); document.body.append(element);
  const editor = new Editor({ element, extensions: buildExtensions({ nested }), content: html });
  editors.push(editor); return editor;
}
function at(editor: Editor, row: number, col: number) {
  let pos = 0; editor.state.doc.descendants((n, p) => { if (n.type.name === "table") pos = p; });
  const table = editor.state.doc.nodeAt(pos)!;
  editor.commands.setTextSelection(pos + 1 + TableMap.get(table).map[row * TableMap.get(table).width + col] + 2);
}
function press(editor: Editor, shift = false, value = "Enter") {
  const event = new KeyboardEvent("keydown", { key: value, ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true });
  editor.view.dom.dispatchEvent(event); return event;
}
it("Ctrl+Enter inserts below the active row, retains data, focuses the matching new cell, and undoes", () => {
  const editor = make(); at(editor, 1, 1); const original = editor.getJSON();
  expect(press(editor).defaultPrevented).toBe(true);
  const rect = selectedRect(editor.state);
  expect(rect.map.height).toBe(4); expect(rect.top).toBe(2); expect(rect.left).toBe(1);
  expect(rect.table.child(2).textContent).toBe("");
  expect(rect.table.child(1).textContent).toBe("Discord12th");
  expect(rect.table.child(3).textContent).toBe("SpotifyMonthly");
  editor.commands.undo(); expect(editor.getJSON()).toEqual(original);
});
it("Ctrl+Shift+Enter inserts right of the active column on every row and focuses that cell", () => {
  const editor = make(); at(editor, 1, 0); const original = editor.getJSON();
  expect(press(editor, true).defaultPrevented).toBe(true);
  const rect = selectedRect(editor.state);
  expect(rect.map.width).toBe(3); expect(rect.top).toBe(1); expect(rect.left).toBe(1);
  for (let i = 0; i < rect.table.childCount; i++) expect(rect.table.child(i).child(1).textContent).toBe("");
  expect(rect.table.child(0).child(1).type.name).toBe("tableHeader");
  expect(rect.table.child(1).child(2).textContent).toBe("12th");
  editor.commands.undo(); expect(editor.getJSON()).toEqual(original);
});
it("appends at the last row and column and works in nested editors", () => {
  const editor = make(undefined, true); at(editor, 2, 1);
  press(editor); let rect = selectedRect(editor.state);
  expect(rect.top).toBe(3); expect(rect.map.height).toBe(4);
  press(editor, true); rect = selectedRect(editor.state);
  expect(rect.left).toBe(2); expect(rect.map.width).toBe(3);
});
it("inserts beyond merged cells without corrupting table spans", () => {
  const editor = make('<table><tr><td colspan="2" rowspan="2">Merged</td><td>A</td></tr><tr><td>B</td></tr><tr><td>C</td><td>D</td><td>E</td></tr></table>');
  at(editor, 0, 0); press(editor, true);
  let rect = selectedRect(editor.state);
  expect(rect.left).toBe(2); expect(rect.map.width).toBe(4); expect(rect.map.problems).toBeNull();
  at(editor, 0, 0); press(editor); rect = selectedRect(editor.state);
  expect(rect.top).toBe(2); expect(rect.map.height).toBe(4); expect(rect.map.problems).toBeNull();
  expect(rect.table.textContent).toContain("Merged");
});
it("routes through the app's shortcut router and respects customized or disabled bindings", () => {
  const editor = make(); at(editor, 1, 0);
  stops.push(installInputRouter({}, () => true));
  press(editor); expect(selectedRect(editor.state).map.height).toBe(4);
  press(editor, true); expect(selectedRect(editor.state).map.width).toBe(3);
  useShortcuts.setState({ overrides: { "table-column-right": [key("j", "Control", "Shift")] } });
  press(editor, true); expect(selectedRect(editor.state).map.width).toBe(3);
  press(editor, true, "j"); expect(selectedRect(editor.state).map.width).toBe(4);
  useShortcuts.setState({ overrides: { "insert-above": [], "table-column-right": [] } });
  press(editor); press(editor, true);
  expect(selectedRect(editor.state).map.height).toBe(4); expect(selectedRect(editor.state).map.width).toBe(4);
});
it("does not modify read-only editors and leaves column shortcuts outside tables alone", () => {
  const editor = make(); at(editor, 1, 0); const original = editor.getJSON(); editor.setEditable(false);
  expect(insertTableAfter(editor, "row")).toBe(false); expect(insertTableAfter(editor, "column")).toBe(false);
  press(editor); press(editor, true); expect(editor.getJSON()).toEqual(original);
  const paragraph = make("<p>Ordinary text</p>"); paragraph.commands.setTextSelection(3);
  expect(insertTableAfter(paragraph, "column")).toBe(false);
  expect(press(paragraph, true).defaultPrevented).toBe(false);
});
