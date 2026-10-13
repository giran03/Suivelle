import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSearch, saveSearch, savedSearches } from "./savedSearches";

const store = new Map<string, string>();
describe("saved searches", () => {
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });

  it("keeps the newest first, without duplicates, per workspace", () => {
    saveSearch("w1", { query: "launch", titlesOnly: false, dayIdx: 0 });
    saveSearch("w1", { query: "budget", titlesOnly: true, dayIdx: 2 });
    saveSearch("w1", { query: "launch", titlesOnly: true, dayIdx: 1 });
    expect(savedSearches("w1").map((s) => s.query)).toEqual(["launch", "budget"]);
    expect(savedSearches("w1")[0]).toEqual({ query: "launch", titlesOnly: true, dayIdx: 1 });
    expect(savedSearches("w2")).toEqual([]);
    expect(forgetSearch("w1", "launch").map((s) => s.query)).toEqual(["budget"]);
  });

  it("ignores damaged storage", () => {
    store.set("suivelle.savedSearches.w1", "{not json");
    expect(savedSearches("w1")).toEqual([]);
    store.set("suivelle.savedSearches.w1", JSON.stringify([{ query: "" }, { nope: 1 }, { query: "ok", titlesOnly: false, dayIdx: 0 }]));
    expect(savedSearches("w1").map((s) => s.query)).toEqual(["ok"]);
  });
});
