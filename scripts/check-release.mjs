import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const version = json("package.json").version;
const cargo = /^version\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))?.[1];
const config = json("src-tauri/tauri.conf.json");
const release = json("release-notes.json");
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (!stable.test(version) || [cargo, config.version, release.version].some((v) => v !== version)) {
  throw new Error("Stable versions must match in package.json, Cargo.toml, tauri.conf.json, and release-notes.json.");
}
if (!release.notes?.trim() || Buffer.byteLength(release.notes) > 65536 || !/^\d{4}-\d{2}-\d{2}$/.test(release.date) || Number.isNaN(Date.parse(release.date)) || new Date(release.date).toISOString().slice(0, 10) !== release.date) {
  throw new Error("Release notes must have a valid date and 1–65536 bytes of notes.");
}
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : process.argv[2];
if (tag && tag !== `v${version}`) throw new Error(`Release tag must be v${version}.`);
if (!config.plugins?.updater?.pubkey) throw new Error("Configure the updater public key before building a release.");
console.log(`Release contract verified: ${version}`);
