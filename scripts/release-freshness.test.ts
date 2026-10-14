import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error The launcher is a standalone Node script.
import { releaseIsFresh } from "./release-freshness.mjs";

const root = mkdtempSync(join(tmpdir(), "suivelle-launcher-"));
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("rebuilds an absent executable, changed sources and removed assets", () => {
  expect(releaseIsFresh(root)).toBe(false);
  for (const directory of ["src", "public", "src-tauri/src", "src-tauri/migrations", "src-tauri/capabilities", "src-tauri/icons", "src-tauri/installer", "src-tauri/target/release"]) mkdirSync(join(root, directory), { recursive: true });
  for (const file of ["index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "release-notes.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "src-tauri/build.rs"]) writeFileSync(join(root, file), "fixture");
  const executable = join(root, "src-tauri/target/release/Suivelle.exe");
  writeFileSync(executable, "fixture");
  const built = new Date(Date.now() + 1000);
  utimesSync(executable, built, built);
  expect(releaseIsFresh(root)).toBe(true);
  writeFileSync(join(root, "src/main.tsx"), "new code");
  const changed = new Date(built.getTime() + 1000);
  utimesSync(join(root, "src/main.tsx"), changed, changed);
  expect(releaseIsFresh(root)).toBe(false);
  rmSync(join(root, "src/main.tsx"));
  utimesSync(join(root, "src"), changed, changed);
  expect(releaseIsFresh(root)).toBe(false);
});
