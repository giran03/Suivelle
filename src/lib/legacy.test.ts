// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { LEGACY_NAME, LEGACY_PAGE_LINK, migrateStorage, pageLinkTarget } from "./legacy";
beforeEach(() => localStorage.clear());
it("migrates saved keys without overwriting newer preferences", () => {
  localStorage.setItem(`${LEGACY_NAME}.workspace`, "old-workspace");
  localStorage.setItem(`${LEGACY_NAME}.layout`, "old-layout");
  localStorage.setItem("suivelle.layout", "new-layout");
  localStorage.setItem("unrelated", "keep");
  migrateStorage();
  expect(localStorage.getItem("suivelle.workspace")).toBe("old-workspace");
  expect(localStorage.getItem("suivelle.layout")).toBe("new-layout");
  expect(localStorage.getItem(`${LEGACY_NAME}.workspace`)).toBeNull();
  expect(localStorage.getItem("unrelated")).toBe("keep");
  migrateStorage();
  expect(localStorage.getItem("suivelle.workspace")).toBe("old-workspace");
});
it("recognizes old and new page links", () => {
  expect(pageLinkTarget(`${LEGACY_PAGE_LINK}page-id#block`)).toBe("page-id#block");
  expect(pageLinkTarget("suivelle://page/page-id")).toBe("page-id");
  expect(pageLinkTarget("https://example.com")).toBeNull();
});
