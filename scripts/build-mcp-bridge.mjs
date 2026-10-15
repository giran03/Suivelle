// Builds the suivelle-mcp connector in release mode and places it where Tauri's `externalBin`
// expects it (src-tauri/binaries/suivelle-mcp-<target triple>[.exe]), so installers ship it next
// to Suivelle. Run by the release configuration's beforeBuildCommand and by build-installer.ps1.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = resolve(root, "src-tauri/Cargo.toml");
const triple = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!triple) throw new Error("Could not read the Rust host target from `rustc -vV`.");
execFileSync("cargo", ["build", "--release", "-p", "suivelle-mcp", "--manifest-path", manifest], { stdio: "inherit" });
const ext = triple.includes("windows") ? ".exe" : "";
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : resolve(root, "src-tauri/target");
const from = resolve(targetDir, "release", `suivelle-mcp${ext}`);
const to = resolve(root, "src-tauri/binaries", `suivelle-mcp-${triple}${ext}`);
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`suivelle-mcp → ${to}`);
