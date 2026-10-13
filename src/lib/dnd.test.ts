import { describe, expect, it } from "vitest";
import type { Page } from "../types";
import { dropZone, isInSubtree, resolveDrop } from "./dnd";

const page = (id: string, parentPageId: string | null = null): Page => ({
  id, workspaceId: "w", parentPageId, title: id, icon: null, cover: null, position: 0, favorite: false,
  archived: false, deletedAt: null, revision: 1, createdAt: "", updatedAt: "", childCount: 0, kind: "page",
});

describe("dropZone", () => {
  it("maps pointer height to zones", () => {
    expect(dropZone(102, 100, 28)).toBe("before");
    expect(dropZone(114, 100, 28)).toBe("inside");
    expect(dropZone(126, 100, 28)).toBe("after");
  });
});

describe("resolveDrop", () => {
  const a = page("a"), b = page("b"), c = page("c"), kid = page("kid", "b");
  const siblingsOf = (p: string | null) => (p === null ? [a, b, c] : p === "b" ? [kid] : []);

  it("drops inside as last child", () => {
    expect(resolveDrop("a", b, "inside", siblingsOf)).toEqual({ parentPageId: "b", beforePageId: null });
  });
  it("drops before a row under the same parent", () => {
    expect(resolveDrop("c", a, "before", siblingsOf)).toEqual({ parentPageId: null, beforePageId: "a" });
    expect(resolveDrop("a", kid, "before", siblingsOf)).toEqual({ parentPageId: "b", beforePageId: "kid" });
  });
  it("drops after by targeting the next sibling, skipping the dragged page", () => {
    expect(resolveDrop("c", a, "after", siblingsOf)).toEqual({ parentPageId: null, beforePageId: "b" });
    expect(resolveDrop("b", a, "after", siblingsOf)).toEqual({ parentPageId: null, beforePageId: "c" });
    expect(resolveDrop("a", c, "after", siblingsOf)).toEqual({ parentPageId: null, beforePageId: null });
  });
});

describe("isInSubtree", () => {
  const pages = new Map([page("a"), page("b", "a"), page("c", "b"), page("x")].map((p) => [p.id, p]));
  const lookup = (id: string) => pages.get(id);
  it("detects self and descendants only", () => {
    expect(isInSubtree("a", "a", lookup)).toBe(true);
    expect(isInSubtree("a", "c", lookup)).toBe(true);
    expect(isInSubtree("b", "a", lookup)).toBe(false);
    expect(isInSubtree("a", "x", lookup)).toBe(false);
  });
});
