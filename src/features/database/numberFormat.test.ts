import { describe, expect, it } from "vitest";
import type { Property } from "../../types";
import { cellPlain, cellText, formatFormulaValue, formatNumber } from "./model";
import { barFraction, cleanFormat, formatNumberWith, isPlainFormat } from "./numberFormat";

const EN = "en-US";
const prop = (type: Property["type"], config: Property["config"] = {}): Property => ({ id: "p", databaseId: "d", name: "P", type, config, position: 1 });
const row = (v: unknown) => ({ title: "", uniqueId: 1, createdAt: "", updatedAt: "", values: { p: v } });

describe("formatNumberWith", () => {
  it("keeps the long-standing look without a format", () => {
    expect(formatNumberWith(1234.5, undefined, EN)).toBe("1,234.5");
    expect(formatNumberWith("x")).toBe("");
    expect(formatNumberWith(Number.NaN)).toBe("");
  });

  it("applies decimals, grouping, currency and units", () => {
    expect(formatNumberWith(1234.5, { decimals: 2, thousands: true }, EN)).toBe("1,234.50");
    expect(formatNumberWith(1234.5, { decimals: 0 }, EN)).toBe("1235");
    expect(formatNumberWith(1234.5, { thousands: false }, EN)).toBe("1234.5");
    expect(formatNumberWith(1234.5, { currency: "$", decimals: 2, thousands: true }, EN)).toBe("$1,234.50");
    expect(formatNumberWith(-5, { currency: "$" }, EN)).toBe("-$5");
    expect(formatNumberWith(72, { unit: "kg" }, EN)).toBe("72 kg");
    expect(formatNumberWith(21, { unit: "°C" }, EN)).toBe("21°C");
  });

  it("shows a fraction as a percent", () => {
    expect(formatNumberWith(0.256, { percent: true, decimals: 1 }, EN)).toBe("25.6%");
    expect(formatNumberWith(0.5, { percent: true }, EN)).toBe("50%");
  });

  it("does not print a negative zero", () => {
    expect(formatNumberWith(-0.0001, { decimals: 2 }, EN)).toBe("0.00");
  });
});

describe("progress bar", () => {
  it("fills toward the maximum and clamps", () => {
    expect(barFraction(25, { bar: true })).toBe(0.25);
    expect(barFraction(150, { bar: true })).toBe(1);
    expect(barFraction(-5, { bar: true })).toBe(0);
    expect(barFraction(5, { bar: true, barMax: 20 })).toBe(0.25);
    expect(barFraction(0.5, { bar: true, percent: true })).toBe(0.5);
    expect(barFraction(5, { bar: false })).toBeNull();
    expect(barFraction("5", { bar: true })).toBeNull();
  });
});

describe("cleanFormat", () => {
  it("drops defaults and reports a plain format as nothing", () => {
    expect(cleanFormat({ thousands: false, currency: " ", unit: "" })).toBeUndefined();
    expect(cleanFormat({ decimals: 2, currency: " $ ", bar: false, barMax: 5 })).toEqual({ decimals: 2, currency: "$" });
    expect(isPlainFormat({})).toBe(true);
    expect(isPlainFormat({ decimals: 0 })).toBe(false);
  });
});

describe("cells with a format", () => {
  const money = { decimals: 2, thousands: true, currency: "$" };
  it("displays the format but copies the plain value", () => {
    const p = prop("number", { format: money });
    expect(cellText(p, row(1234.5))).toBe(formatNumberWith(1234.5, money));
    expect(cellText(p, row(1234.5))).toContain("$");
    expect(cellPlain(p, row(1234.5))).toBe(formatNumber(1234.5));
    expect(cellPlain(p, row(1234.5))).not.toContain("$");
  });

  it("applies to number rollups and number formulas, not to percent rollups or text formulas", () => {
    expect(cellText(prop("rollup", { function: "sum", format: { currency: "€" } }), row(5))).toBe("€5");
    expect(cellText(prop("rollup", { function: "percent_checked", format: { currency: "€" } }), row(50))).toBe("50%");
    expect(cellText(prop("formula", { resultType: "number", format: { unit: "pts" } }), row(4))).toBe("4 pts");
    expect(cellText(prop("formula", { resultType: "text", format: { unit: "pts" } }), row("4"))).toBe("4");
    expect(cellPlain(prop("formula", { resultType: "number", format: { unit: "pts" } }), row(4))).toBe("4");
    expect(formatFormulaValue(7, { currency: "$" })).toBe("$7");
  });
});
