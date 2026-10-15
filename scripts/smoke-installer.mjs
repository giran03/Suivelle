// Run only on a disposable Windows Actions runner: installs the baseline and candidate.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
let socket;
let requestId = 0;
const pending = new Map();

async function until(check, label) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch {}
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}

function install(installer) {
  console.log(`Installing ${installer}`);
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '$p = Start-Process -FilePath $env:SUI_SMOKE_INSTALLER -ArgumentList "/S /D=$env:SUI_SMOKE_DIR" -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode'],
  { env: { ...process.env, SUI_SMOKE_INSTALLER: installer, SUI_SMOKE_DIR: installDir }, windowsHide: true, timeout: 180_000, stdio: 'inherit' });
  assert.ok(existsSync(exe), 'Installer must honor the custom directory.');
}

function cdp(method, params) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

const invoke = (cmd, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

async function launch() {
  app = spawn(exe, [], { windowsHide: true, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' }, stdio: 'ignore' });
  const target = await until(async () => {
    assert.equal(app.exitCode, null, 'App exited during startup.');
    const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
    return targets.find(t => t.type === 'page' && /tauri\.localhost|^tauri:/.test(t.url));
  }, 'installed WebView');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  await until(() => evaluate('!!document.querySelector(".sidebar") && !!window.__TAURI_INTERNALS__'), 'rendered app sidebar');
  assert.equal(await invoke('app_safe_mode'), null, 'Workspace must open writable.');
}

function stop() {
  socket?.close();
  socket = null;
  if (app?.pid && app.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  app = null;
}

try {
  install(baseline);
  await launch();
  assert.equal(await invoke('plugin:app|version'), '0.1.4');
  const workspace = await invoke('workspace_create', { input: { name: 'Installer preservation check', icon: null } });
  const page = await invoke('page_create', { input: { workspaceId: workspace.id, parentPageId: null, title: 'Keep this page through the update' } });
  const content = JSON.stringify({ text: 'Saved before the 0.1.5 installation.' });
  const block = await invoke('block_create', { input: { pageId: page.id, type: 'paragraph', dataJson: content } });
  stop();
  await delay(1000);
  // Simulate the stable connector left by a previous agent connection. Startup only
  // refreshes existing copies; an app with no connected agents needs no stable copy.
  const connectorDir = join(process.env.LOCALAPPDATA, 'Suivelle', 'bin');
  mkdirSync(connectorDir, { recursive: true });
  writeFileSync(join(connectorDir, 'suivelle-mcp.exe'), 'outdated connector fixture');
  install(candidate);
  await launch();
  assert.equal(await invoke('plugin:app|version'), JSON.parse(readFileSync('release-notes.json', 'utf8')).version);
  assert.equal((await invoke('page_get', { id: page.id })).title, page.title);
  assert.ok((await invoke('workspace_list')).some(w => w.id === workspace.id && w.name === workspace.name));
  assert.equal((await invoke('block_list', { pageId: page.id })).find(b => b.id === block.id)?.dataJson, content);
  const shipped = readFileSync(join(installDir, 'suivelle-mcp.exe'));
  assert.deepEqual(readFileSync(join(process.env.LOCALAPPDATA, 'Suivelle', 'bin', 'suivelle-mcp.exe')), shipped, 'Startup must refresh the stable agent connector.');
  stop();
  await delay(1000);
  await launch();
  assert.equal((await invoke('page_get', { id: page.id })).title, page.title, 'Data must survive a second launch.');
  console.log('Installer smoke passed: custom directory, rendered app, writable migration, workspace/page/block preservation, connector refresh, and repeated launch.');
} finally {
  stop();
}
