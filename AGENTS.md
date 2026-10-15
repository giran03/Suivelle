# Repository instructions

## Release notes

- The current development version is **0.1.5**.
- Route new changes to `release-notes.json` and `docs/changelog/0.1.5.md`.
  Keep their notes consistent and write entries for readers of the app.
- Version 0.1.4 is published. Preserve its archived changelog and release tag;
  subsequent features and fixes belong to the next release.
- Keep the app version aligned in `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json`, and `release-notes.json`, and refresh both lockfiles
  when bumping versions. Follow `docs/releasing.md` when preparing a release.

## Frontend work

- For any UI change (styling, layout, components, settings screens, empty states,
  motion, colour, typography), use the **impeccable** skill before writing code,
  and run its critique or polish pass before calling the change done.
- Keep to the existing tokens and patterns in `src/styles.css` and the feature's
  own CSS; do not add a UI library.

## graphify

When the user types `/graphify`, use the installed graphify skill or its
instructions before doing anything else.
