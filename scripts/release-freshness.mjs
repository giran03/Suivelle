import { readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function releaseIsFresh(root) {
  const executable = resolve(root, "src-tauri/target/release/Suivelle.exe");
  let built;
  try { built = statSync(executable).mtimeMs; } catch { return false; }
  const inputs = ["src", "public", "src-tauri/src", "src-tauri/migrations", "src-tauri/capabilities", "src-tauri/icons", "src-tauri/installer", "index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "release-notes.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/tauri.conf.json", "src-tauri/build.rs"];
  const older = (path) => {
    const info = statSync(path);
    if (info.mtimeMs > built) return false;
    return !info.isDirectory() || readdirSync(path).every((name) => older(resolve(path, name)));
  };
  return inputs.every((path) => older(resolve(root, path)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = releaseIsFresh(resolve(dirname(fileURLToPath(import.meta.url)), "..")) ? 0 : 1;
  } catch (error) {
    console.error("Could not check the release build:", error.message);
    process.exitCode = 2;
  }
}
