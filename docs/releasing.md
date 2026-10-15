# Publishing Suivelle updates

The app checks the public stable release feed at `https://github.com/giran03/Suivelle/releases/latest/download/latest.json`. The release workflow builds signed Windows x64 NSIS installers into a draft release. Publish the draft only after installer testing. No token is embedded in the app.

## One-time signing setup

A private updater key was generated locally at `%USERPROFILE%\.codex\keys\suivelle-updater.key`; its public key is embedded in `src-tauri/tauri.conf.json`. Keep a secure backup of the private key. Never commit it or paste it into a chat. This is independent of Windows Authenticode and MSIX certificate signing.

Add the **contents** of that private-key file to the repository's GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`. The generated key has an empty password; leave `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` empty. An authenticated GitHub CLI can upload the file directly:

```powershell
Get-Content -Raw -LiteralPath (Join-Path $env:USERPROFILE '.codex\keys\suivelle-updater.key') | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo giran03/Suivelle
```

The file is outside the repository. The `.gitignore` also excludes private signing-key extensions. Losing this key prevents updates to installations trusting its public key; replacing the public key requires a planned migration.

## Prepare each release

`release-notes.json` is the changelog for the next release. Add upcoming changes to its `notes` field and replace the Unreleased placeholder before publishing. Published notes are preserved in `docs/changelog/`; after a release, archive its notes and bump the app versions and `release-notes.json` together to the next development version.

1. Update `package.json`, the package version in `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `release-notes.json` to the same stable semantic version. Refresh lockfiles with the package managers.
2. Write the release date and actual notes in `release-notes.json`. These exact notes are bundled for offline changelog access and published in GitHub/the updater feed. Headings and bullet lines are supported; raw HTML is displayed as text.
3. Run `node scripts/check-release.mjs`, `npm test`, `npm run build`, and `cargo test --manifest-path src-tauri/Cargo.toml --lib`.
4. Push a matching `vX.Y.Z` tag, or dispatch the release workflow on the intended commit. It creates a draft with the NSIS installer, `.sig`, and `latest.json`, then validates the manifest, uploaded assets, and installer signature against the embedded public key. Do not manually publish a failed workflow's draft.
5. The workflow smoke-tests the draft's signed installer on its disposable Windows runner: install and launch the v0.1.4 baseline in a custom directory, save fixtures for two workspaces with pages, blocks and an attachment, install the candidate, check its native window and writable startup, verify every saved row and attachment plus the pre-migration safety snapshot and refreshed agent connector, and relaunch. It uses saved database fixtures because production builds do not expose remote DevTools. Publish only after the workflow succeeds, as a stable release marked latest. Keep previous release assets available. Public clients cannot fetch draft assets; the complete in-app A → B acceptance check requires an updater-enabled baseline and a newer published release. The existing `0.1.0` needs a manual bootstrap installation of `0.1.1`.

The workflow restores trailing whitespace removed from updater notes in transit, then validates their exact match to the bundled notes; different note content is rejected. For a draft that built successfully but failed verification, dispatch with `verify_existing_draft` enabled to rerun signature and installation checks without rebuilding. This refuses to reuse assets if application source differs from the release tag. Never use it to skip an application change or publish a failed verification run.

The release configuration builds the `suivelle-mcp` connector first (`node scripts/build-mcp-bridge.mjs`, into the ignored `src-tauri/binaries/`) and ships it next to Suivelle through `externalBin`; `scripts/build-installer.ps1` does the same for local NSIS and MSIX packages. Connected agent apps run a copy in `%LOCALAPPDATA%\Suivelle\bin`, which installed builds refresh at startup, so check after an update that an app connected before it still reaches Suivelle.

For a local signed build:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $env:USERPROFILE '.codex\keys\suivelle-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
npm run tauri -- build --config src-tauri/tauri.release.conf.json --bundles nsis
```

Ordinary development/local installer builds do not require the signing key; updater artifacts are enabled by the release configuration. Unsigned local installers can receive signed updates after installation, but cannot be uploaded as updater artifacts without a matching signature.

## Installer acceptance check

Test A → B through the actual NSIS installation and feed: unsaved editor/title/dashboard/view changes; all workspaces and attachments; verified `pre-update` backup; custom install path; close-to-tray; hidden autostart; offline relaunch; correct version; a single post-update changelog; manual/offline changelog access; canceled/failed installers; and repeated launches. Bad signatures, failed saves, and failed backups must block installation. Verify older binaries refuse newer database schemas.

Update downloads are session-local. Closing the process discards the download; the next launch rechecks and downloads again. Installation only begins after explicit consent. Safety backups are labeled “Before an update” and excluded from automatic daily rotation; manage them in Backups. A canceled installer is detected from the unchanged running version at next launch.

Existing releases without the updater require one manual installation of the first updater-enabled build. MSIX, standalone executables, development builds, and the web showcase do not run the NSIS updater. MSIX automatic updates require a separate App Installer/Store setup.
