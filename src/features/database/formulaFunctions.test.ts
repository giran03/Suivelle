import { describe, expect, it } from "vitest";
import {
  FORMULA_FUNCTIONS,
  activeParam,
  completionAt,
  errorSpan,
  functionAtCursor,
  suggestFunctions,
  suggestProperties,
} from "./formulaFunctions";

describe("catalogue", () => {
  it("has unique names that match their signatures", () => {
    const names = FORMULA_FUNCTIONS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of FORMULA_FUNCTIONS) {
      expect(f.name).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      expect(f.signature.startsWith(`${f.name}(`)).toBe(true);
      expect(f.signature.endsWith(")")).toBe(true);
      expect(f.description.length).toBeGreaterThan(0);
    }
  });

  it("covers the Excel-style functions", () => {
    for (const n of ["and", "or", "not", "switch", "iferror", "coalesce", "mod", "pow", "sqrt", "sum", "average", "median"]) {
      expect(names()).toContain(n);
    }
    for (const n of ["lower", "upper", "trim", "replaceAll", "split", "join", "padStart", "year", "dateBetween", "startOf", "endOf", "first", "at", "unique", "sort"]) {
      expect(names()).toContain(n);
    }
  });
});

function names() {
  return FORMULA_FUNCTIONS.map((f) => f.name);
}

describe("suggestions", () => {
  it("lists prefix matches before partial matches", () => {
    const out = suggestFunctions("da").map((f) => f.name);
    expect(out.slice(0, 4)).toEqual(["dateAdd", "dateSubtract", "dateBetween", "day"]);
    expect(out).toContain("formatDate");
    expect(suggestFunctions("")).toEqual([]);
    expect(suggestFunctions("zzz")).toEqual([]);
  });

  it("filters property names ignoring case", () => {
    expect(suggestProperties(["Price", "Unit price", "Name"], "pri")).toEqual(["Price", "Unit price"]);
  });
});

describe("completionAt", () => {
  it("completes a function name being typed", () => {
    const text = "1 + ro";
    expect(completionAt(text, text.length)).toEqual({ kind: "function", prefix: "ro", from: 4, to: 6 });
    expect(completionAt("1 + ", 4)).toBeNull();
  });

  it("completes inside prop(\"", () => {
    const text = 'prop("Pr';
    expect(completionAt(text, text.length)).toEqual({ kind: "property", prefix: "Pr", from: 6, to: 8, closed: false });
    const closed = 'prop("Pr") + 1';
    expect(completionAt(closed, 8)).toEqual({ kind: "property", prefix: "Pr", from: 6, to: 8, closed: true });
  });

  it("does not complete in other strings or after a finished string", () => {
    expect(completionAt('concat("ab', 10)).toBeNull();
    expect(completionAt('prop("A")', 9)).toBeNull();
  });
});

describe("functionAtCursor", () => {
  it("finds the call and the argument", () => {
    const text = "round(prop(\"A\"), ";
    const hit = functionAtCursor(text, text.length);
    expect(hit?.fn.name).toBe("round");
    expect(hit?.argIndex).toBe(1);
  });

  it("ignores commas in strings and finished calls", () => {
    const text = 'if(contains("a,b", "x"), ';
    expect(functionAtCursor(text, text.length)).toMatchObject({ argIndex: 1 });
    expect(functionAtCursor(text, text.length)?.fn.name).toBe("if");
    expect(functionAtCursor("round(1)", 8)).toBeNull();
  });

  it("falls back to the enclosing known function", () => {
    const text = "max(1, (2 + ";
    expect(functionAtCursor(text, text.length)?.fn.name).toBe("max");
  });

  it("highlights a repeating argument", () => {
    expect(activeParam("min(a, b, …)", 5)).toBe(2);
    expect(activeParam("round(number, digits)", 7)).toBe(1);
    expect(activeParam("now()", 0)).toBe(0);
  });
});

describe("errorSpan", () => {
  it("covers the token at the position", () => {
    const text = "1 + frob(2)";
    const span = errorSpan(text, 4);
    expect(text.slice(span.start, span.end)).toBe("frob");
    expect(span.line).toBe(text);
  });

  it("covers a whole string and handles the end of the text", () => {
    const text = 'x + "open"';
    const span = errorSpan(text, 4);
    expect(text.slice(span.start, span.end)).toBe('"open"');
    const end = errorSpan("1 + ", 4);
    expect(end.start).toBe(4);
    expect(end.end).toBe(4);
  });

  it("works on the failing line and counts characters, not UTF-16 units", () => {
    const text = "ok\n😀 + $";
    const span = errorSpan(text, 7);
    expect(text.slice(span.start, span.end)).toBe("$");
    expect(span.line).toBe("😀 + $");
  });
});
