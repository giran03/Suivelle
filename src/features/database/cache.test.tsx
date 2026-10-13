// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import type { DbView, RecordRow } from "../../types";
import { useRecordTable } from "./useRecordTable";
import { usePagedRecords } from "./usePagedRecords";
import { MAX_RECORD_PAGES } from "./recordCache";
import { useBoard } from "./BoardView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
const mount = async (component: React.ReactNode) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(component); });
};
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  host?.remove();
  vi.restoreAllMocks();
});
const row = (i: number) => ({ id: `r${i}`, title: `${i}`, values: {}, pageId: `p${i}` }) as RecordRow;
const view = { id: "v", config: {} } as DbView;
const collapsed = new Set<string>();

it("bounds fetched table pages, pins an editing row, and refetches an evicted page", async () => {
  const query = vi.spyOn(ipc, "queryRecords").mockImplementation(async (input) => {
    const offset = Number(input.cursor?.slice(2) ?? 0);
    return { rows: Array.from({ length: 100 }, (_, i) => row(offset + i)), total: input.skipTotal ? null : 50000, nextCursor: `o:${offset + 100}` };
  });
  let table!: ReturnType<typeof useRecordTable>;
  function Probe() { table = useRecordTable("db", view, 0, collapsed); return null; }
  await mount(<Probe />);
  for (let page = 1; page <= 25; page++) {
    await act(async () => { table.ensureRange(page * 100, page * 100 + 10, [0]); });
  }
  expect(table.loadedRows()).toHaveLength(MAX_RECORD_PAGES * 100);
  expect(table.rowAt(0)?.id).toBe("r0");
  expect(table.rowAt(100)).toBeNull();
  const before = query.mock.calls.length;
  await act(async () => { table.ensureRange(100, 110); });
  expect(query.mock.calls.length).toBe(before + 1);
  expect(table.rowAt(100)?.id).toBe("r100");
  expect(table.loadedRows()).toHaveLength(MAX_RECORD_PAGES * 100);
});

it("keeps grouped cache positions correct when groups are collapsed", async () => {
  const groupedView = { id: "v", config: { group: { propertyId: "status" } } } as DbView;
  vi.spyOn(ipc, "groupCounts").mockResolvedValue([{ key: "a", count: 2, subgroups: [] }, { key: "b", count: 2, subgroups: [] }]);
  vi.spyOn(ipc, "queryRecords").mockImplementation(async (input) => ({ rows: input.groupKey === "a" ? [row(0), row(1)] : [row(2), row(3)], total: null, nextCursor: null }));
  let table!: ReturnType<typeof useRecordTable>;
  const closed = new Set(["a"]);
  function Probe() { table = useRecordTable("db", groupedView, 0, closed); return null; }
  await mount(<Probe />);
  await act(async () => { table.ensureRange(0, 4); });
  expect(table.loadedRows().map(({ index, row }) => [index, row.id])).toEqual([[2, "r2"], [3, "r3"]]);
  expect(table.rowAt(2)?.id).toBe("r2");
});

it("clears stale previews on reload and stops preview batches after unmount", async () => {
  vi.spyOn(ipc, "queryRecords").mockResolvedValue({ rows: Array.from({ length: 200 }, (_, i) => row(i)), total: null, nextCursor: null });
  const preview = vi.spyOn(ipc, "recordPreviews").mockResolvedValue([{ recordId: "r0", text: "old" }] as Awaited<ReturnType<typeof ipc.recordPreviews>>);
  let data!: ReturnType<typeof usePagedRecords>;
  function Probe() { data = usePagedRecords({ databaseId: "db", viewId: "v", queryVersion: 0, pageSize: 200, previews: true }); return null; }
  await mount(<Probe />);
  expect(data.previews.r0?.text).toBe("old");
  let resolve!: (value: Awaited<ReturnType<typeof ipc.recordPreviews>>) => void;
  preview.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await act(async () => { data.reload(); });
  expect(data.previews).toEqual({});
  const calls = preview.mock.calls.length;
  await act(async () => { root!.unmount(); });
  root = undefined;
  await act(async () => { resolve([]); });
  expect(preview.mock.calls.length).toBe(calls);
});

it("limits board startup requests and stops queued columns after unmount", async () => {
  vi.spyOn(ipc, "groupCounts").mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ key: `g${i}`, count: 1, subgroups: [] })));
  const pending: (() => void)[] = [];
  const query = vi.spyOn(ipc, "queryRecords").mockImplementation(() => new Promise((done) => {
    pending.push(() => done({ rows: [row(0)], total: null, nextCursor: null }));
  }));
  function Probe() { useBoard("db", { id: "v", config: { group: { propertyId: "status" } } } as DbView, 0); return null; }
  await mount(<Probe />);
  expect(query).toHaveBeenCalledTimes(4);
  await act(async () => { root!.unmount(); });
  root = undefined;
  await act(async () => { pending.forEach((done) => done()); });
  expect(query).toHaveBeenCalledTimes(4);
});
