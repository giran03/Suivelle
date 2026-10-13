import { describe, expect, it } from "vitest";
import { formatBytes } from "./BackupsDialog";

describe("formatBytes", () => {
  it("scales units and keeps small numbers readable", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});
