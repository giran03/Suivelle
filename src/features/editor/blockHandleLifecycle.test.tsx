// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import { expect, it, vi } from "vitest";
import { buildExtensions } from "./extensions";
import { BlockHandle } from "./BlockHandle";
import { blockDragKey } from "./blockDrag";
import { blockDragPlugin } from "./blockDrag";
import { Editor } from "@tiptap/core";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("mounts block controls safely during the real React editor lifecycle", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let current: ReturnType<typeof useEditor>;
  function Document() {
    const editor = useEditor({ extensions: buildExtensions(), content: '<p>A thought</p>' });
    current = editor;
    return <><EditorContent editor={editor} />{editor && <BlockHandle editor={editor} />}</>;
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<StrictMode><Document /></StrictMode>));
    expect(host.querySelector('.doc, .tiptap')?.textContent).toBe("A thought");
    expect(current!.state.plugins.filter(plugin => plugin.spec.key === blockDragKey)).toHaveLength(1);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it("replaces a retained drag plugin when block controls remount", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const editor = new Editor({ extensions: buildExtensions(), content: '<p>Keep this content</p>' });
  const retained = blockDragPlugin(() => {});
  editor.registerPlugin(retained);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<StrictMode><BlockHandle editor={editor} /></StrictMode>));
    expect(editor.state.plugins.filter(plugin => plugin.spec.key === blockDragKey)).toHaveLength(1);
    expect(blockDragKey.get(editor.state)).not.toBe(retained);
    expect(editor.getText()).toBe("Keep this content");
    await act(async () => root.render(null));
    expect(blockDragKey.get(editor.state)).toBeUndefined();
  } finally { await act(async () => root.unmount()); editor.destroy(); host.remove(); vi.unstubAllGlobals(); }
});
