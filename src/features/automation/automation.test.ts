import { describe, expect, it } from "vitest";
import type { Action, Property, Trigger } from "../../types";
import { defaultValue, describeAction, describeTrigger, isSettable, newAction, newTrigger, problemWith, triggerHasRecord } from "./automation";

const opt = (id: string, name: string, group?: "todo" | "doing" | "done") => ({ id, name, color: "gray" as const, group });
const prop = (id: string, name: string, type: Property["type"], config: Property["config"] = {}): Property => ({ id, databaseId: "d", name, type, config, position: 0 });
const props = [
  prop("t", "Name", "title"),
  prop("s", "Status", "status", { options: [opt("a", "To do", "todo"), opt("b", "Done", "done")] }),
  prop("c", "Done?", "checkbox"),
  prop("d", "Due", "date"),
  prop("n", "Points", "number"),
  prop("b", "Finish", "button", { label: "Finish it" }),
  prop("f", "Calc", "formula"),
];

describe("automation helpers", () => {
  it("offers only properties people can set", () => {
    expect(props.filter(isSettable).map((p) => p.id)).toEqual(["s", "c", "d", "n"]);
  });

  it("starts triggers and actions with usable defaults", () => {
    expect(newTrigger("button", props)).toEqual({ type: "button", propertyId: "b" });
    expect(newTrigger("date_reached", props)).toMatchObject({ propertyId: "d", offsetDays: 0, time: "09:00" });
    expect(newTrigger("schedule", props)).toMatchObject({ every: "daily" });
    expect(newTrigger("record_created", props)).toEqual({ type: "record_created" });
    expect(newAction("set_status", props)).toEqual({ type: "set_status", propertyId: "s", optionId: "b" });
    expect(newAction("update_properties", props)).toEqual({ type: "update_properties", values: { s: "a" } });
    expect(defaultValue(prop("x", "X", "date"))).toEqual({ start: "{{today}}" });
    expect(defaultValue(prop("x", "X", "checkbox"))).toBe(true);
  });

  it("describes triggers and actions in words", () => {
    expect(describeTrigger({ type: "property_changed", propertyId: "s", to: "b" }, props)).toBe("When Status changes to “Done”");
    expect(describeTrigger({ type: "property_changed", propertyId: "c" }, props)).toBe("When Done? changes");
    expect(describeTrigger({ type: "date_reached", propertyId: "d", offsetDays: -2, time: "08:30" }, props)).toContain("2 days before");
    expect(describeTrigger({ type: "schedule", every: "weekly", interval: 1, time: "18:00", days: [0, 4] }, props)).toBe("Every Mon, Fri at 18:00");
    expect(describeTrigger({ type: "schedule", every: "minutes", interval: 1, time: "", days: [] }, props)).toBe("Every minute");
    expect(describeTrigger({ type: "button", propertyId: "b" }, props)).toBe("When the “Finish it” button is pressed");
    expect(describeTrigger({ type: "button", propertyId: "gone" }, props)).toContain("no longer exists");
    expect(describeAction({ type: "update_properties", values: { c: true, d: { start: "{{today}}" } } }, props)).toBe("Set Done? = checked, Due = today");
    expect(describeAction({ type: "set_status", propertyId: "s", optionId: "b" }, props)).toBe("Set Status to “Done”");
    expect(describeAction({ type: "notify", title: "Hi" }, props)).toBe("Notify “Hi”");
  });

  it("explains why an automation cannot be saved", () => {
    const record: Trigger = { type: "record_created" };
    const ok: Action[] = [{ type: "update_properties", values: { c: true } }];
    expect(problemWith("Name", record, ok, props)).toBeNull();
    expect(problemWith("  ", record, ok, props)).toMatch(/name/);
    expect(problemWith("x", record, [], props)).toMatch(/action/);
    expect(problemWith("x", { type: "button", propertyId: "" }, ok, props)).toMatch(/button/);
    expect(problemWith("x", { type: "schedule", every: "weekly", interval: 1, time: "09:00", days: [] }, [{ type: "notify", title: "x" }], props)).toMatch(/day/);
    expect(problemWith("x", { type: "app_started" }, ok, props)).toMatch(/no record/);
    expect(problemWith("x", record, [{ type: "trash_record" }, ...ok], props)).toMatch(/last/);
    expect(problemWith("x", record, [{ type: "notify", title: " " }], props)).toMatch(/title/);
    expect(problemWith("x", record, [{ type: "update_properties", values: {} }], props)).toMatch(/property/);
    expect(triggerHasRecord({ type: "app_started" })).toBe(false);
    expect(triggerHasRecord({ type: "button", propertyId: "b" })).toBe(true);
  });
});
