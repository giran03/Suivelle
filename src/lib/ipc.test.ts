import { describe, expect, it } from "vitest";
import { toAppError } from "./ipc";

describe("toAppError", () => {
  it("passes typed backend errors through", () => {
    const e = { code: "validation", message: "bad" };
    expect(toAppError(e)).toEqual(e);
  });

  it("wraps framework string rejections as invalid_argument", () => {
    expect(toAppError("missing field `input`")).toEqual({
      code: "invalid_argument",
      message: "missing field `input`",
    });
  });
});
