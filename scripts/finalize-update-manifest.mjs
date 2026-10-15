// Tauri/GitHub may trim the release body's final newline in transit. Keep the feed's
// notes byte-for-byte equal to the offline notes without accepting content changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function canonicalNotes(manifest, notes) {
  const normalize = text => text.replace(/\r\n/g, '\n').trimEnd();
  if (typeof manifest.notes !== 'string' || normalize(manifest.notes) !== normalize(notes)) {
    throw new Error('Updater notes differ from the bundled release.');
  }
  return { ...manifest, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) throw new Error('Pass the updater manifest path.');
  const release = JSON.parse(readFileSync(new URL('../release-notes.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(canonicalNotes(manifest, release.notes), null, 2) + '\n');
}
