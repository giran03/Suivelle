// Run explicitly with node --test; keep this outside Vitest's filename convention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { verifyUpdateArtifact } from './verify-update-artifact.mjs';
import { canonicalNotes } from './finalize-update-manifest.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const notes = JSON.parse(readFileSync(new URL('../release-notes.json', import.meta.url), 'utf8'));
const run = (script, args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_REF_TYPE: 'branch' },
});

test('canonical updater notes restore transport whitespace but reject changed content', () => {
  const expected = '## Changes\n\n- Saved pages.\n';
  assert.equal(canonicalNotes({ notes: expected.trimEnd() }, expected).notes, expected);
  assert.equal(canonicalNotes({ notes: expected.replaceAll('\n', '\r\n') }, expected).notes, expected);
  assert.throws(() => canonicalNotes({ notes: 'Different content' }, expected));
  assert.throws(() => canonicalNotes({}, expected));
});

test('artifact verification accepts Minisign signatures and rejects tampering and foreign keys', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const rawKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const key = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from('Ed'), id, rawKey]).toString('base64')}\n`).toString('base64');
  const bytes = Buffer.from('Synthetic installer bytes for signature testing');
  for (const algorithm of ['Ed', 'ED']) {
    const payload = sign(null, algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes, privateKey);
    const trusted = 'timestamp:0\tfile:test';
    const global = sign(null, Buffer.concat([payload, Buffer.from(trusted)]), privateKey);
    const text = `untrusted comment: fixture\n${Buffer.concat([Buffer.from(algorithm), id, payload]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`;
    const signature = Buffer.from(text).toString('base64');
    assert.doesNotThrow(() => verifyUpdateArtifact(bytes, signature, key));
    assert.throws(() => verifyUpdateArtifact(Buffer.from('Tampered installer'), signature, key));
    assert.throws(() => verifyUpdateArtifact(bytes, Buffer.from(text.replace('timestamp:0', 'timestamp:1')).toString('base64'), key));
    const foreign = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from('Ed'), randomBytes(8), rawKey]).toString('base64')}\n`).toString('base64');
    assert.throws(() => verifyUpdateArtifact(bytes, signature, foreign));
  }
});

test('release contract requires the matching stable tag', () => {
  assert.equal(run('check-release.mjs', [`v${notes.version}`]).status, 0);
  assert.notEqual(run('check-release.mjs', [`v${notes.version}-beta.1`]).status, 0);
  assert.notEqual(run('check-release.mjs', ['v99.0.0']).status, 0);
});
test('release manifest rejects missing signatures, foreign assets, mismatched notes, and MSI files', () => {
  const folder = mkdtempSync(join(tmpdir(), 'suivelle-release-check-'));
  const file = join(folder, 'latest.json');
  const platform = { signature: 'Synthetic test signature; this test checks metadata only', url: `https://github.com/giran03/Suivelle/releases/download/v${notes.version}/Suivelle_${notes.version}_x64-setup.exe` };
  const valid = { version: notes.version, notes: notes.notes, platforms: { 'windows-x86_64': platform } };
  const check = (manifest) => { writeFileSync(file, JSON.stringify(manifest)); return run('validate-update-manifest.mjs', [file]).status; };
  try {
    assert.equal(check(valid), 0);
    assert.notEqual(check({ ...valid, notes: 'Different notes' }), 0);
    assert.notEqual(check({ ...valid, version: '99.0.0' }), 0);
    assert.notEqual(check({ ...valid, platforms: { 'windows-x86_64': { ...platform, signature: '' } } }), 0);
    assert.notEqual(check({ ...valid, platforms: { 'windows-x86_64': { ...platform, url: platform.url.replace('/giran03/Suivelle/', '/other/app/') } } }), 0);
    assert.notEqual(check({ ...valid, platforms: { 'windows-x86_64': { ...platform, url: platform.url.replace('-setup.exe', '.msi') } } }), 0);
  } finally { unlinkSync(file); rmdirSync(folder); }
});
