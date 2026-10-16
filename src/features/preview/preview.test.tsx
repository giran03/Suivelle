// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { usePeek } from "../peek/store";
import { PagePreviewCard } from "./PagePreviewCard";
import { installPagePreview } from "./install";
import { hidePreview, invalidatePreview, usePreviewCard } from "./store";

vi.mock("@floating-ui/dom", () => ({
  autoUpdate: (_anchor: unknown, _card: unknown, update: () => void) => { update(); return () => {}; },
  computePosition: async () => ({ x: 10, y: 10 }),
  flip: () => ({}), offset: () => ({}), shift: () => ({}),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let stop: () => void;
let link: HTMLElement;
const pointer = (target: Element, type: string, relatedTarget: Element | null = null) => {
  const event = new MouseEvent(type, { bubbles: true, relatedTarget });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
};
const wait = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const card = () => document.querySelector<HTMLElement>("[data-page-preview]")!;

beforeEach(async () => {
  vi.useFakeTimers();
  invalidatePreview();
  vi.spyOn(ipc, "pagePreview").mockResolvedValue({ id: "page", title: "Preview page", icon: null, deleted: false, imageHash: null, lines: [{ kind: "paragraph", text: "A linked page." }] });
  document.body.innerHTML = '<div class="ProseMirror"><span class="mention" data-page-id="page">Page</span></div><div id="preview-host"></div>';
  link = document.querySelector(".mention")!;
  root = createRoot(document.getElementById("preview-host")!);
  await act(async () => root.render(<PagePreviewCard />));
  stop = installPagePreview();
  pointer(link, "pointerover");
  await wait(350);
  expect(card()).not.toBeNull();
});
afterEach(async () => {
  stop();
  await act(async () => { root.unmount(); hidePreview(); });
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("cancels delayed dismissal when entering the card and moving between its children", async () => {
  pointer(link, "pointerout", document.body);
  pointer(document.body, "pointerover", link);
  await wait(100);
  pointer(card(), "pointerover", document.body);
  await wait(1000);
  expect(usePreviewCard.getState().pageId).toBe("page");
  const button = card().querySelector("button")!;
  pointer(card(), "pointerout", button);
  pointer(button, "pointerover", card());
  await wait(1000);
  expect(card()).not.toBeNull();
  pointer(button, "pointerout", document.body);
  pointer(document.body, "pointerover", button);
  await wait(160);
  expect(card()).toBeNull();
});

it.each([false, true])("lets the preview button complete its click (beside: %s)", async (beside) => {
  const open = vi.spyOn(useWorkspace.getState(), "openPage").mockResolvedValue();
  const peek = vi.spyOn(usePeek.getState(), "show").mockImplementation(() => {});
  const button = card().querySelectorAll("button")[beside ? 1 : 0];
  pointer(button, "pointerover", link);
  await act(async () => pointer(button, "pointerdown"));
  expect(card()).not.toBeNull();
  await act(async () => button.click());
  expect(beside ? peek : open).toHaveBeenCalledWith("page");
  expect(card()).toBeNull();
});

it("ignores scroll inside the preview and still dismisses on outside clicks and Escape", async () => {
  pointer(card(), "pointerover", link);
  await act(async () => card().dispatchEvent(new Event("scroll")));
  expect(card()).not.toBeNull();
  await act(async () => pointer(document.body, "pointerdown"));
  expect(card()).toBeNull();
  pointer(link, "pointerover");
  await wait(350);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(card()).toBeNull();
});
