// Verify Tauri's Minisign envelope using Node's Ed25519 implementation.
// The shipped app independently verifies downloaded artifacts through Tauri.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function verifyUpdateArtifact(bytes, signature, publicKey) {
  const keyLines = Buffer.from(publicKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const key = Buffer.from(keyLines[1] ?? '', 'base64');
  const lines = Buffer.from(signature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const signed = Buffer.from(lines[1] ?? '', 'base64');
  const globalSignature = Buffer.from(lines[3] ?? '', 'base64');
  if (key.length !== 42 || signed.length !== 74 || globalSignature.length !== 64 || !lines[2]?.startsWith('trusted comment: ')) throw new Error('Invalid Minisign key or signature envelope.');
  if (!key.subarray(2, 10).equals(signed.subarray(2, 10))) throw new Error('Installer was signed with a different updater key.');
  const algorithm = signed.subarray(0, 2).toString('ascii');
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error('Unsupported signature algorithm.');
  const verifier = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  const payloadSignature = signed.subarray(10);
  if (!verify(null, message, verifier, payloadSignature)) throw new Error('Installer signature verification failed.');
  const trusted = Buffer.from(lines[2].slice('trusted comment: '.length), 'utf8');
  if (!verify(null, Buffer.concat([payloadSignature, trusted]), verifier, globalSignature)) throw new Error('Signature comment verification failed.');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [artifact, signatureFile] = process.argv.slice(2);
  if (!artifact || !signatureFile) throw new Error('Pass the installer path and its .sig file.');
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  verifyUpdateArtifact(readFileSync(artifact), readFileSync(signatureFile, 'utf8'), config.plugins.updater.pubkey);
  console.log('Installer signature verified against the app public key.');
}
