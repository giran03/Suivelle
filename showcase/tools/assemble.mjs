// Turns the recorded screencast frames into a constant 60fps H.264 MP4, applying the virtual camera moves.
// usage: node assemble.mjs <frames-dir> <out.mp4> [--no-camera]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [, , frames, out, ...flags] = process.argv;
const { stamps, camera = [] } = JSON.parse(fs.readFileSync(path.join(frames, "stamps.json"), "utf8"));
const t0 = stamps[0];

const lines = ["ffconcat version 1.0"];
for (let i = 0; i < stamps.length; i++) {
  const dur = i + 1 < stamps.length ? stamps[i + 1] - stamps[i] : 0.04;
  lines.push(`file 'f${String(i).padStart(6, "0")}.jpg'`, `duration ${Math.max(0.001, dur).toFixed(6)}`);
}
lines.push(`file 'f${String(stamps.length - 1).padStart(6, "0")}.jpg'`);
const list = path.join(frames, "list.txt");
fs.writeFileSync(list, lines.join("\n"));

// ---- camera: additive smoothstep segments, so z, x and y are each one closed expression of time
const f = (n) => n.toFixed(5);
function track(get, init) {
  let prev = init;
  const terms = [];
  for (const k of camera) {
    const d = get(k) - prev;
    prev = get(k);
    if (Math.abs(d) < 1e-6) continue;
    const P = `clip((t-${f(k.t - t0)})/${f(k.dur)},0,1)`;
    terms.push(`(${f(d)})*(${P}*${P}*(3-2*${P}))`);
  }
  return terms.length ? `(${f(init)}+${terms.join("+")})` : f(init);
}
// the same curves, evaluated in JS so crop offsets can be driven per frame through sendcmd
const smooth = (p) => { p = Math.min(1, Math.max(0, p)); return p * p * (3 - 2 * p); };
function value(get, init, t) {
  let prev = init, v = init;
  for (const k of camera) { v += (get(k) - prev) * smooth((t - (k.t - t0)) / k.dur); prev = get(k); }
  return v;
}
const duration = stamps.at(-1) - t0;
let vf = "fps=60";
if (camera.length && !flags.includes("--no-camera")) {
  const Z = `max(1.0001,${track((k) => k.z, 1)})`;
  const cmds = [];
  for (let n = 0; n / 60 < duration + 0.5; n++) {
    const t = n / 60;
    const z = Math.max(1.0001, value((k) => k.z, 1, t));
    const iw = 2 * Math.trunc((1920 * z) / 2), ih = 2 * Math.trunc((1080 * z) / 2);
    const x = Math.min(iw - 1920, Math.max(0, value((k) => k.x, 0.5, t) * iw - 960));
    const y = Math.min(ih - 1080, Math.max(0, value((k) => k.y, 0.5, t) * ih - 540));
    cmds.push(`${t.toFixed(5)} crop x ${Math.round(x)}, crop y ${Math.round(y)};`);
  }
  fs.writeFileSync(path.join(frames, "cam.cmd"), cmds.join(String.fromCharCode(10)));
  vf += `,sendcmd=f='cam.cmd'`;
  vf += `,format=yuv444p,scale=w='2*trunc(1920*${Z}/2)':h='2*trunc(1080*${Z}/2)':eval=frame:flags=bicubic`;
  vf += `,crop=1920:1080:x=0:y=0`;
} else {
  vf += ",scale=1920:1080:flags=lanczos";
}
vf += ",format=yuv420p";
const script = path.join(frames, "filter.txt");
fs.writeFileSync(script, vf);

const args = [
  "-y", "-hide_banner", "-loglevel", "warning",
  "-f", "concat", "-safe", "0", "-i", "list.txt",
  "-filter_script:v", "filter.txt",
  "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-profile:v", "high", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  path.resolve(out),
];
const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"], cwd: frames });
process.exit(r.status ?? 1);
