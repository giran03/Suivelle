import { describe, expect, it } from "vitest";
import type { FormSpec, Property } from "../../types";
import { isBlank, shownFields, toValues, validate } from "./form";

const prop = (id: string, name: string, type: Property["type"]): Property => ({ id, databaseId: "d", name, type, config: {}, position: 0 });
const props = [prop("t", "Name", "title"), prop("n", "Qty", "number"), prop("e", "Email", "email"), prop("d", "When", "date"), prop("k", "Agree", "checkbox"), prop("f", "Total", "formula"), prop("c", "Created", "created_time")];

describe("forms", () => {
  it("asks for every fillable property by default, title required", () => {
    const fields = shownFields(null, props);
    expect(fields.map((f) => f.prop.id)).toEqual(["t", "n", "e", "d", "k"]);
    expect(fields[0].field.required).toBe(true);
  });

  it("skips fields whose property is gone or cannot be filled in", () => {
    const spec: FormSpec = { fields: [{ propertyId: "t", required: true }, { propertyId: "zz", required: false }, { propertyId: "f", required: false }, { propertyId: "n", required: false }] };
    expect(shownFields(spec, props).map((f) => f.prop.id)).toEqual(["t", "n"]);
  });

  it("validates required, numeric and email fields", () => {
    const spec: FormSpec = { fields: [{ propertyId: "t", required: true }, { propertyId: "n", required: true }, { propertyId: "e", required: false }, { propertyId: "k", required: true, label: "Terms" }] };
    const fields = shownFields(spec, props);
    expect(validate(fields, {})).toEqual({ t: "Name is required", n: "Qty is required", k: "Terms must be checked" });
    expect(validate(fields, { t: "A", n: "abc", e: "nope", k: true })).toEqual({ n: "Qty must be a number", e: "Email must be an email address" });
    expect(validate(fields, { t: "A", n: "3", e: "a@b.co", k: true })).toEqual({});
    expect(validate(fields, { t: "  ", n: "3", k: true })).toEqual({ t: "Name is required" });
  });

  it("builds the payload the backend expects", () => {
    const fields = shownFields(null, props);
    expect(toValues(fields, { t: "Order", n: "4.5", d: "2026-10-07", k: true, e: "  a@b.co " })).toEqual({ n: 4.5, d: { start: "2026-10-07" }, k: true, e: "a@b.co" });
    expect(toValues(fields, { t: "Order", n: "", k: false, e: "  " })).toEqual({});
  });

  it("knows what is blank", () => {
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank(" ")).toBe(true);
    expect(isBlank(false)).toBe(true);
    expect(isBlank([])).toBe(true);
    expect(isBlank("0")).toBe(false);
    expect(isBlank(true)).toBe(false);
    expect(isBlank(["a"])).toBe(false);
  });
});
