import type { Editor } from "@tiptap/core";
import { create } from "zustand";

interface ActiveEditorState {
  /** The editor of the page on screen, once its content has loaded; null on databases, trash and so on. */
  editor: Editor | null;
  set: (editor: Editor | null) => void;
}

/** Lets app-level tools (find in page, the page outline) reach the open page's editor. */
export const useActiveEditor = create<ActiveEditorState>((set) => ({
  editor: null,
  set: (editor) => set({ editor }),
}));
