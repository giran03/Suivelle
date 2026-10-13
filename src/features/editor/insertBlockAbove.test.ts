// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, expect, it } from "vitest";
import { buildExtensions } from "./extensions";
import { insertBlockAbove } from "./commands";
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach(e => e.destroy()));
const make = (content: string) => { const e = new Editor({extensions: buildExtensions(), content}); editors.push(e); return e; };
it("Ctrl+Enter inserts plain text above the current heading, moves the caret, preserves content and undoes", () => {
  const e = make('<p>Before</p><h2><strong>Keep this</strong></h2>');
  const pos = e.state.doc.firstChild!.nodeSize;
  e.commands.setTextSelection(pos + 4);
  const original = e.getJSON();
  const key = new KeyboardEvent('keydown', {key:'Enter', ctrlKey:true, bubbles:true, cancelable:true});
  e.view.dom.dispatchEvent(key); expect(key.defaultPrevented).toBe(true);
  const added = e.state.doc.child(1);
  expect(added.type.name).toBe('paragraph'); expect(added.content.size).toBe(0);
  expect(added.attrs.blockId).toBeTruthy();
  expect(e.state.selection.from).toBe(pos + 1);
  expect(e.state.doc.child(2).toJSON()).toEqual(original.content![1]);
  expect(e.state.storedMarks ?? []).toEqual([]);
  e.commands.undo(); expect(e.getJSON()).toEqual(original);
});
it("takes precedence over code-block exit and handles an atom at the top of the document", () => {
  const e = make('<pre><code>keep code</code></pre>'); e.commands.setTextSelection(4);
  e.view.dom.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', ctrlKey:true, bubbles:true, cancelable:true}));
  expect(e.state.doc.firstChild!.type.name).toBe('paragraph');
  expect(e.state.doc.child(1).type.name).toBe('codeBlock');
  const atom = make('<hr>');
  atom.view.dispatch(atom.state.tr.setSelection(NodeSelection.create(atom.state.doc, 0)));
  expect(insertBlockAbove(atom)).toBe(true);
  expect(atom.state.doc.firstChild!.type.name).toBe('paragraph');
  expect(atom.state.doc.child(1).type.name).toBe('horizontalRule');
});
it("keeps nested blocks in their column, safely inserts above a list and respects read-only mode", () => {
  const e = make('<ul><li>Keep item</li></ul>'); e.commands.setTextSelection(3);
  expect(insertBlockAbove(e)).toBe(true);
  expect(e.state.doc.firstChild!.type.name).toBe('paragraph');
  expect(e.state.doc.child(1).textContent).toBe('Keep item');
  e.commands.setContent({type:'doc',content:[{type:'columns',content:[{type:'column',content:[{type:'paragraph',content:[{type:'text',text:'Nested'}]}]},{type:'column',content:[{type:'paragraph'}]}]}]});
  e.commands.setTextSelection(4); expect(insertBlockAbove(e)).toBe(true);
  expect(e.state.doc.firstChild!.firstChild!.childCount).toBe(2);
  const original = e.getJSON(); e.setEditable(false);
  expect(insertBlockAbove(e)).toBe(false); expect(e.getJSON()).toEqual(original);
});
