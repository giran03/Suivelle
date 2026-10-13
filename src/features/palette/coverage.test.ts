import { describe, expect, it } from "vitest";
import { ACTIONS } from "../shortcuts/bindings";
import { COMMANDS } from "./commands";

/** Workspace shortcuts handled directly by the app shell rather than as palette commands. */
const SHELL_HANDLED = new Set(["search", "next-tab", "previous-tab", "close-tab"]);

describe("command palette coverage", () => {
  it("offers every workspace shortcut as a command, so nothing is reachable only by a key", () => {
    const commands = new Set(COMMANDS.map((c) => c.id));
    const missing = ACTIONS.filter((a) => a.scope === "workspace" && !commands.has(a.id) && !SHELL_HANDLED.has(a.id)).map((a) => a.id);
    expect(missing).toEqual([]);
  });

  it("gives every command a unique id and a title", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(COMMANDS.every((c) => c.title.trim().length > 0)).toBe(true);
  });
});
