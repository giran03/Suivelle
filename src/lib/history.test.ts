import { describe, expect, it } from "vitest";
import { back, canBack, canForward, current, emptyHistory, forward, push, remove } from "./history";

const visit = (...ids: string[]) => ids.reduce(push, emptyHistory);

describe("history", () => {
  it("tracks visits and ignores revisiting the current page", () => {
    const h = push(visit("a", "b"), "b");
    expect(h.stack).toEqual(["a", "b"]);
    expect(current(h)).toBe("b");
  });

  it("goes back and forward within bounds", () => {
    let h = visit("a", "b", "c");
    expect(canForward(h)).toBe(false);
    h = back(back(h));
    expect(current(h)).toBe("a");
    expect(canBack(h)).toBe(false);
    expect(back(h)).toBe(h);
    h = forward(h);
    expect(current(h)).toBe("b");
  });

  it("drops forward entries when visiting from the middle", () => {
    const h = push(back(visit("a", "b", "c")), "d");
    expect(h.stack).toEqual(["a", "b", "d"]);
    expect(canForward(h)).toBe(false);
  });

  it("removes deleted ids and keeps a valid position", () => {
    const h = remove(back(visit("a", "b", "c")), new Set(["b"]));
    expect(h.stack).toEqual(["a", "c"]);
    expect(current(h)).toBe("a");
    expect(remove(visit("a"), new Set(["a"]))).toEqual({ stack: [], index: -1 });
  });

  it("caps the stack length", () => {
    const h = visit(...Array.from({ length: 150 }, (_, i) => String(i)));
    expect(h.stack).toHaveLength(100);
    expect(current(h)).toBe("149");
  });
});
