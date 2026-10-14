import { expect, it } from "vitest";
import { ACTIONS, bindingError, conflicts, effective, fromEvent, key, matches, mouse, resolve, sanitize } from "./bindings";
const event = (value: string, patch = {}) => ({ key: value, code: `Key${value.toUpperCase()}`, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...patch });
it("matches exact modifiers and physical/logical keys independently", () => {
  expect(matches(key("k", "Control"), event("k", { ctrlKey: true }))).toBe(true);
  expect(matches(key("k", "Control"), event("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
  expect(matches({ kind: "key", key: "KeyQ", mode: "physical", modifiers: [] }, event("a", { code: "KeyQ" }))).toBe(true);
  expect(matches({ kind: "key", key: "Enter", modifiers: [], location: 3 }, event("Enter", { location: 0 }))).toBe(false);
  const physical = fromEvent(event("x", { ctrlKey: true }), "physical")!;
  expect(conflicts("sidebar", physical, {}).map(a => a.id)).not.toContain("search");
});
it("ignores composing, AltGraph, modifier-only and repeating command inputs", () => {
  expect(fromEvent(event("k", { isComposing: true }))).toBeNull();
  expect(fromEvent(event("k", { getModifierState: () => true }))).toBeNull();
  expect(fromEvent(event("Control"))).toBeNull();
  expect(resolve(event("k", { ctrlKey: true, repeat: true }), "workspace", {})).toBeUndefined();
});
it("detects overlapping contexts and permits disjoint mouse bindings", () => {
  expect(conflicts("tab-close", mouse(1), {})).toEqual([]);
  expect(conflicts("sidebar", mouse(1), {}).map(a => a.id)).toContain("tab-close");
  expect(conflicts("sidebar", key("k", "Control"), {}).map(a => a.id)).toContain("search");
  expect(bindingError("sidebar", mouse(0))).toBeTruthy();
});
it("keeps disabled overrides distinct from defaults and validates persisted inputs", () => {
  expect(effective("search", { search: [] })).toEqual([]);
  expect(effective("search", {})).toHaveLength(1);
  expect(sanitize({ version: 1, overrides: { search: [], bad: [{ kind: "mouse", button: -1, modifiers: [] }] } })).toEqual({ search: [] });
  expect(sanitize({ version: 9, overrides: { search: [] } })).toEqual({});
});
it("ships defaults without collisions within overlapping scopes", () => {
  for (const a of ACTIONS) for (const b of a.defaults) expect(conflicts(a.id, b, {}).map(x => x.id), a.id).toEqual([]);
});
