// Run only on a disposable Windows Actions runner: installs the baseline and candidate.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable Actions runner, never a personal installation.');
const [baseline, candidate] = process.argv.slice(2).map(path => resolve(path));
assert.ok(baseline && candidate, 'Pass baseline and candidate installers.');
const installDir = join(process.env.RUNNER_TEMP, 'Suivelle installer smoke');
const exe = join(installDir, 'Suivelle.exe');
const data = join(process.env.APPDATA, 'app.suivelle.desktop', 'data');
assert.ok(!existsSync(join(data, 'workspace.db')), 'Runner must have no existing Suivelle data.');
let app;
const log = join(data, 'logs', 'suivelle.log');
const fixture = join(process.env.RUNNER_TEMP, 'suivelle-installer-fixture.json');

async function until(check, label) {
  const end = Date.now() + 60_000;
  let lastError;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
    await delay(500);
  }
  throw new Error(`Timed out: ${label}; ${lastError?.message ?? 'no matching result'}`);
}

function install(installer) {
  console.log(`Installing ${installer}`);
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '$p = Start-Process -FilePath $env:SUI_SMOKE_INSTALLER -ArgumentList "/S /D=$env:SUI_SMOKE_DIR" -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode'],
  { env: { ...process.env, SUI_SMOKE_INSTALLER: installer, SUI_SMOKE_DIR: installDir }, windowsHide: true, timeout: 180_000, stdio: 'inherit' });
  assert.ok(existsSync(exe), 'Installer must honor the custom directory.');
}

function installedVersion() {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Item -LiteralPath $env:SUI_SMOKE_EXE).VersionInfo.ProductVersion'],
    { env: { ...process.env, SUI_SMOKE_EXE: exe }, windowsHide: true, encoding: 'utf8' }).trim().match(/^\d+\.\d+\.\d+/)?.[0];
}

async function launch() {
  if (existsSync(log)) unlinkSync(log);
  app = spawn(exe, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', bytes => console.log(bytes.toString()));
  app.stderr.on('data', bytes => console.log(bytes.toString()));
  await until(() => {
    assert.equal(app.exitCode, null, 'App exited during startup.');
    return readFileSync(log, 'utf8').includes('workspace database ready');
  }, 'installed app startup');
  assert.ok(!readFileSync(log, 'utf8').includes('opening the workspace read-only'), 'Workspace must open writable.');
  // FindWindow also sees hidden windows; the CI launcher deliberately hides helpers.
  const window = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type \'using System; using System.Runtime.InteropServices; public class SmokeWindow { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title); }\'; [SmokeWindow]::FindWindow($null, "Suivelle").ToInt64()'],
  { windowsHide: true, encoding: 'utf8' }).trim();
  assert.notEqual(window, '0', 'Installed app must create its native window.');
}

function stop() {
  if (app?.pid && app.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  app = null;
}

try {
  install(baseline);
  assert.equal(installedVersion(), '0.1.4');
  await launch();
  stop();
  await delay(1000);
  execFileSync('python', ['scripts/installer-fixture.py', 'seed', data, fixture], { windowsHide: true, stdio: 'inherit' });
  // Simulate the stable connector left by a previous agent connection. Startup only
  // refreshes existing copies; an app with no connected agents needs no stable copy.
  const connectorDir = join(process.env.LOCALAPPDATA, 'Suivelle', 'bin');
  mkdirSync(connectorDir, { recursive: true });
  writeFileSync(join(connectorDir, 'suivelle-mcp.exe'), 'outdated connector fixture');
  install(candidate);
  assert.equal(installedVersion(), JSON.parse(readFileSync('release-notes.json', 'utf8')).version);
  await launch();
  const shipped = readFileSync(join(installDir, 'suivelle-mcp.exe'));
  await until(() => readFileSync(join(connectorDir, 'suivelle-mcp.exe')).equals(shipped), 'refreshed stable agent connector');
  stop();
  await delay(1000);
  execFileSync('python', ['scripts/installer-fixture.py', 'verify', data, fixture], { windowsHide: true, stdio: 'inherit' });
  await launch();
  stop();
  await delay(1000);
  execFileSync('python', ['scripts/installer-fixture.py', 'verify', data, fixture], { windowsHide: true, stdio: 'inherit' });
  console.log('Installer smoke passed: custom directory, native window, writable migration, workspaces/pages/blocks/attachment preservation, safety snapshot, connector refresh, and repeated launch.');
} catch (error) {
  if (existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-12_000));
  console.log(`App exit code: ${app?.exitCode}; database created: ${existsSync(join(data, 'workspace.db'))}`);
  throw error;
} finally {
  stop();
}
