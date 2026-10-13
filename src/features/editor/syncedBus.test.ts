import { describe, expect, it, vi } from "vitest";
import { announceSyncedSaved, onSyncedSaved } from "./syncedBus";

describe("synced save announcements", () => {
  it("reach only the views of the same synced page", () => {
    const a = vi.fn();
    const b = vi.fn();
    const off = [onSyncedSaved("page-a", a), onSyncedSaved("page-b", b)];
    announceSyncedSaved("page-a");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    off.forEach((f) => f());
  });

  it("reach every listener, and stop after unsubscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = onSyncedSaved("p", first);
    const offSecond = onSyncedSaved("p", second);
    announceSyncedSaved("p");
    offFirst();
    announceSyncedSaved("p");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    offSecond();
    announceSyncedSaved("p");
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("is safe to announce to a page nobody is watching, and a listener may unsubscribe while being called", () => {
    expect(() => announceSyncedSaved("nobody")).not.toThrow();
    let off = () => {};
    const once = vi.fn(() => off());
    off = onSyncedSaved("q", once);
    announceSyncedSaved("q");
    announceSyncedSaved("q");
    expect(once).toHaveBeenCalledTimes(1);
  });
});
