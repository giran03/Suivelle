import { expect, it } from "vitest";
import { imagePresentation } from "./imageModel";
import { blocksToDoc, docToBlocks } from "./convert";
import { presetCrop, resizeCrop } from "./ImageCrop";
it("round-trips image settings independently of attachment identity", () => {
  const presentation = {
    align: "center",
    caption: "A view",
    alt: "Mountains",
    width: 480,
    widthMode: "px",
    note: "Private context",
  };
  const rows = [
    {
      id: "img1",
      parentBlockId: null,
      type: "image" as const,
      position: 1,
      schemaVersion: 2,
      dataJson: JSON.stringify({
        attachment: {
          id: "att",
          hash: "hash",
          name: "photo.png",
          mime: "image/png",
          size: 42,
        },
        presentation,
      }),
    },
  ];
  expect(JSON.parse(docToBlocks(blocksToDoc(rows))[0].dataJson)).toEqual(
    JSON.parse(rows[0].dataJson),
  );
});
it("normalizes invalid widths and rejects crops outside the source", () => {
  expect(
    imagePresentation({
      width: Infinity,
      crop: { x: 0.9, y: 0, width: 0.3, height: 1 },
    }),
  ).toEqual({});
  expect(imagePresentation({ width: 150, widthMode: "percent" }).width).toBe(
    100,
  );
});
it("fits crop presets within the original while retaining their real aspect ratio", () => {
  for (const source of [0.5, 1, 2])
    for (const ratio of [1, 4 / 3, 16 / 9]) {
      const c = presetCrop({ x: 0, y: 0, width: 1, height: 1 }, ratio, source);
      expect((c.width / c.height) * source).toBeCloseTo(ratio);
      expect(c.x + c.width).toBeLessThanOrEqual(1);
      expect(c.y + c.height).toBeLessThanOrEqual(1);
    }
});
it("resizes from every edge and corner within source bounds while preserving locked ratios", () => {
  const crop = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const)
    for (const delta of [-2, -0.1, 0.1, 2]) {
      const result = resizeCrop(crop, handle, delta, delta, 2, 2);
      expect(result.x).toBeGreaterThanOrEqual(-1e-9);
      expect(result.y).toBeGreaterThanOrEqual(-1e-9);
      expect(result.x + result.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(result.y + result.height).toBeLessThanOrEqual(1 + 1e-9);
      expect(result.width).toBeGreaterThan(0);
      expect(result.width / result.height).toBeCloseTo(1);
      if (handle.includes("w")) expect(result.x + result.width).toBeCloseTo(0.6);
      if (handle.includes("n")) expect(result.y + result.height).toBeCloseTo(0.6);
    }
});
it("freeform edge resizing changes one dimension and keeps the opposite edge fixed", () => {
  const crop = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  const west = resizeCrop(crop, "w", -0.1, 0.2, null, 2);
  expect(west.x).toBeCloseTo(0.1);
  expect(west.width).toBeCloseTo(0.5);
  expect(west.y).toBeCloseTo(crop.y);
  expect(west.height).toBe(crop.height);
  const north = resizeCrop(crop, "n", 0.2, 0.1, null, 2);
  expect(north.y).toBeCloseTo(0.3);
  expect(north.height).toBeCloseTo(0.3);
  expect(north.x).toBeCloseTo(crop.x);
  expect(north.width).toBe(crop.width);
});
