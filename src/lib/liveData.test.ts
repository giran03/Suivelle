import { describe, expect, it } from "vitest";
import { MUTATES_DATABASE } from "./liveData";

describe("MUTATES_DATABASE", () => {
  it("matches writes", () => {
    for (const c of ["record_set_value", "record_create", "record_duplicate", "property_update", "view_update", "page_delete"]) expect(MUTATES_DATABASE.test(c)).toBe(true);
  });
  it("never matches reads, which would loop with the views that refresh on writes", () => {
    for (const c of ["record_duplicates", "database_get", "database_list", "record_get", "record_lookup", "query_records", "chart_data", "view_aggregates", "pivot_data", "import_paste_table"]) expect(MUTATES_DATABASE.test(c)).toBe(false);
  });
});
