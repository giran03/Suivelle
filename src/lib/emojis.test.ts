import { expect, it } from "vitest";
import { EMOJIS, EMOJI_CATEGORIES, searchEmojis } from "./emojis";

it("contains all 3,944 fully-qualified Unicode 17.0 emojis in nine categories", () => {
  expect(EMOJI_CATEGORIES).toEqual(["Smileys & Emotion", "People & Body", "Animals & Nature", "Food & Drink", "Travel & Places", "Activities", "Objects", "Symbols", "Flags"]);
  expect(EMOJIS).toHaveLength(3944);
  expect(new Set(EMOJIS.map(e => e.value)).size).toBe(3944);
  for (const value of ["😀", "🥰", "😭", "🫥", "👋", "🧑‍🦱", "🦴", "🦻", "🐱", "🐻", "🌸", "🌵", "🍏", "🍕", "🍺", "🥢", "🌍", "🚗", "✈️", "🏖️", "⚽", "🎮", "🎨", "🎸", "💻", "📱", "📚", "🔑", "❤️", "🔣", "⚠️", "➕", "🏁", "🏳️‍🌈", "🇺🇸", "🇵🇭", "👋🏿", "👨‍👩‍👧‍👦"]) {
    expect(EMOJIS.some(e => e.value === value), value).toBe(true);
  }
});

it("searches names, categories, flags, multiword names and actual emoji", () => {
  expect(searchEmojis("Philippines").map(e => e.value)).toContain("🇵🇭");
  expect(searchEmojis("usa").map(e => e.value)).toContain("🇺🇸");
  expect(searchEmojis("red heart").map(e => e.value)).toContain("❤️");
  expect(searchEmojis("👋").map(e => e.value)).toContain("👋🏿");
  expect(searchEmojis("", "Flags")).toHaveLength(270);
  expect(searchEmojis("pizza", "Flags")).toEqual([]);
  expect(searchEmojis("not-an-emoji-name")).toEqual([]);
});
